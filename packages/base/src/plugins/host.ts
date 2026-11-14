import { AsyncLocalStorage } from "node:async_hooks";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { AgentTool } from "../agent.js";
import { prepareItem, type AskRoute } from "../ask.js";
import { prepareExport } from "../feedback/export.js";
import {
  ASK_USER_TOOL,
  BUILTIN_TOOLS,
  RESERVED_TOOL_NAMES,
  type AgentDefinition,
  type AskOptions,
  type AskOutcome,
  type Host,
  type ModelScope,
  type Plugin,
  type PluginInstance,
  type Services,
} from "../plugin.js";
import type { PluginHost, PluginHostOptions } from "../plugins.js";
import { currentRun, withToolCall } from "../run-context.js";
import { errorText, object, parse, RepaFault } from "../schema.js";
import { createModelScope } from "./models.js";

const NO_ASK: AskRoute = () => Promise.reject(new RepaFault("ask_unavailable", "当前没有可以作答的连接"));
const NO_SERVICES: Services = {
  call: (service) => Promise.reject(new RepaFault("service_unavailable", "没有连接提供这项服务", { service })),
};

const PLUGIN_ID = /^[a-z][a-z0-9-]*$/;

// 模块加载时的空上下文。插件的 open、close 和追赶在这里执行：插件可能在 Agent 运行的工具调用里加上或撤下，
// 它此后发起的写入（包括定时器里的）不能继承那次运行的上下文，否则会记到那次运行名下，撤回运行时被一并撤回。
const detached = AsyncLocalStorage.snapshot();

/**
 * 插件工具的 ToolContext.ask：来源写明插件、会话和工具调用，Item 按词汇整理后交给路由。
 * onSubmit 在提问时的上下文里执行：它属于这次工具调用，写入记在这次运行名下；
 * 带命令行的运行持有空间写锁等待回答，onSubmit 若在回复的上下文里写文件就会和它互相等待。
 */
async function askAs(route: AskRoute, pluginId: string, context: { signal: AbortSignal; callId: string }, options: AskOptions): Promise<AskOutcome> {
  const item = await prepareItem(options.item);
  const run = currentRun();
  const onSubmit = options.onSubmit;
  const inCall = AsyncLocalStorage.snapshot();
  return route({
    origin: { kind: "plugin", pluginId, ...(run === undefined ? {} : { sessionId: run.sessionId }), callId: context.callId },
    item,
  }, {
    signal: context.signal,
    ...(onSubmit === undefined ? {} : { onSubmit: (response) => inCall(() => onSubmit.call(options, response)) }),
  });
}

const AgentFieldsSchema = object({
  id: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
  description: Type.Optional(Type.String()),
  tools: Type.Array(Type.String()),
  subagents: Type.Optional(Type.Array(Type.String())),
  direct: Type.Optional(Type.Boolean()),
});

class AgentDefinitionFailure extends Error {
  constructor(readonly definition: AgentDefinition, readonly failure: unknown) {
    super("插件 Agent 定义无效");
  }
}

/**
 * 核对 definitions：id 唯一（也不与 existing 重复），工具和子 Agent 都存在，子 Agent 的工具不超过父 Agent。
 * 引用在 tools 与 existing、definitions 合起来的集合里查。定义可以互相列为子 Agent，也可以列自己；失控的递归由运行时的嵌套层数上限挡住。
 */
function checkAgents(definitions: AgentDefinition[], tools: Set<string>, existing: AgentDefinition[] = []): void {
  const ids = new Set<string>(existing.map((definition) => definition.id));
  for (const definition of definitions) {
    try {
      const { id, description, tools: declared, subagents, direct } = definition;
      const fields = {
        id, tools: declared,
        ...(description === undefined ? {} : { description }),
        ...(subagents === undefined ? {} : { subagents }),
        ...(direct === undefined ? {} : { direct }),
      };
      const functions = [definition.view, definition.beforeMessage, definition.beforeRun];
      if (!Check(AgentFieldsSchema, fields) || typeof definition.instructions !== "function" || functions.some(item => item !== undefined && typeof item !== "function")) {
        throw new RepaFault("invalid_agent", "Agent 定义不符合接口要求", { id });
      }
      if (id === "general" || ids.has(id)) throw new RepaFault("invalid_agent_id", "Agent id 必须唯一，且不能使用 general", { id });
      ids.add(id);
    } catch (error) {
      throw new AgentDefinitionFailure(definition, error);
    }
  }
  const builtins = new Set<string>([...BUILTIN_TOOLS, ASK_USER_TOOL]);
  const byId = new Map([...existing, ...definitions].map((definition) => [definition.id, definition]));
  for (const definition of definitions) {
    try {
      for (const tool of definition.tools) {
        if (!builtins.has(tool) && !tools.has(tool)) {
          throw new RepaFault("unknown_agent_tool", "Agent 定义引用了不存在的工具", { agent: definition.id, tool });
        }
        // Pi 的 grep 把模型给的 glob 原样交给 ripgrep 的 --glob，后者越过忽略文件，.repa/.ignore 挡不住它；
        // 底座又不另写一套搜索，所以插件 Agent 不提供 grep。
        if (tool === "grep") {
          throw new RepaFault("agent_tool_unavailable", "插件 Agent 不提供 grep：它会越过 .repa/.ignore 读到会话记录和插件数据。需要搜索课程内容时，请由插件提供自己的工具", { agent: definition.id, tool });
        }
      }
      const allowed = new Set(definition.tools);
      for (const subagent of definition.subagents ?? []) {
        const child = byId.get(subagent);
        if (child === undefined) throw new RepaFault("unknown_subagent", "Agent 定义引用了不存在的子 Agent", { agent: definition.id, subagent });
        // 更高权限的工作由插件程序触发，不能靠 Agent 之间转托取得。
        const beyond = child.tools.filter((tool) => !allowed.has(tool));
        if (beyond.length > 0) {
          throw new RepaFault("subagent_exceeds_parent", "子 Agent 的工具超过父 Agent", { agent: definition.id, subagent, tools: beyond });
        }
      }
    } catch (error) {
      throw new AgentDefinitionFailure(definition, error);
    }
  }
}

/**
 * 插件的一个实例。每打开一次是新的一个，交出去的 Host、工具和 Agent 闭包都绑定在它上面；
 * 同一个 id 重新打开得到新的实例，旧实例的闭包不会因此复活。
 */
interface Opened {
  id: string;
  instance?: PluginInstance;
  models: ModelScope;
  tools: AgentTool[];
  /** 插件声明的原始定义，核对用；agents 是交给运行时的包装。 */
  definitions: AgentDefinition[];
  agents: AgentDefinition[];
  /**
   * 撤下或打开失败以后：工具、方法、服务、Agent 闭包与 Host 一律拒绝，事件不再转发，在途调用随之失败；
   * 撤下之前发起、还在等空间写锁的写空间与历史操作随之取消。
   */
  retired: AbortController;
  /** close() 已返回或抛错：宿主整体关闭时，Host 的文件与历史操作到这时才拒绝。 */
  ended: boolean;
}

/** 在指定空间中打开插件并核对声明，返回统一的工具、协议调用与生命周期入口。 */
export async function openPluginHost(options: PluginHostOptions): Promise<PluginHost> {
  const { space } = options;
  // 打开着的实例，按加上的先后排列。
  const opened = new Map<string, Opened>();
  // 已经撤下、close() 还没结束的实例；同一个 id 这时不能再加上。
  const closingPlugins = new Map<string, Promise<void>>();
  // 正在 add 的 id，挡住同一个 id 的并发加载。add 经 track 登记，宿主关闭时等它收回。
  const adding = new Set<string>();
  const askRoute = options.ask ?? NO_ASK;
  const serviceRoute = options.services ?? NO_SERVICES;
  let pending: Promise<void> = Promise.resolve();
  let pendingError: unknown;
  let closed = false;
  let stopping = false;
  const calls = new Set<Promise<unknown>>();
  let started = false;
  let starting: Promise<void> | undefined;
  // start() 的追赶完成以后为 true；此后发起的变化处理出错照常报告，不再停用插件。
  let caughtUp = false;
  const waiting = new Set<string>();
  let closing: Promise<void> | undefined;
  const disabledPlugins: ReturnType<PluginHost["disabled"]> = [];

  function checkOpen(): void {
    if (closed || stopping) throw new RepaFault("plugins_closed", "插件宿主已经关闭");
  }

  function retiredFault(): RepaFault {
    return new RepaFault("plugins_closed", "插件已经关闭");
  }

  /** Host 上的服务、中止 Agent 与导出，插件的工具、方法和 Agent：宿主开始关闭或这个实例撤下以后立即拒绝。 */
  function checkLive(entry: Opened): void {
    checkOpen();
    if (entry.retired.signal.aborted) throw retiredFault();
  }

  /** 实例撤下时，已经在执行的调用立即失败，不等插件自己停下。 */
  function guard<T>(entry: Opened, operation: Promise<T>): Promise<T> {
    const signal = entry.retired.signal;
    if (signal.aborted) return Promise.reject(retiredFault());
    return new Promise<T>((resolve, reject) => {
      const abort = () => { reject(retiredFault()); };
      signal.addEventListener("abort", abort, { once: true });
      operation.then(resolve, reject).finally(() => { signal.removeEventListener("abort", abort); });
    });
  }

  /**
   * Host 上的文件与历史操作：宿主整体关闭时仍然放行，直到这个实例结束，插件因此可以在 close() 里等后台工作写完结果；
   * 撤下以后与实例结束以后返回失败的 Promise。gated 的操作（写空间、读历史、记录历史）要等空间写锁：
   * 正在加上的实例（还不在 opened 里）碰上有运行独占着写锁时，等它就会和持锁、等着加上的运行互相卡住，这时立即失败。
   * 撤下时还在等锁的那些由 retired 取消，等它们的 close() 因此不会卡住撤下它的运行。
   */
  function admitted<T>(entry: Opened, action: () => Promise<T>, gated = false): Promise<T> {
    if (entry.ended || entry.retired.signal.aborted) return Promise.reject(retiredFault());
    if (gated && opened.get(entry.id) !== entry && space.writeLocked()) {
      return Promise.reject(new RepaFault("space_busy", "有运行独占着空间写锁，插件在加上的过程中不能写空间、读历史", { pluginId: entry.id }));
    }
    return action();
  }

  async function closeModels(): Promise<void> {
    const results = await Promise.allSettled([...opened.values()].map((entry) => entry.models.close()));
    const failures = results.flatMap((result) => {
      if (result.status === "fulfilled") return [];
      return result.reason instanceof AggregateError ? result.reason.errors : [result.reason];
    });
    if (failures.length > 0) throw new AggregateError(failures, "插件模型工作关闭失败");
  }

  /** 先停稳实例的模型工作，再调用它的 close()；之后它的 Host 作废。返回途中的错误。 */
  async function shut(entry: Opened): Promise<unknown[]> {
    const failures: unknown[] = [];
    try {
      await entry.models.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await entry.instance?.close?.();
    } catch (error) {
      failures.push(error);
    }
    entry.ended = true;
    return failures;
  }

  /** 撤下实例并在运行的上下文之外关闭它，途中的错误交给 onError。 */
  async function discard(entry: Opened): Promise<void> {
    entry.retired.abort();
    if (opened.get(entry.id) === entry) opened.delete(entry.id);
    for (const failure of await detached(() => shut(entry))) options.onError(failure);
  }

  /** 打开空间时失败的插件：撤下并关闭，列进 disabled()。Agent 运行时每次用到时才向宿主取工具和 Agent，移除以后就不再有它的声明。 */
  async function disable(entry: Opened, error: unknown): Promise<void> {
    // 已经撤下的实例由撤下的一方关闭；同一个 id 这时可能已经加上了新实例，不能再关一次旧的，也不能把这个 id 记成失败。
    if (entry.retired.signal.aborted) {
      options.onError(error);
      return;
    }
    disabledPlugins.push({
      id: entry.id,
      reason: {
        code: error instanceof RepaFault ? error.code : "plugin_open_failed",
        message: errorText(error),
      },
    });
    options.onError(error);
    await discard(entry);
  }

  function track<T>(operation: Promise<T>): Promise<T> {
    calls.add(operation);
    operation.then(() => { calls.delete(operation); }, () => { calls.delete(operation); });
    return operation;
  }

  function wrapAgent(entry: Opened, definition: AgentDefinition): AgentDefinition {
    const { view, beforeMessage, beforeRun } = definition;
    return {
      id: definition.id,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      instructions() {
        checkLive(entry);
        return definition.instructions();
      },
      tools: [...definition.tools],
      ...(definition.subagents === undefined ? {} : { subagents: [...definition.subagents] }),
      ...(definition.direct === undefined ? {} : { direct: definition.direct }),
      ...(view === undefined ? {} : {
        view() {
          checkLive(entry);
          return track(guard(entry, Promise.resolve().then(() => view.call(definition))));
        },
      }),
      ...(beforeRun === undefined ? {} : {
        beforeRun() {
          checkLive(entry);
          return track(guard(entry, Promise.resolve().then(() => beforeRun.call(definition))));
        },
      }),
      ...(beforeMessage === undefined ? {} : {
        beforeMessage(message) {
          checkLive(entry);
          return track(guard(entry, Promise.resolve().then(() => beforeMessage.call(definition, message))));
        },
      }),
    };
  }

  function ordered(): Opened[] {
    return [...opened.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  }

  function liveTools(except?: Opened): AgentTool[] {
    return [...opened.values()].filter((entry) => entry !== except).flatMap((entry) => entry.tools);
  }

  function liveDefinitions(except?: Opened): AgentDefinition[] {
    return [...opened.values()].filter((entry) => entry !== except).flatMap((entry) => entry.definitions);
  }

  /**
   * 打开空间时一次核对全部插件的声明。插件可以引用别的插件的工具和 Agent；移除失败方以后重新核对，依赖缺失只停受影响的插件。
   * 运行中撤下一个插件不再核对：引用它的插件照常运行，引用的那一项在运行时按名字取不到。
   */
  async function checkDeclarations(): Promise<void> {
    for (;;) {
      try {
        checkAgents(liveDefinitions(), new Set(liveTools().map((tool) => tool.name)));
      } catch (error) {
        if (!(error instanceof AgentDefinitionFailure)) throw error;
        const owner = [...opened.values()].find((entry) => entry.definitions.includes(error.definition));
        if (!owner) throw error;
        await disable(owner, error.failure);
        continue;
      }
      // Agent 定义有效后才按装配顺序分配工具名，避免坏插件先占名而拖停无关插件。
      const names = new Set<string>();
      let conflict: { entry: Opened; name: string } | undefined;
      for (const entry of opened.values()) {
        const duplicate = entry.tools.find((tool) => names.has(tool.name));
        if (duplicate) {
          conflict = { entry, name: duplicate.name };
          break;
        }
        for (const tool of entry.tools) names.add(tool.name);
      }
      if (conflict) {
        await disable(conflict.entry, new RepaFault("tool_name_conflict", "插件工具名称重复或覆盖内置工具", { name: conflict.name }));
        continue;
      }
      return;
    }
  }

  /** 运行中加上的插件只与已在运行的插件核对；冲突时只有它失败。 */
  function checkAdded(entry: Opened): void {
    const names = new Set(liveTools(entry).map((tool) => tool.name));
    const duplicate = entry.tools.find((tool) => names.has(tool.name));
    if (duplicate) throw new RepaFault("tool_name_conflict", "插件工具名称重复或覆盖内置工具", { name: duplicate.name });
    try {
      checkAgents(entry.definitions, new Set([...names, ...entry.tools.map((tool) => tool.name)]), liveDefinitions(entry));
    } catch (error) {
      throw error instanceof AgentDefinitionFailure ? error.failure : error;
    }
  }

  /**
   * 打开一个实例并读取它的工具和 Agent 声明，open() 在运行的上下文之外执行。失败时关闭已经打开的部分，
   * 抛出的错误带上 entry 与清理中的错误，由调用方决定怎样报告。
   */
  async function openInstance(plugin: Plugin): Promise<Opened> {
    const ownedModels = createModelScope(typeof options.models === "function" ? options.models(plugin.id) : options.models, options.onError);
    const entry: Opened = {
      id: plugin.id,
      models: ownedModels,
      tools: [],
      definitions: [],
      agents: [],
      retired: new AbortController(),
      ended: false,
    };
    try {
      const dataDir = await space.pluginDataDir(plugin.id);
      const ownedAgents = new Set<string>();
      const files = space.filesFor({ kind: "plugin", pluginId: plugin.id }, entry.retired.signal);
      const host: Host = {
        now: options.now ?? Date.now,
        space: { root: space.root, dataDir },
        files: {
          read: (file) => admitted(entry, () => files.read(file)),
          write: (file, text) => admitted(entry, () => files.write(file, text), true),
          list: (directory) => admitted(entry, () => files.list(directory)),
        },
        history: {
          // 历史读取排在历史队列上，那里不能取消；先共享地拿空间写锁（加锁次序本来就在历史队列之前），撤下时才能取消等待。
          changes: (since) => admitted(entry, () => space.writes.lock(() => space.history.changes(since), entry.retired.signal), true),
          list: (limit) => admitted(entry, () => space.writes.lock(() => space.history.list(limit), entry.retired.signal), true),
          record: (source, action) => {
            if (source.kind !== "plugin" || source.pluginId !== plugin.id) {
              throw new RepaFault("invalid_history_source", "插件只能以自己的来源记录历史");
            }
            return admitted(entry, () => space.record(source, action, entry.retired.signal), true);
          },
        },
        models: ownedModels.models,
        abortAgent(agent) {
          checkLive(entry);
          if (!ownedAgents.has(agent)) {
            return Promise.reject(new RepaFault("agent_not_owned", "插件只能中止自己声明的 Agent", { agent }));
          }
          if (!options.abortAgent) {
            return Promise.reject(new RepaFault("space_not_ready", "空间尚未接入 Agent 中止入口"));
          }
          return track(Promise.resolve().then(() => options.abortAgent?.(agent)));
        },
        services: {
          call(service, input, callOptions) {
            checkLive(entry);
            return track(Promise.resolve().then(() => serviceRoute.call(service, input, callOptions)));
          },
        },
        // 实例撤下以后不再转发它的事件。
        emit: (event) => { if (!entry.retired.signal.aborted) options.emit(plugin.id, event); },
        prepareExport(request) {
          checkLive(entry);
          const sources = options.exports;
          if (sources === undefined) return Promise.reject(new RepaFault("export_unavailable", "当前宿主不提供导出"));
          return track(prepareExport({
            ...sources,
            pluginId: plugin.id,
            dataDir,
            sessionsDir: space.sessionsDir,
            now: options.now ?? Date.now,
          }, request));
        },
      };
      const instance = await detached(() => plugin.open(host));
      entry.instance = instance;
      const reservedNames = new Set(RESERVED_TOOL_NAMES);
      const localNames = new Set<string>();
      entry.tools = (instance.tools?.() ?? []).map((tool): AgentTool => {
        if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(tool.name)) {
          throw new RepaFault("invalid_tool_name", "插件工具名称必须有效且不能重复", { name: tool.name });
        }
        if (localNames.has(tool.name) || reservedNames.has(tool.name)) {
          throw new RepaFault("tool_name_conflict", "插件工具名称重复或覆盖内置工具", { name: tool.name });
        }
        localNames.add(tool.name);
        return {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          execute(input, context) {
            // 撤下以后，模型同一次回复里已经发出的调用仍会到这里，这时失败。
            checkLive(entry);
            const checked = parse(tool.parameters, input);
            const ask = (askOptions: AskOptions) => {
              checkLive(entry);
              return askAs(askRoute, plugin.id, context, askOptions);
            };
            return track(guard(entry, Promise.resolve().then(() => withToolCall(context.callId, () => tool.execute(checked, { ...context, ask })))));
          },
        };
      });
      entry.definitions = instance.agents?.() ?? [];
      for (const definition of entry.definitions) ownedAgents.add(definition.id);
      entry.agents = entry.definitions.map((definition) => wrapAgent(entry, definition));
      return entry;
    } catch (error) {
      throw new OpenFailure(entry, error);
    }
  }

  function wake(revision: string): void {
    if (stopping || closed) return;
    if (!started) {
      waiting.add(revision);
      return;
    }
    const opening = !caughtUp;
    pending = pending.then(async () => {
      const failures: [Opened, unknown][] = [];
      for (const entry of [...opened.values()]) {
        if (entry.retired.signal.aborted) continue;
        try {
          await entry.instance?.onChange?.(revision);
        } catch (error) {
          failures.push([entry, error]);
        }
      }
      if (failures.length === 0) return;
      if (!opening) throw new AggregateError(failures.map(([, error]) => error), "插件变化处理失败");
      // start() 追赶完成之前，变化处理也是打开空间的一部分：出错和 open 失败一样，只停这个插件，再核对依赖它的插件。
      for (const [entry, error] of failures) await disable(entry, error);
      await checkDeclarations();
    }).catch((error: unknown) => {
      pendingError = error;
      options.onError(error);
    });
  }

  /** 运行中加上的插件追赶到最新修订。排进变化处理的队列，发起后不等：有运行持着历史队列时，它在运行结束后执行。 */
  function catchUp(entry: Opened): void {
    const onChange = entry.instance?.onChange;
    if (onChange === undefined) return;
    detached(() => {
      pending = pending.then(async () => {
        if (entry.retired.signal.aborted) return;
        const [latest] = await space.history.list(1);
        if (latest !== undefined && !entry.retired.signal.aborted) await onChange.call(entry.instance, latest.id);
      }).catch((error: unknown) => {
        pendingError = error;
        options.onError(error);
      });
    });
  }

  async function flush(): Promise<void> {
    let current: Promise<void>;
    do {
      await space.flush();
      current = pending;
      await current;
    } while (current !== pending);
    if (pendingError !== undefined) {
      const error = pendingError;
      pendingError = undefined;
      throw error;
    }
  }

  // 监听先登记，但在运行时接好并 start 之前只积累唤醒。
  const unsubscribe = space.onRevision((revision) => { wake(revision.id); });
  try {
    const ids = new Set<string>();
    for (const plugin of options.plugins) {
      if (!PLUGIN_ID.test(plugin.id) || ids.has(plugin.id)) {
        throw new RepaFault("invalid_plugin_id", "插件 id 必须唯一，且仅含小写字母、数字和连字符", { id: plugin.id });
      }
      ids.add(plugin.id);
    }
    for (const plugin of options.plugins) {
      try {
        const entry = await openInstance(plugin);
        opened.set(plugin.id, entry);
      } catch (error) {
        if (!(error instanceof OpenFailure)) throw error;
        await disable(error.entry, error.failure);
      }
    }
    await checkDeclarations();
  } catch (error) {
    stopping = true;
    unsubscribe();
    const failures = [error];
    try {
      await closeModels();
    } catch (closeError) {
      failures.push(closeError);
    }
    for (const entry of [...opened.values()].reverse()) {
      try {
        await entry.instance?.close?.();
      } catch (closeError) {
        failures.push(closeError);
      }
      entry.ended = true;
    }
    if (failures.length > 1) throw new AggregateError(failures, "插件打开与清理都失败了");
    throw error;
  }

  return {
    start() {
      checkOpen();
      if (starting === undefined) {
        starting = track((async () => {
          const [latest] = await space.history.list(1);
          if (latest) waiting.add(latest.id);
          started = true;
          for (const revision of waiting) wake(revision);
          waiting.clear();
          await flush();
          caughtUp = true;
        })());
      }
      return starting;
    },
    add(plugin) {
      return track((async () => {
        checkOpen();
        if (!PLUGIN_ID.test(plugin.id)) {
          throw new RepaFault("invalid_plugin_id", "插件 id 必须仅含小写字母、数字和连字符", { id: plugin.id });
        }
        if (opened.has(plugin.id) || adding.has(plugin.id)) throw new RepaFault("plugin_open", "这个插件已经打开", { pluginId: plugin.id });
        if (closingPlugins.has(plugin.id)) throw new RepaFault("plugin_closing", "这个插件的上一个实例还没有关闭完", { pluginId: plugin.id });
        adding.add(plugin.id);
        // 失败的实例当场关闭，宿主里不留下半个实例；清理中的错误经 onError 报告，调用方拿到的是原来的错误。
        try {
          let entry: Opened;
          try {
            entry = await openInstance(plugin);
          } catch (error) {
            if (!(error instanceof OpenFailure)) throw error;
            await discard(error.entry);
            throw error.failure;
          }
          try {
            checkAdded(entry);
            // 打开期间宿主开始关闭：关闭等这次 add 结束，但不会再看到这个实例，这里自己收回。
            checkOpen();
          } catch (error) {
            await discard(entry);
            throw error;
          }
          opened.set(plugin.id, entry);
          const index = disabledPlugins.findIndex((item) => item.id === plugin.id);
          if (index >= 0) disabledPlugins.splice(index, 1);
          if (started) catchUp(entry);
        } finally {
          adding.delete(plugin.id);
        }
      })());
    },
    remove(id) {
      checkOpen();
      const entry = opened.get(id);
      if (entry === undefined) throw new RepaFault("plugin_not_found", "插件不存在", { pluginId: id });
      // 同步完成：不再列出它的工具、Agent 和方法，交出去的闭包、Host 与在途调用一律失败。
      opened.delete(id);
      entry.retired.abort();
      const done = detached(async () => {
        try {
          const failures = await shut(entry);
          if (failures.length > 0) throw closeFailure(id, failures.length === 1 ? failures[0] : new AggregateError(failures, "插件关闭失败"));
        } finally {
          closingPlugins.delete(id);
        }
      });
      closingPlugins.set(id, done);
      // 调用方可以不等；不等时错误只经 onError 报告，不成为未处理的拒绝。
      done.catch((error: unknown) => { options.onError(error); });
      return done;
    },
    disabled() {
      checkOpen();
      return disabledPlugins.map((plugin) => ({ ...plugin, reason: { ...plugin.reason } })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    },
    list() {
      checkOpen();
      return ordered().map((entry) => ({
        id: entry.id,
        methods: Object.keys(entry.instance?.methods ?? {}),
        tools: entry.tools.map((tool) => tool.name),
      }));
    },
    instructions() {
      checkOpen();
      const result: { id: string; text: string }[] = [];
      for (const entry of ordered()) {
        const text = entry.instance?.instructions?.();
        if (text !== undefined) result.push({ id: `plugin:${entry.id}`, text });
      }
      return result;
    },
    tools() {
      checkOpen();
      return liveTools().sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    },
    agents() {
      checkOpen();
      return [...opened.values()].flatMap((entry) => entry.agents).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    },
    views() {
      checkOpen();
      return track((async () => {
        const result: { id: string; text: string }[] = [];
        for (const entry of ordered()) {
          let text: string | undefined;
          try {
            text = await guard(entry, Promise.resolve().then(() => entry.instance?.view?.()));
          } catch (error) {
            // 期间撤下的插件不再有 view。
            if (entry.retired.signal.aborted) continue;
            throw error;
          }
          if (text !== undefined) result.push({ id: `plugin:${entry.id}`, text });
        }
        return result;
      })());
    },
    call(pluginId, methodName, input, caller) {
      checkOpen();
      const operation = (async () => {
        const entry = opened.get(pluginId);
        if (!entry) throw new RepaFault("plugin_not_found", "插件不存在", { pluginId });
        const methods = entry.instance?.methods ?? {};
        const method = Object.hasOwn(methods, methodName) ? methods[methodName] : undefined;
        if (!method) throw new RepaFault("plugin_method_not_found", "插件方法不存在", { pluginId, methodName });
        const result = await guard(entry, Promise.resolve().then(() => method.invoke(parse(method.parameters, input), caller === undefined ? {} : { caller })));
        // 返回前按声明校验结果，多带的字段也在这里拦下。
        if (method.result !== undefined && !Check(method.result, result)) {
          throw new RepaFault("invalid_plugin_result", "插件方法的返回值不符合它声明的 schema", { pluginId, methodName });
        }
        return result;
      })();
      return track(operation);
    },
    flush,
    close() {
      if (closing === undefined) {
        stopping = true;
        unsubscribe();
        closing = (async () => {
          const failures: unknown[] = [];
          try {
            await closeModels();
          } catch (error) {
            failures.push(error);
          }
          await Promise.allSettled([...calls]);
          try {
            await flush();
          } catch (error) {
            failures.push(error);
          }
          closed = true;
          for (const entry of [...opened.values()].reverse()) {
            try {
              await entry.instance?.close?.();
            } catch (error) {
              failures.push(closeFailure(entry.id, error));
            }
            entry.ended = true;
          }
          // 已经撤下的实例各自报告错误；这里只等它们结束，宿主关闭以后不留仍在运行的实例。
          await Promise.allSettled([...closingPlugins.values()]);
          if (failures.length > 0) throw new AggregateError(failures, "插件宿主关闭失败");
        })();
      }
      return closing;
    },
  };
}

/** 写明是哪个插件关闭出错；原错误放进 cause，记进最近错误时保留插件自己的堆栈。 */
function closeFailure(id: string, error: unknown): RepaFault {
  return Object.assign(new RepaFault("plugin_close_failed", `插件 ${id} 关闭时出错：${errorText(error)}`, { pluginId: id }), { cause: error });
}

/** openInstance 失败：带上已经建立的实例，调用方据此清理。 */
class OpenFailure extends Error {
  constructor(readonly entry: Opened, readonly failure: unknown) {
    super("插件打开失败");
  }
}
