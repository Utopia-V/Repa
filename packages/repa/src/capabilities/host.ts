import { isDeepStrictEqual } from "node:util";
import { Check } from "typebox/value";
import { RepaFault } from "../errors.js";
import type { SettingsNamespaceDefinition } from "../configuration/definitions.js";
import { IdSchema } from "../schema.js";
import type { SpaceSnapshotParticipant } from "../spaces/schema.js";
import { SerialQueue } from "../storage/atomic.js";
import { managedDirectory } from "../storage/managed-directory.js";
import {
  CapabilityDescriptorSchema,
  CapabilityScopeSchema,
  CapabilitySelectionSchema,
  CapabilitySourceSchema,
  type CapabilityDescriptor,
  type CapabilityScope,
  type CapabilitySelection,
} from "./schema.js";
import type {
  BackendPlugin,
  BackendPluginRegistration,
  CapabilityDefinition,
  CapabilityResourceDeclarations,
  InvocationContext,
  PluginSpaceContext,
} from "./types.js";

interface RegisteredCapability {
  descriptor: CapabilityDescriptor;
  definition: CapabilityDefinition;
}

interface SpaceRuntime {
  context: PluginSpaceContext;
  controller: AbortController;
  opening: boolean;
  ready: Promise<unknown>;
  closing?: Promise<void>;
}

interface RegisteredPlugin {
  id: string;
  plugin: BackendPlugin;
  capabilities: RegisteredCapability[];
  spaces: Map<string, SpaceRuntime>;
  status: "active" | "removing";
}

interface ResolvedCapability {
  plugin: RegisteredPlugin;
  capability: RegisteredCapability;
}

interface ActiveInvocation {
  pluginId: string;
  scope: CapabilityScope;
  controller: AbortController;
  done: Promise<unknown>;
}

const contractKey = (value: CapabilitySelection["contract"]) => JSON.stringify([value.id, value.version]);
const sameScope = (left: CapabilityScope, right: CapabilityScope) =>
  left.kind === right.kind && (left.kind === "application" || (right.kind === "space" && left.spaceId === right.spaceId));

function serializable(value: unknown, code: string): unknown {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error("没有可序列化的值");
    const copied: unknown = JSON.parse(text);
    if (!isDeepStrictEqual(value, copied)) throw new Error("存在非 JSON 值");
    return copied;
  } catch {
    throw new RepaFault(code, "能力契约与调用数据必须能够完整序列化。");
  }
}

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new RepaFault("cancelled", "能力调用已取消。");
}

/** 仅持有已启用定义与运行资源，不发现包、保存请求或解释插件业务数据。 */
export class CapabilityHost {
  readonly #plugins = new Map<string, RegisteredPlugin>();
  readonly #management = new SerialQueue();
  readonly #active = new Set<ActiveInvocation>();
  readonly #spaceClosings = new Map<string, Promise<void>>();
  #closed = false;
  #closing: Promise<void> | undefined;

  register(registration: BackendPluginRegistration): Promise<void> {
    if (!Check(IdSchema, registration.id) || typeof registration.enabled !== "boolean" || typeof registration.factory !== "function")
      return Promise.reject(new RepaFault("invalid_plugin", "插件身份、启用状态或工厂无效。"));
    if (!registration.enabled) return this.remove(registration.id);
    return this.#management.run(async () => {
      this.#assertOpen();
      if (this.#plugins.has(registration.id)) throw new RepaFault("plugin_registered", "插件已登记，请先移除旧实例。", { pluginId: registration.id });
      const plugin = await registration.factory();
      this.#assertOpen();
      if (!plugin || !Array.isArray(plugin.capabilities) ||
          (plugin.settings !== undefined && !Array.isArray(plugin.settings)) ||
          (plugin.openSpace !== undefined && typeof plugin.openSpace !== "function") ||
          (plugin.closeSpace !== undefined && (typeof plugin.closeSpace !== "function" || !plugin.openSpace)))
        throw new RepaFault("invalid_plugin", "插件定义或空间生命周期无效。", { pluginId: registration.id });
      if (plugin.snapshot && (plugin.snapshot.id !== registration.id || !plugin.snapshot.version ||
          plugin.snapshot.directory !== `.repa/plugins/${registration.id}` || typeof plugin.snapshot.capture !== "function"))
        throw new RepaFault("invalid_plugin", "插件快照必须由同一身份持有其专属数据目录。", { pluginId: registration.id });
      const capabilities = plugin.capabilities.map((definition) => this.#definition(registration.id, definition));
      const existing = [...this.#plugins.values()].flatMap((entry) => entry.capabilities);
      for (const capability of capabilities) {
        const key = contractKey(capability.descriptor.contract);
        for (const other of existing) {
          if (contractKey(other.descriptor.contract) !== key) continue;
          if (other.descriptor.implementationId === capability.descriptor.implementationId)
            throw new RepaFault("capability_conflict", "同一能力实现不能重复登记。", { contract: capability.descriptor.contract, implementationId: capability.descriptor.implementationId });
          if (!isDeepStrictEqual(other.descriptor.inputSchema, capability.descriptor.inputSchema) ||
              !isDeepStrictEqual(other.descriptor.outputSchema, capability.descriptor.outputSchema))
            throw new RepaFault("capability_contract_conflict", "同版本能力契约的输入或输出 schema 不一致。", { contract: capability.descriptor.contract });
        }
        existing.push(capability);
      }
      this.#plugins.set(registration.id, { id: registration.id, plugin, capabilities, spaces: new Map(), status: "active" });
    });
  }

  #definition(pluginId: string, definition: CapabilityDefinition): RegisteredCapability {
    if (!definition || typeof definition.invoke !== "function" ||
        (definition.inputResources !== undefined && typeof definition.inputResources !== "function") ||
        (definition.outputResources !== undefined && typeof definition.outputResources !== "function") ||
        (definition.tool?.input !== undefined && (!definition.tool.input || typeof definition.tool.input.prepare !== "function")))
      throw new RepaFault("invalid_capability", "能力调用实现、工具适配或资源声明无效。");
    const descriptor = serializable({
      pluginId,
      contract: definition.contract,
      implementationId: definition.implementationId,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      scopes: definition.scopes,
      execution: definition.execution,
      ...(definition.tool ? { tool: {
        name: definition.tool.name,
        description: definition.tool.description,
        ...(definition.tool.input ? { inputSchema: definition.tool.input.schema } : {}),
      } } : {}),
    }, "invalid_capability");
    if (!Check(CapabilityDescriptorSchema, descriptor)) throw new RepaFault("invalid_capability", "能力定义不符合契约。", { pluginId });
    return { descriptor, definition };
  }

  list(): CapabilityDescriptor[] {
    const values = [...this.#plugins.values()].filter((entry) => entry.status === "active")
      .flatMap((entry) => entry.capabilities.map((capability) => capability.descriptor));
    return structuredClone(values.sort((a, b) => contractKey(a.contract).localeCompare(contractKey(b.contract)) || a.implementationId.localeCompare(b.implementationId)));
  }

  resolve(selection: CapabilitySelection, scope: CapabilityScope): CapabilityDescriptor {
    return structuredClone(this.#resolve(selection, scope).capability.descriptor);
  }

  /** 模型参数先适配为公共输入；权限、资源保留与执行仍由原调用链承担。 */
  prepareToolInput(selection: CapabilitySelection, input: unknown, scope: CapabilityScope): unknown {
    const { definition, descriptor } = this.#resolve(selection, scope).capability;
    const adapter = definition.tool?.input;
    if (!adapter) return input;
    if (!descriptor.tool?.inputSchema || !Check(descriptor.tool.inputSchema, input))
      throw new RepaFault("invalid_capability_input", "输入不符合所选能力工具的 schema。", { contract: descriptor.contract });
    return adapter.prepare(input, scope);
  }

  /** 受理时固定声明；完成后即使插件已关闭，也不重新选择实现或打开资源。 */
  resourceDeclarations(selection: CapabilitySelection, scope: CapabilityScope): CapabilityResourceDeclarations {
    const { definition, descriptor } = this.#resolve(selection, scope).capability;
    return {
      inputResources: input => {
        if (!definition.inputResources) return [];
        if (!Check(descriptor.inputSchema, input))
          throw new RepaFault("invalid_capability_input", "输入不符合所选能力的 schema。", { contract: descriptor.contract });
        return definition.inputResources(input, scope);
      },
      outputResources: definition.outputResources?.bind(definition) ?? (() => []),
    };
  }

  #resolve(selection: CapabilitySelection, scope: CapabilityScope): ResolvedCapability {
    this.#assertOpen();
    if (!Check(CapabilitySelectionSchema, selection) || !Check(CapabilityScopeSchema, scope))
      throw new RepaFault("invalid_input", "能力选择或作用域无效。");
    const matches = [...this.#plugins.values()].filter((plugin) => plugin.status === "active")
      .flatMap((plugin) => plugin.capabilities.map((capability) => ({ plugin, capability })))
      .filter(({ capability }) => contractKey(capability.descriptor.contract) === contractKey(selection.contract) &&
        (selection.implementationId === undefined || capability.descriptor.implementationId === selection.implementationId));
    if (!matches.length) throw new RepaFault("capability_not_found", "所选能力或实现尚未启用。", { selection });
    const supported = matches.filter(({ capability }) => capability.descriptor.scopes.includes(scope.kind));
    if (!supported.length) throw new RepaFault("capability_scope", "所选能力不支持当前作用域。", { selection, scope });
    if (supported.length > 1) throw new RepaFault("capability_selection_required", "该能力有多个实现，请明确选择。", {
      contract: selection.contract, implementations: supported.map(({ capability }) => capability.descriptor.implementationId),
    });
    const selected = supported[0];
    if (!selected) throw new RepaFault("capability_not_found", "所选能力尚未启用。");
    return selected;
  }

  invoke<Services extends object>(selection: CapabilitySelection, input: unknown, context: Omit<InvocationContext<Services>, "spaceRuntime">): Promise<unknown> {
    let selected: ResolvedCapability;
    try {
      selected = this.#resolve(selection, context.scope);
      this.#checkContext(context);
      cancelled(context.signal);
      if (!Check(selected.capability.descriptor.inputSchema, input))
        throw new RepaFault("invalid_capability_input", "输入不符合所选能力的 schema。", { contract: selection.contract });
    } catch (error) {
      return Promise.reject(error);
    }
    const { plugin, capability } = selected;
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    const scope = structuredClone(context.scope);
    const source = structuredClone(context.source);
    const { content, services } = context;
    const active: ActiveInvocation = { pluginId: plugin.id, scope, controller, done: Promise.resolve() };
    const done = Promise.resolve().then(async () => {
      cancelled(signal);
      const runtime = scope.kind === "space" && plugin.plugin.openSpace
        ? await this.#spaceRuntime(plugin, scope.spaceId, content).ready : undefined;
      cancelled(signal);
      const invocation: InvocationContext = {
        scope, source, signal,
        ...(content ? { content } : {}),
        ...(services ? { services } : {}),
        ...(plugin.plugin.openSpace && scope.kind === "space" ? { spaceRuntime: runtime } : {}),
      };
      const result = await capability.definition.invoke(input, invocation);
      if (!Check(capability.descriptor.outputSchema, result))
        throw new RepaFault("invalid_capability_output", "结果不符合所选能力的 schema。", { contract: capability.descriptor.contract });
      // 插件已完成的结果不因同时到达的取消被改报为未完成；保存责任留在处理函数。
      return result;
    });
    active.done = done;
    this.#active.add(active);
    return done.finally(() => { this.#active.delete(active); });
  }

  #checkContext(context: Omit<InvocationContext, "spaceRuntime">): void {
    if (!Check(CapabilitySourceSchema, context.source)) throw new RepaFault("invalid_input", "能力调用来源无效。");
    if (context.scope.kind === "application") {
      if (context.content) throw new RepaFault("capability_scope", "应用作用域不能携带空间内容入口。");
    } else {
      if (this.#spaceClosings.has(context.scope.spaceId)) throw new RepaFault("space_closing", "空间能力正在关闭。");
      if (context.content?.options.spaceId !== context.scope.spaceId ||
          (context.source.kind === "agent" && context.source.spaceId !== context.scope.spaceId))
        throw new RepaFault("capability_scope", "内容或 Agent 来源不属于本次调用的空间。");
    }
  }

  #spaceRuntime(plugin: RegisteredPlugin, spaceId: string, content: InvocationContext["content"]): SpaceRuntime {
    const existing = plugin.spaces.get(spaceId);
    if (existing) {
      if (existing.controller.signal.aborted) throw new RepaFault("space_closing", "插件空间资源尚未正常关闭。");
      return existing;
    }
    if (!content || !plugin.plugin.openSpace) throw new RepaFault("capability_scope", "能力缺少所属空间的内容入口。");
    const controller = new AbortController();
    // 复用管理目录的现有路径保证；仅首次打开执行这组小规模目录操作。
    const dataDirectory = managedDirectory(content.options.root, "plugins", plugin.id);
    const context: PluginSpaceContext = { spaceId, root: content.options.root, dataDirectory, signal: controller.signal };
    const runtime: SpaceRuntime = { context, controller, opening: true, ready: Promise.resolve().then(() => plugin.plugin.openSpace?.(context)) };
    runtime.ready = runtime.ready.then(value => {
      runtime.opening = false;
      return value;
    });
    runtime.ready = runtime.ready.catch((error: unknown) => {
      if (plugin.spaces.get(spaceId) === runtime) plugin.spaces.delete(spaceId);
      throw error;
    });
    plugin.spaces.set(spaceId, runtime);
    return runtime;
  }

  cancel(scope?: CapabilityScope): void {
    for (const invocation of this.#active) if (!scope || sameScope(scope, invocation.scope)) invocation.controller.abort();
    // 宿主级取消先解除初始化等待；单次调用取消不终止其他调用共用的打开过程。
    for (const plugin of this.#plugins.values()) for (const [spaceId, runtime] of plugin.spaces)
      if (runtime.opening && (!scope || (scope.kind === "space" && scope.spaceId === spaceId))) runtime.controller.abort();
  }

  async settled(scope?: CapabilityScope): Promise<void> {
    await this.#management.settled();
    await this.#waitCalls((invocation) => !scope || sameScope(scope, invocation.scope));
  }

  async #waitCalls(predicate: (invocation: ActiveInvocation) => boolean): Promise<void> {
    await Promise.allSettled([...this.#active].filter(predicate).map((invocation) => invocation.done));
  }

  #closeRuntime(plugin: RegisteredPlugin, spaceId: string, runtime: SpaceRuntime): Promise<void> {
    if (runtime.closing) return runtime.closing;
    runtime.controller.abort();
    runtime.closing = (async () => {
      let value: unknown;
      try { value = await runtime.ready; } catch { plugin.spaces.delete(spaceId); return; }
      await plugin.plugin.closeSpace?.(value, runtime.context);
      plugin.spaces.delete(spaceId);
    })();
    return runtime.closing.catch((error: unknown) => {
      runtime.closing = undefined;
      throw error;
    });
  }

  async #closeRuntimes(resources: { plugin: RegisteredPlugin; spaceId: string; runtime: SpaceRuntime }[]): Promise<void> {
    const results = await Promise.allSettled(resources.map(({ plugin, spaceId, runtime }) => this.#closeRuntime(plugin, spaceId, runtime)));
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "插件空间资源未能全部正常关闭。");
  }

  closeSpace(spaceId: string): Promise<void> {
    const previous = this.#spaceClosings.get(spaceId);
    if (previous) return previous;
    if (!Check(IdSchema, spaceId)) return Promise.reject(new RepaFault("invalid_input", "空间标识无效。"));
    const scope: CapabilityScope = { kind: "space", spaceId };
    this.cancel(scope);
    for (const plugin of this.#plugins.values()) plugin.spaces.get(spaceId)?.controller.abort();
    const closing = (async () => {
      await this.#waitCalls((invocation) => sameScope(invocation.scope, scope));
      await this.#closeRuntimes([...this.#plugins.values()].flatMap((plugin) => {
        const runtime = plugin.spaces.get(spaceId);
        return runtime ? [{ plugin, spaceId, runtime }] : [];
      }));
    })();
    this.#spaceClosings.set(spaceId, closing);
    return closing.finally(() => { this.#spaceClosings.delete(spaceId); });
  }

  snapshotParticipants(): SpaceSnapshotParticipant[] {
    return [...this.#plugins.values()].filter((entry) => entry.status === "active" && entry.plugin.snapshot)
      .map((entry) => {
        const snapshot = entry.plugin.snapshot;
        if (!snapshot) throw new RepaFault("invalid_plugin", "插件快照声明已改变。");
        return { id: snapshot.id, version: snapshot.version, directory: snapshot.directory, capture: (context) => snapshot.capture(context) };
      });
  }

  settingsDefinitions(): readonly SettingsNamespaceDefinition[] {
    return structuredClone([...this.#plugins.values()].filter((entry) => entry.status === "active")
      .flatMap((entry) => [...(entry.plugin.settings ?? [])]));
  }

  remove(pluginId: string): Promise<void> {
    return this.#management.run(async () => {
      const entry = this.#plugins.get(pluginId);
      if (!entry) return;
      entry.status = "removing";
      for (const invocation of this.#active) if (invocation.pluginId === pluginId) invocation.controller.abort();
      for (const runtime of entry.spaces.values()) runtime.controller.abort();
      await this.#waitCalls((invocation) => invocation.pluginId === pluginId);
      await this.#closeRuntimes([...entry.spaces].map(([spaceId, runtime]) => ({ plugin: entry, spaceId, runtime })));
      this.#plugins.delete(pluginId);
    });
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.cancel();
    for (const entry of this.#plugins.values()) for (const runtime of entry.spaces.values()) runtime.controller.abort();
    this.#closing = this.#management.run(async () => {
      for (const entry of this.#plugins.values()) {
        entry.status = "removing";
      }
      await this.#waitCalls(() => true);
      await this.#closeRuntimes([...this.#plugins.values()].flatMap((entry) =>
        [...entry.spaces].map(([spaceId, runtime]) => ({ plugin: entry, spaceId, runtime }))));
      this.#plugins.clear();
    });
    return this.#closing.catch((error: unknown) => {
      this.#closing = undefined;
      throw error;
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new RepaFault("closed", "能力宿主已经关闭。");
  }
}
