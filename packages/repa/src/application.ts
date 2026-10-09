import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { existsSync, watch, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { prepareInput, inputResources, inputText } from "./requests/input.js";
import type { Submit, Continue, RequestRecord, QueueView, RunOptions, InteractionReplyReceipt } from "./requests/schema.js";
import { BackgroundRequests, type ProcessingContext } from "./requests/background.js";
import type { BackgroundRequest, Input, ProcessingResult } from "./requests/schema.js";
import { ConfigStore } from "./configuration/store.js";
import { PromptSettingsSchema, type SettingScope, type PromptSettings, type SettingsView } from "./configuration/schema.js";
import type { SettingsNamespaceDefinition } from "./configuration/definitions.js";
import { RUNTIME_SETTINGS_DEFINITION, SUMMARY_SETTINGS_DEFINITION, type RuntimeSettings } from "./configuration/runtime.js";
import { defaultThinkingLevel, sessionSettings, snapshotSettings } from "./agent/settings.js";
import { previewPrompt } from "./agent/prompt-preview.js";
import type { SummaryPrompts } from "./agent/summary-settings.js";
import { executionRepresentation } from "./execution/format.js";
import { ExecutionService } from "./execution/service.js";
import { EXECUTION_SETTINGS_DEFINITION } from "./execution/settings.js";
import type { ExecutionContext, ProgramCapabilities } from "./execution/service.js";
import { ModelConnections } from "./models/service.js";
import { ModelCalls } from "./models/calls.js";
import { ModelCompleteOptionsSchema, interruptModelAttempts, updateModelAttempts, type ModelCompleteOptions, type ModelMethod, type ModelParams, type ModelBinding, type ModelAttempt } from "./models/schema.js";
import { InstalledContributions } from "./agent/contributions.js";
import { PLUGIN_SETTINGS_DEFINITION, type PluginSettings } from "./configuration/plugins.js";
import { PluginRuntime } from "./plugins/runtime.js";
import { discoverPluginResources, selectBackendEntry } from "./plugins/resources.js";
import { PluginPackages } from "./plugins/packages.js";
import type { PackageMethod } from "./plugins/protocol.js";
import type { BundledPluginRegistration, PluginPackage } from "./plugins/schema.js";
import { SEARCH_PLUGIN_ID, SEARCH_TOOLS } from "./search/plugin.js";
import type { BackendPluginRegistration } from "./capabilities/types.js";
import type { CapabilityScope, CapabilitySelection, CapabilitySource } from "./capabilities/schema.js";
import { CapabilityNotificationSchema } from "./capabilities/schema.js";
import type { RepaCapabilityServices } from "./capabilities/services.js";
import { capabilityRepresentation } from "./capabilities/resources.js";
import { DisplayService } from "./display/service.js";
import type { DisplayMethod, DisplayParams } from "./display/schema.js";
import { ContentStore } from "./content/store.js";
import type { ResourceRetentionOptions } from "./content/resources.js";
import { ContentAccessStore } from "./content/access.js";
import type { ContentMethod } from "./content/protocol.js";
import type { ContentChangeResult, ContentTarget } from "./content/schema.js";
import { SerialQueue } from "./storage/atomic.js";
import { PiSessionStore, type StoredSession } from "./pi-sessions.js";
import {
  type ConversationRuntime,
  type Dialog,
  type DialogOptions,
  type HostEvent,
  type PiModelOverride,
} from "./pi-host.js";
import {
  isTerminal,
  RepaFault,
  type Change,
  type Delivery,
  type Interaction,
  type Params,
  type Result,
  type Reply,
  type Run,
  type Scope,
  type SessionKey,
  type SessionView,
  type SessionSummary,
  type Snapshot,
  type Space,
} from "./protocol.js";
import { RuntimeStore } from "./runtime-store.js";
import { SpaceOperations } from "./spaces/store.js";
import type { SpaceMethod, SpaceSnapshotParticipant } from "./spaces/schema.js";
import { browseDirectory, createSpaceDirectory } from "./spaces/entry.js";
import { RecentSpaces } from "./spaces/recent.js";
import { SPACES_SETTINGS_DEFINITION } from "./spaces/settings.js";
import { Diagnostics, type DiagnosticOptions } from "./diagnostics.js";
import { queryContentRelations } from "./content/relations.js";
import { applyChange, contains, relevant } from "./state.js";

interface CapabilityParent {
  cancel(): void;
  progress(message: string): void;
  ask(dialog: Dialog, options?: DialogOptions): Promise<Reply>;
}

export interface ApplicationOptions {
  diagnostics?: DiagnosticOptions;
  agentDir?: string;
  appDirectory?: string;
  resources?: ResourceRetentionOptions;
  snapshotParticipants?: readonly SpaceSnapshotParticipant[];
  settingsDefinitions?: readonly SettingsNamespaceDefinition[];
  plugins?: readonly BackendPluginRegistration[];
  bundledPackages?: readonly BundledPluginRegistration[] | ((configuration: PluginSettings) => readonly BundledPluginRegistration[]);
  promptDefaults?: (configuration: PluginSettings) => Partial<PromptSettings>;
  trustExtensions?: boolean;
  eventBufferSize?: number;
  exitWhenDetached?: boolean;
  modelOverride?:
    | PiModelOverride
    | ((space: Space, sessionId: string) => Promise<PiModelOverride>);
}
interface ActiveRun {
  run: Run;
  request: RequestRecord;
  controller: AbortController;
  done: Promise<void>;
  deliveries: Promise<void>[];
  ready: Promise<void>;
  resolveReady: () => void;
  firstStatusAt?: number;
  firstTextAt?: number;
}
interface SpaceRecord {
  store: RuntimeStore;
  sessions: PiSessionStore;
  content: ContentStore;
  processing: BackgroundRequests;
  watcher?: FSWatcher;
  watchTimer?: ReturnType<typeof setTimeout>;
}
interface SessionRecord {
  store: RuntimeStore;
  session: StoredSession;
  view: SessionView;
  host?: ConversationRuntime;
  binding?: ModelBinding;
  opening?: Promise<ConversationRuntime>;
  active?: ActiveRun;
  closing?: Promise<void>;
  deleting?: boolean;
}
interface PendingReply {
  interaction: Interaction;
  resolve: (receipt: InteractionReplyReceipt) => void;
}
const productPromptDefaultsSchema = Type.Partial(PromptSettingsSchema, { additionalProperties: false });

const keyOf = (key: SessionKey) => `${key.spaceId}/${key.sessionId}`;
const runtimeIdentity = (binding?: ModelBinding) => {
  if (!binding) return undefined;
  const { id, provider, authId, authMode, baseUrl, models } = binding.connection;
  return { id, provider, authId, authMode, baseUrl, models };
};

export class RepaApplication {
  readonly id = randomUUID();
  readonly diagnostics: Diagnostics;
  readonly closed: Promise<void>;
  readonly #options: ApplicationOptions;
  readonly #contributions: InstalledContributions;
  readonly #backendPlugins: readonly BackendPluginRegistration[];
  readonly #configuration: ConfigStore;
  readonly #models: ModelConnections;
  readonly #modelCalls: ModelCalls;
  readonly #display: DisplayService;
  readonly #execution: ExecutionService;
  readonly #appDirectory: string;
  readonly #pluginRuntimes = new Map<string, Promise<PluginRuntime>>();
  #applicationRequests?: BackgroundRequests;
  #openingApplicationRequests?: Promise<BackgroundRequests>;
  #releaseApplicationRequests?: () => Promise<void>;
  readonly #packageReloadRequired = new Set<string>();
  readonly #packageOperations = new Map<string, SerialQueue>();
  readonly #access: Promise<ContentAccessStore>;
  readonly #admission = new SerialQueue();
  readonly #spaceOperations: SpaceOperations;
  readonly #recentSpaces: RecentSpaces;
  readonly #maintenance = new Set<string>();
  readonly #spaceActivities = new Map<string, number>();
  readonly #state: Snapshot = {
    lifecycle: "running",
    spaces: [],
    sessions: [],
  };
  readonly #spaces = new Map<string, SpaceRecord>();
  readonly #openingSpaces = new Map<string, Promise<Space>>();
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #pending = new Map<string, PendingReply>();
  readonly #replyReceipts = new Map<string, Map<string, { sessionId?: string; receipt: InteractionReplyReceipt }>>();
  readonly #watchers = new Set<{
    scope: Scope;
    send: (value: Delivery) => void;
    cursor: string;
  }>();
  readonly #log: { sequence: number; change: Change }[] = [];
  readonly #clients = new Set<string>();
  #sequence = 0;
  #activities = 0;
  #explicitShutdown = false;
  #finishing = false;
  #resolveClosed!: () => void;
  #rejectClosed!: (error: Error) => void;

  constructor(options: ApplicationOptions = {}) {
    this.diagnostics = new Diagnostics(this.id, options.diagnostics);
    if (
      options.eventBufferSize !== undefined &&
      (!Number.isInteger(options.eventBufferSize) ||
        options.eventBufferSize < 1)
    )
      throw new Error("事件缓存大小必须为正整数。");
    this.#backendPlugins = [...options.plugins ?? []];
    this.#contributions = new InstalledContributions(this.#backendPlugins);
    this.#options = options;
    const appDirectory = path.resolve(options.appDirectory ?? options.agentDir ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "repa"));
    this.#appDirectory = appDirectory;
    this.#configuration = new ConfigStore({
      appDirectory,
      resolveSpace: (id) => this.#store(id).space.path,
      definitions: [
        RUNTIME_SETTINGS_DEFINITION, SUMMARY_SETTINGS_DEFINITION, PLUGIN_SETTINGS_DEFINITION,
        EXECUTION_SETTINGS_DEFINITION, SPACES_SETTINGS_DEFINITION, ...(options.settingsDefinitions ?? []),
      ],
    });
    this.#models = new ModelConnections({
      directory: path.join(appDirectory, "models"),
      onChange: ({ connectionId }) => this.#emit({ type: "connection", connectionId }),
    });
    this.#modelCalls = new ModelCalls(this.#models);
    this.#display = new DisplayService({
      hostActive: id => this.#clients.has(id),
      submit: (input, source, signal) => this.submit(input, source.hostId, source, signal),
      space: spaceId => {
        const space = this.#space(spaceId);
        return { content: space.content, processing: space.processing,
          request: requestId => space.store.requests.requests.get(requestId),
          assertRequestAvailable: requestId => {
            this.#assertAccepting();
            if (space.store.requests.requests.has(requestId))
              throw new RepaFault("request_id_conflict", "相同标识已经用于会话输入。");
          },
        };
      },
    });
    this.#access = ContentAccessStore.open(appDirectory);
    this.#execution = new ExecutionService({
      configuration: this.#configuration,
      space: spaceId => ({ root: this.#store(spaceId).space.path, content: this.#space(spaceId).content }),
      protectedPaths: [appDirectory, path.resolve(options.agentDir ?? getAgentDir())],
      readPaths: async spaceId => (await this.#access).grantedPaths(spaceId),
      changed: execution => this.#emit({ type: "execution", execution }),
      output: (execution, stream, text) => this.#emit({ type: "execution_output",
        spaceId: execution.spaceId, requestId: execution.requestId, source: execution.source,
        execId: execution.id, stream, text }),
    });
    this.#spaceOperations = new SpaceOperations(path.join(appDirectory, "space-operations"));
    this.#recentSpaces = new RecentSpaces(appDirectory);
    // 保留初始化错误供实际内容访问报告，避免尚未打开空间时产生未处理拒绝。
    void this.#access.catch(() => {});
    this.closed = new Promise((resolve, reject) => {
      this.#resolveClosed = resolve;
      this.#rejectClosed = reject;
    });
  }

  attach(id: string): void {
    if (this.#finishing || this.#state.lifecycle === "stopped")
      throw new RepaFault("closed", "后端已经退出。");
    this.#clients.add(id);
    for (const record of this.#spaces.values()) record.content.retention.setHostActive(id, true);
    if (!this.#explicitShutdown && this.#state.lifecycle === "draining")
      this.#emit({ type: "lifecycle", lifecycle: "running" });
  }
  detach(id: string, confirmed = false): void {
    if (!this.#clients.delete(id)) return;
    this.#display.detach(id);
    for (const { content } of this.#spaces.values()) {
      content.retention.setHostActive(id, false);
      if (confirmed) {
        try { content.retention.releaseHost(id); }
        catch { /* 原租约仍保留；释放落盘失败时不提前回收字节。 */ }
      }
    }
    if (
      this.#options.exitWhenDetached &&
      this.#clients.size === 0 &&
      this.#state.lifecycle === "running"
    )
      this.#emit({ type: "lifecycle", lifecycle: "draining" });
    this.#finishIfReady();
  }

  openSpace(directory: string): Promise<Space> {
    return this.#activity(async () => {
      await mkdir(path.resolve(directory), { recursive: true });
      directory = await realpath(directory);
      const existing = [...this.#spaces.values()].find(item => item.store.space.path === directory);
      if (existing) {
        await this.#recentSpaces.remember(directory);
        return structuredClone(existing.store.space);
      }
      const opening = this.#openingSpaces.get(directory);
      if (opening) return opening;
      const promise = this.#openSpace(directory);
      this.#openingSpaces.set(directory, promise);
      try {
        return await promise;
      } finally {
        this.#openingSpaces.delete(directory);
      }
    });
  }
  async #openSpace(directory: string): Promise<Space> {
    if (existsSync(path.join(directory, ".repa-snapshot.json")))
      throw new RepaFault("snapshot_requires_restore", "这是空间备份目录，请先恢复到新的工作目录。");
    const store = new RuntimeStore(directory, (error) => {
      for (const record of this.#sessions.values())
        if (record.store.space.path === directory)
          this.#notice(record, "space_lock_lost", error.message);
      this.shutdown("cancel");
    });
    try {
      if (this.#spaces.has(store.space.id))
        throw new RepaFault(
          "space_identity_conflict",
          "两个目录拥有相同的学习空间身份。",
        );
      const access = await this.#access;
      const content = await ContentStore.open({
        ...this.#options.resources,
        formats: this.#contributions.formats,
        spaceId: store.space.id, root: store.space.path,
        assertOwned: () => store.assertOwned(),
        canReadExternal: (file) => access.canRead(store.space.id, file),
        onChange: (result) => this.#contentChanged(store.space.id, result.changes.map((entry) => entry.path), result),
      });
      for (const id of this.#clients) content.retention.setHostActive(id, true);
      const sessions = new PiSessionStore(store.space.path, content.retention);
      const existing = await sessions.list();
      this.#assertAccepting();
      const processing = new BackgroundRequests({
        directory: path.join(store.space.path, ".repa", "runtime", "processing"),
        spaceId: store.space.id, content, assertOwned: () => store.assertOwned(),
        changed: request => {
          this.#emit({ type: "processing", request });
          this.#finishIfReady();
        },
        ask: (requestId, signal, dialog, options) => this.#interact({ spaceId: store.space.id, requestId }, signal, dialog, options,
          (id, interaction, receipt) => processing.interaction(requestId, id, interaction, receipt)),
      });
      const record: SpaceRecord = { store, sessions, content, processing };
      const restoredSessions = existing.map(session => this.#prepareSession(store, session));
      // 先恢复所有历史的标准工具结果 owner，再收敛异常退出遗留的请求临时持有。
      for (const request of store.requests.requests.values()) {
        if (!["queued", "running"].includes(request.status))
          content.retention.retain(`request:${request.requestId}`, inputResources(request.input));
      }
      await this.#recentSpaces.remember(store.space.path);
      // 恢复和资源核对完成后再发布；失败只需释放尚未注册的空间租约。
      this.#spaces.set(store.space.id, record);
      this.#restoreReplyReceipts(store.space.id, store.requests.requests.values());
      this.#restoreReplyReceipts(store.space.id, processing.requests.values());
      for (const restored of restoredSessions) this.#sessions.set(keyOf(restored.view), restored);
      this.#emit({ type: "space", space: store.space });
      for (const request of processing.requests.values()) this.#emit({ type: "processing", request });
      for (const restored of restoredSessions) this.#emit({ type: "session", session: restored.view });
      this.#watchContent(record);
      return structuredClone(store.space);
    } catch (error) {
      store.release();
      throw error;
    }
  }
  listSpaces(): Space[] {
    return structuredClone(this.#state.spaces);
  }

  #contentChanged(spaceId: string, paths: string[], result?: ContentChangeResult): void {
    this.#emit({ type: "content", spaceId, revision: randomUUID(), paths, ...(result ? { result } : {}) });
  }
  #watchContent(record: SpaceRecord): void {
    const changed = new Set<string>();
    try {
      record.watcher = watch(record.store.space.path, { recursive: true }, (_event, file) => {
        const relative = file?.toString().split(path.sep).join("/") ?? ".";
        if (relative.split("/")[0] === ".repa" || /(^|\/)\.repa-.*\.tmp$/.test(relative)) return;
        changed.add(relative);
        if (record.watchTimer) return;
        record.watchTimer = setTimeout(() => {
          record.watchTimer = undefined;
          const paths = [...changed]; changed.clear();
          // 文件系统通知只是失效提示；共同操作完成以后才交给前端查询。
          void record.content.queue.run(async () => {
            if (!this.#finishing) this.#contentChanged(record.store.space.id, paths);
          }).catch(() => {});
        }, 30);
        record.watchTimer.unref();
      });
      record.watcher.on("error", () => {
        // 无法确定遗漏范围时，让空间视图整体失效。
        this.#contentChanged(record.store.space.id, ["."]);
      });
    } catch { this.#contentChanged(record.store.space.id, ["."]); }
  }

  async #activity<T>(action: () => Promise<T>, mutation = true, spaceId?: string): Promise<T> {
    if (mutation) this.#assertAccepting();
    else if (this.#finishing) throw new RepaFault("closed", "后端已经退出。");
    if (spaceId) {
      this.#assertSpaceAvailable(spaceId);
      this.#spaceActivities.set(spaceId, (this.#spaceActivities.get(spaceId) ?? 0) + 1);
    }
    this.#activities++;
    try { return await action(); }
    finally {
      if (spaceId) this.#spaceActivities.set(spaceId, this.#spaceActivities.get(spaceId)! - 1);
      this.#activities--; this.#finishIfReady();
    }
  }

  /** 所有公开内容调用在应用生命周期内执行，存储规则仍由 ContentStore 持有。 */
  contentCall(method: ContentMethod, params: Params<ContentMethod>, host: string = this.id): Promise<unknown> {
    const input = structuredClone(params);
    const p = <M extends ContentMethod>() => input as Params<M>;
    const targetSpace = (target: ContentTarget) => target.kind === "content" ? target.ref.spaceId : target.spaceId;
    const spaceId = "spaceId" in input ? input.spaceId : "ref" in input ? input.ref.spaceId : targetSpace(input.target);
    const mutation = !["content.list", "content.get", "content.read", "content.relations", "operation.get", "resource.hold.get"].includes(method);
    return this.#activity(async () => {
      const record = this.#spaces.get(spaceId);
      if (!record) throw new RepaFault("not_found", "学习空间尚未打开。");
      const content = record.content;
      switch (method) {
        case "content.list": return content.list(p<"content.list">());
        case "content.get": return content.get(p<"content.get">().target);
        case "content.read": return content.read(p<"content.read">(), host);
        case "content.relations": {
          const { path, limit } = p<"content.relations">();
          return queryContentRelations(content, { path, limit });
        }
        case "content.write": return content.write(p<"content.write">());
        case "content.edit": return content.edit(p<"content.edit">());
        case "content.applyPatch": return content.applyPatch(p<"content.applyPatch">());
        case "content.move": return content.transfer("move", p<"content.move">());
        case "content.copy": return content.transfer("copy", p<"content.copy">());
        case "material.collect": return content.transfer("collect", p<"material.collect">());
        case "content.associate": {
          const value = p<"content.associate">();
          return content.associate(value, async (file) => (await this.#access).grant(spaceId, file));
        }
        case "content.relink": {
          const value = p<"content.relink">();
          return content.relink(value, async (file) => (await this.#access).grant(spaceId, file));
        }
        case "content.remove": return content.remove(p<"content.remove">());
        case "content.setComposition": return content.setComposition(p<"content.setComposition">());
        case "operation.get": return content.operation(p<"operation.get">().operationId);
        case "operation.undo": return content.undo(p<"operation.undo">());
        case "operation.prune": {
          const removed = await content.pruneHistory(p<"operation.prune">().operationIds);
          if (removed.length) this.#contentChanged(spaceId, []);
          return removed;
        }
        case "resource.hold": return content.hold(p<"resource.hold">(), host);
        case "resource.hold.get": return content.retention.get(host, p<"resource.hold.get">().id);
        case "resource.hold.renew": return content.retention.renew(host, p<"resource.hold.renew">().id);
        case "resource.release": content.retention.release(host, p<"resource.release">().id); return null;
        case "resource.collect": return content.collectResources();
        case "operation.reconcile": {
          const result = await content.reconcile(p<"operation.reconcile">().operationId);
          this.#contentChanged(spaceId, ["."]);
          return result;
        }
      }
    }, mutation, spaceId);
  }
  async #readSettings(scope: SettingScope, namespaces: readonly string[]): Promise<SettingsView[]> {
    const views = await this.#configuration.getMany(scope, [...new Set([...namespaces, "plugins"])]);
    const pluginView = views.find(view => view.namespace === "plugins");
    const settings = Object.fromEntries(pluginView!.entries.map(entry => [entry.key, entry.effective])) as PluginSettings;
    const provided = namespaces.includes("prompts") && this.#options.promptDefaults ? this.#options.promptDefaults(settings) : {};
    if (!Check(productPromptDefaultsSchema, provided))
      throw new RepaFault("invalid_prompt_defaults", "产品提供的提示默认值格式无效。");
    const defaults = structuredClone(provided);
    return namespaces.map(namespace => {
      const view = views.find(item => item.namespace === namespace)!;
      if (namespace !== "prompts") return view;
      for (const definition of view.definitions) {
        if (Object.hasOwn(defaults, definition.key)) definition.default = defaults[definition.key as keyof PromptSettings];
      }
      for (const entry of view.entries) {
        if (entry.source === "default" && Object.hasOwn(defaults, entry.key)) entry.effective = defaults[entry.key as keyof PromptSettings];
      }
      return view;
    });
  }

  #plugins(scope: CapabilityScope): Promise<PluginRuntime> {
    const key = scope.kind === "application" ? "application" : scope.spaceId;
    if (this.#packageReloadRequired.has("application") || this.#packageReloadRequired.has(key))
      return Promise.reject(new RepaFault("plugin_restart_required", "包代码已经变更，请重启后端以使用同一版本的入口和依赖。"));
    const existing = this.#pluginRuntimes.get(key);
    if (existing) return existing;
    const opening = (async () => {
      const view = await this.#configuration.get(scope, "plugins");
      const configuration = Object.fromEntries(view.entries.map(entry => [entry.key, entry.effective])) as PluginSettings;
      const runtime = await PluginRuntime.open({
        cwd: scope.kind === "application" ? this.#appDirectory : this.#store(scope.spaceId).space.path,
        agentDir: this.#options.agentDir, trusted: this.#options.trustExtensions ?? false,
        configuration, plugins: this.#backendPlugins,
        bundledPackages: this.#bundledPackages(configuration),
      });
      for (const definition of runtime.capabilities.settingsDefinitions()) this.#configuration.register(definition);
      return runtime;
    })();
    this.#pluginRuntimes.set(key, opening);
    void opening.catch(() => { if (this.#pluginRuntimes.get(key) === opening) this.#pluginRuntimes.delete(key); });
    return opening;
  }

  #bundledPackages(configuration: PluginSettings): readonly BundledPluginRegistration[] {
    const packages = this.#options.bundledPackages;
    return typeof packages === "function" ? packages(configuration) : packages ?? [];
  }

  async #resetPlugins(scope: SettingScope): Promise<void> {
    const keys = scope.kind === "application" ? [...this.#pluginRuntimes.keys()] : [scope.spaceId];
    const sessions = [...this.#sessions.values()].filter(record => scope.kind === "application" || record.view.spaceId === scope.spaceId);
    await Promise.all(keys.map(async key => (await this.#pluginRuntimes.get(key))?.capabilities.cancel()));
    await Promise.all(sessions.map(record => this.closeSession(record.view)));
    const requests = [...this.#spaces.values()].filter(record => scope.kind === "application" || record.store.space.id === scope.spaceId).map(record => record.processing);
    if (scope.kind === "application" && this.#applicationRequests) requests.push(this.#applicationRequests);
    for (const processing of requests) for (const request of processing.requests.values())
      if (request.operation === "repa.capability.invoke") processing.cancel(request.requestId);
    for (const key of keys) {
      const pending = this.#pluginRuntimes.get(key);
      if (!pending) continue;
      const runtime = await pending;
      await runtime.capabilities.close();
      this.#pluginRuntimes.delete(key);
    }
  }

  async #processing(spaceId?: string): Promise<BackgroundRequests> {
    if (spaceId !== undefined) return this.#space(spaceId).processing;
    if (this.#applicationRequests) return this.#applicationRequests;
    if (this.#openingApplicationRequests) return this.#openingApplicationRequests;
    const opening = (async () => {
      const directory = path.join(this.#appDirectory, "runtime", "processing");
      await mkdir(directory, { recursive: true });
      let compromised: Error | undefined;
      let release: () => Promise<void>;
      try {
        release = await lockfile.lock(directory, { realpath: false, onCompromised: error => {
          compromised = error;
          this.shutdown("cancel");
        } });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOCKED")
          throw new RepaFault("application_runtime_in_use", "另一后端正在管理应用级请求，请连接该后端，或为独立后端指定独立应用目录。");
        throw error;
      }
      try {
        const processing = new BackgroundRequests({
          directory,
          assertOwned: () => { if (compromised) throw new RepaFault("application_lock_lost", "应用级请求的执行归属已经失效。"); },
          changed: request => { this.#emit({ type: "processing", request }); this.#finishIfReady(); },
          ask: (requestId, signal, dialog, options) => this.#interact({ requestId }, signal, dialog, options,
            (id, interaction, receipt) => processing.interaction(requestId, id, interaction, receipt)),
        });
        this.#applicationRequests = processing;
        this.#restoreReplyReceipts(undefined, processing.requests.values());
        this.#releaseApplicationRequests = async () => { if (!compromised) await release(); };
        for (const request of processing.requests.values()) this.#emit({ type: "processing", request });
        return processing;
      } catch (error) {
        await release();
        throw error;
      }
    })();
    this.#openingApplicationRequests = opening;
    try { return await opening; } finally { this.#openingApplicationRequests = undefined; }
  }

  displayCall(method: DisplayMethod, params: DisplayParams<DisplayMethod>, hostId: string): Promise<unknown> {
    const input = structuredClone(params);
    const p = <M extends DisplayMethod>() => input as DisplayParams<M>;
    return this.#activity(async () => {
      switch (method) {
        case "display.open": return this.#display.open(p<"display.open">(), hostId);
        case "display.get": return this.#display.get(p<"display.get">(), hostId);
        case "display.close": await this.#display.close(p<"display.close">(), hostId); return null;
        case "display.readResource": return this.#display.readResource(p<"display.readResource">(), hostId);
        case "display.invoke": return this.#display.invoke(p<"display.invoke">(), hostId);
      }
    }, method === "display.open", input.spaceId);
  }

  describeCapabilities(scope: CapabilityScope): Promise<Result<"capability.describe">> {
    return this.#activity(async () => {
      const runtime = await this.#plugins(scope);
      return { capabilities: runtime.capabilities.list().filter(item => item.scopes.includes(scope.kind)), packages: runtime.packages, issues: runtime.issues };
    }, false, scope.kind === "space" ? scope.spaceId : undefined);
  }

  #capabilityServices(scope: CapabilityScope, source: CapabilitySource, requestId: string, signal: AbortSignal, pluginId: string,
    parent: CapabilityParent): RepaCapabilityServices {
    const owner = `${source.kind === "agent" ? "request" : "processing"}:${requestId}`;
    const content = scope.kind === "space" ? this.#space(scope.spaceId).content : undefined;
    const ask = (dialog: Dialog, options?: DialogOptions) => parent.ask(dialog, {
      ...options,
      signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
    });
    return {
      progress: parent.progress, ask,
      events: { publish: notification => {
        if (!Check(CapabilityNotificationSchema, notification))
          throw new RepaFault("invalid_capability_event", "能力通知的格式标识或字段无效。");
        this.#emit({ type: "capability", event: { ...notification, scope, source, requestId, pluginId } });
      } },
      settings: async namespace => (await this.#readSettings(source.kind === "agent"
        ? { kind: "session", spaceId: source.spaceId, sessionId: source.sessionId } : scope, [namespace]))[0]!,
      ...(scope.kind === "space" ? {
        execution: {
          run: input => this.#execution.run(input, {
            spaceId: scope.spaceId, requestId, source, signal, ask,
            program: this.#programCapabilities(scope, source, requestId, parent),
          }),
        },
        resources: {
          snapshot: async (params: { target: ContentTarget; revision?: string; maxBytes?: number }) => {
            signal.throwIfAborted();
            return content!.readSnapshot(params, owner);
          },
          retain: refs => {
            signal.throwIfAborted();
            content!.retention.retainAdditional(owner, refs);
          },
          create: async (bytes: Uint8Array, mediaType: string) => {
            signal.throwIfAborted();
            const snapshot = Buffer.from(bytes);
            return content!.queue.run(async () => {
              signal.throwIfAborted();
              const resource = { spaceId: scope.spaceId, id: await content!.blobs.put(snapshot), mediaType };
              content!.retention.retainAdditional(owner, [resource]);
              return resource;
            }, signal);
          },
          read: async ref => {
            signal.throwIfAborted();
            content!.retention.retainAdditional(owner, [ref]);
            return content!.blobs.get(ref.id);
          },
        } satisfies NonNullable<RepaCapabilityServices["resources"]>,
        models: {
          complete: async (options: ModelCompleteOptions) => {
            signal.throwIfAborted();
            if (!Check(ModelCompleteOptionsSchema, options))
              throw new RepaFault("invalid_input", "独立模型调用选项无效。");
            const input = structuredClone(options);
            const resolved = await this.#bindModel(scope.spaceId, input);
            return this.#modelCalls.complete({ ...resolved, input: input.input, system: input.system,
              ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
              content: content!, requestId, resourceOwner: owner,
              signal, onCancel: parent.cancel,
              onAttempt: attempt => this.#recordModelAttempt(scope.spaceId, source, requestId, attempt),
            });
          },
        },
        sessions: {
          history: (params: Omit<Params<"session.history">, "spaceId">) => this.history({ ...params, spaceId: scope.spaceId }),
          snapshot: (params: { sessionId: string; revision?: string }) => {
            const snapshot = this.#record({ spaceId: scope.spaceId, sessionId: params.sessionId }).session.snapshot(params.revision);
            return structuredClone({ revision: snapshot.revision, messages: snapshot.messages });
          },
          submit: (params: Submit | Continue) => {
            signal.throwIfAborted();
            if (params.target.spaceId !== scope.spaceId) return Promise.reject(new RepaFault("capability_scope", "会话提交目标不属于本次能力作用域。"));
            return this.submit(params, source.kind === "client" ? source.hostId : this.id, source, signal);
          },
        },
      } : {}),
    };
  }

  packageCall(method: PackageMethod, params: Params<PackageMethod>): Promise<unknown> {
    const submission = structuredClone(params);
    const scope = submission.scope;
    const spaceId = scope.kind === "space" ? scope.spaceId : undefined;
    return this.#activity(async () => {
      const cwd = spaceId ? this.#store(spaceId).space.path : this.#appDirectory;
      const agentDir = this.#options.agentDir ?? getAgentDir();
      const manager = () => new PluginPackages({ cwd, agentDir,
        trusted: this.#options.trustExtensions ?? false });
      if (method === "package.list") {
        const view = await this.#configuration.get(scope, "plugins");
        const configuration = Object.fromEntries(view.entries.map(entry => [entry.key, entry.effective])) as PluginSettings;
        return (await discoverPluginResources({
          cwd, agentDir, configuration, trusted: this.#options.trustExtensions ?? false,
          bundledPackages: this.#bundledPackages(configuration),
        })).catalog;
      }
      if (!("requestId" in submission)) throw new RepaFault("invalid_input", "包管理需要请求标识。");
      const processing = await this.#processing(spaceId);
      const previous = processing.requests.get(submission.requestId);
      const { requestId, ...options } = submission;
      const input: Input = { parts: [{ kind: "text", text: `${method} ${"source" in submission ? submission.source ?? "" : ""}` }] };
      if (!previous) this.#assertAccepting();
      if (spaceId && this.#store(spaceId).requests.requests.has(requestId)) throw new RepaFault("request_id_conflict", "相同标识已用于会话输入。");
      const packageKey = spaceId ?? "application";
      // Pi 的 npm/git 安装根与来源设置按 user/project 共用，不按单个包分别排队。
      const queue = this.#packageOperations.get(packageKey) ?? new SerialQueue();
      this.#packageOperations.set(packageKey, queue);
      return processing.submit({ requestId, operation: method, input, options }, async (_input, context) => queue.run(async () => {
        await this.#admission.run(async () => {
          context.signal.throwIfAborted();
          // 先封锁新装配，避免异步收尾期间重新打开旧代码。
          this.#packageReloadRequired.add(packageKey);
          await this.#resetPlugins(scope);
          context.signal.throwIfAborted();
        }, context.signal);
        context.progress("正在执行 Pi 包管理操作");
        const packages = manager();
        const p = <M extends PackageMethod>() => submission as Params<M>;
        // SDK 操作可能部分完成后报错；开始改包后统一以真实进程重启重载传递依赖。
        let catalog: PluginPackage[];
        switch (method) {
          case "package.install":
            catalog = await packages.install(p<"package.install">().source, { local: scope.kind === "space" });
            break;
          case "package.remove":
            catalog = await packages.remove(p<"package.remove">().source, { local: scope.kind === "space" });
            break;
          case "package.update":
            catalog = await packages.update(p<"package.update">().source, { local: scope.kind === "space" });
            break;
        }
        return { format: { id: "repa.package-operation", version: "1" },
          value: { kind: "inline", data: { packages: catalog, restartRequired: true } }, sources: [], resources: [] };
      }, context.signal));
    }, false, spaceId);
  }

  #capabilityTools(record: SessionRecord, runtime: PluginRuntime): ToolDefinition[] {
    const scope = { kind: "space" as const, spaceId: record.view.spaceId };
    const tools: ToolDefinition[] = [];
    const seen = new Set<string>();
    for (const item of runtime.capabilities.list()) {
      if (!item.tool || !item.scopes.includes("space")) continue;
      const key = JSON.stringify(item.contract);
      if (seen.has(key)) continue;
      seen.add(key);
      let selected;
      try {
        selected = runtime.capabilities.resolve({ contract: item.contract,
          implementationId: runtime.configuration.implementations[item.contract.id] }, scope);
      } catch (error) {
        if (!(error instanceof RepaFault) || error.code !== "capability_selection_required") throw error;
        this.#notice(record, error.code, error.message);
        continue;
      }
      if (!selected.tool) continue;
      const selection = { contract: selected.contract, implementationId: selected.implementationId };
      tools.push({
        name: selected.tool.name, label: selected.tool.name, description: selected.tool.description,
        parameters: (selected.tool.inputSchema ?? selected.inputSchema) as TSchema,
        execute: async (_callId, input, signal) => {
          const prepared = runtime.capabilities.prepareToolInput(selection, input, scope);
          const delivered = await this.#invokeAgentCapability(record, runtime, selection, prepared, signal);
          return { content: [{ type: "text", text: JSON.stringify(delivered.result) }], details: delivered.representation };
        },
      });
    }
    return tools;
  }

  async #invokeAgentCapability(record: SessionRecord, runtime: PluginRuntime, selection: CapabilitySelection, input: unknown, signal?: AbortSignal): Promise<{ result: unknown; representation: ProcessingResult }> {
    const active = record.active;
    if (!active) throw new RepaFault("run_not_active", "能力调用需要实际运行归属。");
    const scope = { kind: "space" as const, spaceId: record.view.spaceId };
    const source: CapabilitySource = { kind: "agent", spaceId: record.view.spaceId, sessionId: record.view.sessionId,
      runId: active.run.id, requestId: active.request.requestId };
    const callSignal = signal ? AbortSignal.any([signal, active.controller.signal]) : active.controller.signal;
    return this.#invokeBoundCapability(runtime, scope, source, active.request.requestId, selection,
      input, callSignal, {
        cancel: () => { this.cancelRun(scope.spaceId, active.run.id); },
        progress: message => this.#notice(record, "capability_progress", message, "info"),
        ask: (dialog, options) => this.#ask(record, dialog, options),
      });
  }

  /** 工具与程序共用调用归属和资源保存，只有工具入口需要补齐隐藏的程序参数。 */
  async #invokeBoundCapability(runtime: PluginRuntime, scope: { kind: "space"; spaceId: string },
    source: CapabilitySource, requestId: string, selection: CapabilitySelection, input: unknown,
    signal: AbortSignal, parent: CapabilityParent): Promise<{ result: unknown; representation: ProcessingResult }> {
    signal.throwIfAborted();
    const content = this.#space(scope.spaceId).content;
    const owner = `${source.kind === "agent" ? "request" : "processing"}:${requestId}`;
    const declarations = runtime.capabilities.resourceDeclarations(selection, scope);
    const submitted = capabilityRepresentation(selection.contract, input, declarations.inputResources(input));
    content.retention.retainAdditional(owner, submitted.resources);
    const result = await runtime.capabilities.invoke(selection, input, {
      scope, source, signal, content,
      services: this.#capabilityServices(scope, source, requestId, signal,
        runtime.capabilities.resolve(selection, scope).pluginId, parent),
    });
    const delivered = capabilityRepresentation(selection.contract, result, declarations.outputResources(result));
    content.retention.retainAdditional(owner, delivered.resources);
    return { result, representation: delivered };
  }

  #programCapabilities(scope: { kind: "space"; spaceId: string }, source: CapabilitySource,
    requestId: string, parent: CapabilityParent): ProgramCapabilities {
    let loading: Promise<PluginRuntime> | undefined;
    const runtime = async (signal: AbortSignal) => {
      signal.throwIfAborted();
      loading ??= this.#plugins(scope);
      const current = await loading;
      signal.throwIfAborted();
      return current;
    };
    return {
      describe: async signal => (await runtime(signal)).capabilities.list().filter(item => item.scopes.includes("space")),
      invoke: async (params, signal) => {
        const current = await runtime(signal);
        const selected = current.capabilities.resolve({
          contract: params.contract,
          implementationId: params.implementationId ?? current.configuration.implementations[params.contract.id],
        }, scope);
        const delivered = await this.#invokeBoundCapability(current, scope, source, requestId,
          { contract: selected.contract, implementationId: selected.implementationId }, params.input, signal, parent);
        return { result: delivered.result, resources: delivered.representation.resources };
      },
    };
  }

  invokeCapability(params: Params<"capability.invoke">, hostId: string): Promise<Result<"capability.invoke">> {
    const submission = structuredClone(params);
    const scope = submission.scope;
    const spaceId = scope.kind === "space" ? scope.spaceId : undefined;
    return this.#activity(async () => {
      const processing = await this.#processing(spaceId);
      const { input: _input, requestId, ...options } = submission;
      const accepted = await this.#admission.run(async () => {
        const previous = processing.requests.get(requestId);
        if (previous) {
          const part = previous.input.parts[0];
          if (previous.operation !== "repa.capability.invoke" || part?.kind !== "data" || part.representation.value.kind !== "inline" ||
            !isDeepStrictEqual(part.representation.value.data, submission.input) || !isDeepStrictEqual(previous.options, options))
            throw new RepaFault("request_id_conflict", "相同请求标识已经用于另一项能力调用。");
          const saved = previous.configuration as { execution: "inline" | "background" };
          return { execution: saved.execution, request: structuredClone(previous) };
        }
        this.#assertAccepting();
        if (spaceId && this.#store(spaceId).requests.requests.has(requestId)) throw new RepaFault("request_id_conflict", "相同标识已用于会话输入。");
        const runtime = await this.#plugins(scope);
        const selection: CapabilitySelection = { contract: submission.contract,
          implementationId: submission.implementationId ?? runtime.configuration.implementations[submission.contract.id] };
        const definition = runtime.capabilities.resolve(selection, scope);
        const bound = { contract: definition.contract, implementationId: definition.implementationId };
        if (definition.execution === "query") {
          return { execution: "query" as const, result: runtime.capabilities.invoke(bound, submission.input, {
            scope, source: { kind: "client", hostId }, signal: new AbortController().signal,
            ...(spaceId ? { content: this.#space(spaceId).content } : {}),
            services: { settings: async (namespace: string) => (await this.#readSettings(scope, [namespace]))[0]! },
          }) };
        }
        const declarations = runtime.capabilities.resourceDeclarations(bound, scope);
        const input: Input = { parts: [{ kind: "data", representation: capabilityRepresentation(
          definition.contract, submission.input, declarations.inputResources(submission.input),
        ) }] };
        const request = processing.submit({ requestId, operation: "repa.capability.invoke", input, options,
          configuration: { ...bound, pluginId: definition.pluginId, execution: definition.execution, source: { kind: "client", hostId } } }, async (_input, context) => {
          const source = { kind: "client" as const, hostId };
          const result = await runtime.capabilities.invoke(bound, submission.input, {
            scope, source, signal: context.signal,
            ...(context.content ? { content: context.content } : {}),
            services: this.#capabilityServices(scope, source, requestId, context.signal, definition.pluginId, {
              cancel: () => { processing.cancel(requestId); }, progress: context.progress, ask: context.ask,
            }),
          });
          return capabilityRepresentation(definition.contract, result, declarations.outputResources(result));
        });
        return { execution: definition.execution, request };
      });
      if (accepted.execution === "query") return { kind: "inline", requestId, result: await accepted.result };
      if (accepted.execution === "background") return { kind: "background", request: accepted.request };
      await processing.settled(requestId);
      const finished = processing.get(requestId);
      if (finished.status !== "completed" || finished.result?.value.kind !== "inline")
        throw new RepaFault(finished.error?.code ?? finished.status, finished.error?.message ?? "能力调用没有完成。", { requestId });
      return { kind: "inline", requestId, result: finished.result.value.data };
    }, false, spaceId);
  }
  #checkScope(scope: SettingScope): void {
    if (scope.kind !== "application") this.#store(scope.spaceId).assertOwned();
    if (scope.kind === "session") this.#record(scope);
  }
  runExecution(params: Params<"execution.run">, hostId: string): Promise<BackgroundRequest> {
    const submission = structuredClone(params);
    return this.#activity(() => this.#admission.run(async () => {
      const { spaceId, requestId, ...command } = submission;
      const record = this.#space(spaceId);
      if (record.store.requests.requests.has(requestId))
        throw new RepaFault("request_id_conflict", "相同请求标识已用于会话请求。");
      if (!record.processing.requests.has(requestId)) this.#assertAccepting();
      const scope = { kind: "space" as const, spaceId };
      const source: CapabilitySource = { kind: "client", hostId };
      return record.processing.submit({ requestId, operation: "execution.run",
        input: { parts: [{ kind: "text", text: command.command }] }, options: { scope, ...command },
        configuration: { source },
      }, async (_input, context) => {
        const result = await this.#execution.run(command, { spaceId, requestId, source,
          signal: context.signal, ask: context.ask,
          program: this.#programCapabilities(scope, source, requestId, {
            cancel: () => { record.processing.cancel(requestId); },
            progress: context.progress,
            ask: context.ask,
          }),
        });
        return executionRepresentation(result);
      });
    }), false, submission.spaceId);
  }

  inspectExecution(params: Params<"execution.inspect">): Promise<Result<"execution.inspect">> {
    return this.#activity(async () => ({ ...await this.#execution.policy(params.spaceId),
      active: this.#execution.list(params.spaceId) }), false, params.spaceId);
  }

  #agentExecutionContext(record: SessionRecord, signal?: AbortSignal): ExecutionContext {
    const active = record.active;
    if (!active) throw new RepaFault("run_not_active", "命令执行需要实际运行归属。");
    const { spaceId, sessionId } = record.view;
    const source: CapabilitySource = { kind: "agent", spaceId, sessionId, runId: active.run.id, requestId: active.request.requestId };
    return { spaceId, requestId: active.request.requestId,
      source,
      signal: signal ? AbortSignal.any([signal, active.controller.signal]) : active.controller.signal,
      ask: (dialog, options) => this.#ask(record, dialog, options),
      program: this.#programCapabilities({ kind: "space", spaceId }, source, active.request.requestId, {
        cancel: () => { this.cancelRun(spaceId, active.run.id); },
        progress: message => this.#notice(record, "capability_progress", message, "info"),
        ask: (dialog, options) => this.#ask(record, dialog, options),
      }),
    };
  }

  settingsCall(method: "settings.get" | "settings.set" | "settings.reset", params: Params<"settings.get" | "settings.set" | "settings.reset">): Promise<unknown> {
    const input = structuredClone(params);
    return this.#activity(async () => {
      this.#checkScope(input.scope);
      const scope: CapabilityScope = input.scope.kind === "application" ? input.scope : { kind: "space", spaceId: input.scope.spaceId };
      if (!["prompts", "runtime", "summaryPrompts", "plugins", "execution", "spaces"].includes(input.namespace)) await this.#plugins(scope);
      if (method === "settings.get") return (await this.#readSettings(input.scope, [input.namespace]))[0];
      const save = async () => {
        const view = method === "settings.set"
          ? await this.#configuration.set(input as Params<"settings.set">)
          : await this.#configuration.reset(input as Params<"settings.reset">);
        if (input.namespace === "plugins") await this.#resetPlugins(input.scope);
        if (input.namespace === "execution") await this.#execution.refresh();
        this.#emit({ type: "settings", scope: input.scope, namespace: input.namespace });
        return view.namespace === "prompts" ? (await this.#readSettings(input.scope, [input.namespace]))[0] : view;
      };
      return input.namespace === "plugins" ? this.#admission.run(save) : save();
    }, method !== "settings.get", input.scope.kind === "application" ? undefined : input.scope.spaceId);
  }

  previewPrompts(target: SessionKey): Promise<Result<"prompts.preview">> {
    return this.#activity(async () => {
      this.#checkScope({ kind: "session", ...target });
      const settings = await this.#readSettings({ kind: "session", ...target }, ["prompts", "runtime", "summaryPrompts", "plugins"]);
      const plugins = Object.fromEntries(settings[3]!.entries.map(entry => [entry.key, entry.effective])) as PluginSettings;
      const selected = Object.fromEntries(settings[0]!.entries.map(entry => [entry.key, entry.effective])) as PromptSettings;
      const runtime = Object.fromEntries(settings[1]!.entries.map(entry => [entry.key, entry.effective])) as RuntimeSettings;
      const resources = await discoverPluginResources({ cwd: this.#store(target.spaceId).space.path,
        agentDir: this.#options.agentDir, trusted: this.#options.trustExtensions ?? false, configuration: plugins,
        bundledPackages: this.#bundledPackages(plugins) });
      const dynamicTools = [
        ...resources.bundledPackages.filter(({ registration, package: item }) =>
          registration.enabled && item.status === "ready" && item.backend?.status === "ready").map(({ registration }) => registration.id),
        ...this.#backendPlugins.filter(plugin => plugin.enabled && !plugins.disabled.includes(plugin.id)).map(plugin => plugin.id),
        ...plugins.backends.flatMap(plugin => {
          if (plugins.disabled.includes(plugin.id)) return [];
          try {
            selectBackendEntry(resources, plugin.package, plugins, this.#options.trustExtensions ?? false);
            return [plugin.id];
          } catch (error) {
            if (error instanceof RepaFault) return [];
            throw error;
          }
        }),
      ];
      const prompt = await previewPrompt({
        content: this.#space(target.spaceId).content, agentDir: this.#options.agentDir,
        backgroundSources: this.#contributions.backgrounds(plugins, { content: this.#space(target.spaceId).content }),
        trusted: this.#options.trustExtensions ?? false, settings: selected,
        resourceSettings: snapshotSettings(resources.snapshots, this.#options.trustExtensions ?? false),
        additionalSkills: resources.additionalSkills, missingPackages: resources.missingPackages,
        additionalTools: [
          this.#execution.createTool(this.#store(target.spaceId).space.path, signal => this.#agentExecutionContext(this.#record(target), signal)),
          ...(!plugins.disabled.includes(SEARCH_PLUGIN_ID) ? SEARCH_TOOLS : []),
        ],
        dynamicTools, dynamicExtensions: resources.additionalExtensions.length > 0,
        ...(runtime.tools ? { tools: runtime.tools } : {}),
      });
      for (const entry of settings[2]!.entries) prompt.sources.push({
        id: `summary.${entry.key}`, enabled: true,
        ...(typeof entry.effective === "string" ? { content: entry.effective } : { dynamic: true, reference: "pi.compaction" }),
      });
      return { prompt, settings };
    }, false, target.spaceId);
  }

  modelCall(method: ModelMethod, params: ModelParams<ModelMethod>): Promise<unknown> {
    const input = structuredClone(params);
    const p = <M extends ModelMethod>() => input as ModelParams<M>;
    return this.#activity(async () => {
      switch (method) {
        case "connection.list": return this.#models.list();
        case "connection.get": return this.#models.get(p<"connection.get">().connectionId);
        case "connection.create": return this.#models.create(p<"connection.create">());
        case "connection.update": {
          const value = p<"connection.update">();
          return this.#models.update(value.connectionId, value.base, value.input);
        }
        case "connection.remove": {
          const value = p<"connection.remove">();
          return this.#admission.run(async () => {
            const current = await this.#models.get(value.connectionId);
            if (current.revision !== value.base) throw new RepaFault("conflict", "模型连接已修改，请重新读取。");
            await this.#cancelConnectionWork(value.connectionId);
            return this.#models.remove(value.connectionId, value.base);
          });
        }
        case "model.list": return this.#models.models(p<"model.list">().connectionId);
        case "auth.start": {
          const value = p<"auth.start">();
          const login = await this.#models.authStart(value.connectionId, value.type);
          void this.#models.settled().then(() => this.#finishIfReady());
          return login;
        }
        case "auth.get": return this.#models.authGet(p<"auth.get">().loginId);
        case "auth.reply": {
          const value = p<"auth.reply">();
          return this.#models.authReply(value.loginId, value.challengeId, value.value);
        }
        case "auth.cancel": return this.#models.authCancel(p<"auth.cancel">().loginId);
        case "auth.logout": {
          const value = p<"auth.logout">();
          return this.#admission.run(async () => {
            await this.#cancelConnectionWork(value.connectionId);
            return this.#models.authLogout(value.connectionId);
          });
        }
      }
    }, !["connection.list", "connection.get", "model.list", "auth.get", "auth.reply", "auth.cancel"].includes(method));
  }

  async #cancelConnectionWork(connectionId: string): Promise<void> {
    const affected = [...this.#sessions.values()].filter(record => {
      const options = record.active?.request.runOptions;
      return [options?.connection ?? record.binding, ...options?.fallback?.models ?? []]
        .some(binding => binding?.connection.id === connectionId);
    });
    await Promise.all([
      ...affected.map(record => this.closeSession(record.view)),
      this.#modelCalls.cancel(connectionId),
    ]);
  }

  #recordModelAttempt(spaceId: string, source: CapabilitySource, requestId: string, attempt: ModelAttempt): void {
    if (source.kind === "agent") {
      const record = this.#record({ spaceId, sessionId: source.sessionId });
      const request = record.store.requests.get(requestId);
      this.#saveRequest(record, { ...request, modelAttempts: updateModelAttempts(request.modelAttempts ?? [], attempt) });
    } else this.#space(spaceId).processing.recordModelAttempt(requestId, attempt);
  }

  async #bindModel(spaceId: string, options: Pick<Params<"model.complete">, "model" | "thinkingLevel" | "fallback">) {
    const { binding, model, fallback } = await this.#models.bind(options.model, options.fallback);
    const view = await this.#configuration.get({ kind: "space", spaceId }, "runtime");
    const configured = Object.fromEntries(view.entries.map(entry => [entry.key, entry.effective])) as RuntimeSettings;
    const sdk = sessionSettings(this.#store(spaceId).space.path, this.#options.agentDir, this.#options.trustExtensions ?? false);
    return { binding, ...(fallback ? { fallback } : {}), retry: configured.retry ?? sdk.getRetrySettings(),
      thinkingLevel: options.thinkingLevel ?? configured.thinkingLevel ?? defaultThinkingLevel(sdk, model) };
  }

  completeModel(params: Params<"model.complete">): Promise<BackgroundRequest> {
    const { spaceId, requestId, input, ...options } = structuredClone(params);
    return this.#activity(() => this.#admission.run(async () => {
      const record = this.#space(spaceId);
      const previous = record.processing.requests.get(requestId);
      if (previous) {
        if (previous.operation !== "repa.model.complete" || !isDeepStrictEqual(previous.input, input) || !isDeepStrictEqual(previous.options, options))
          throw new RepaFault("request_id_conflict", "相同请求标识已用于另一项处理。");
        return structuredClone(previous);
      }
      this.#assertAccepting();
      if (record.store.requests.requests.has(requestId)) throw new RepaFault("request_id_conflict", "相同标识已用于会话输入。");
      const { binding, fallback, retry, thinkingLevel } = await this.#bindModel(spaceId, options);
      this.#assertAccepting();
      return record.processing.submit({
        requestId, operation: "repa.model.complete", input, options,
        configuration: { connection: binding, ...(fallback ? { fallback } : {}), system: options.system, thinkingLevel, retry, maxTokens: options.maxTokens },
      }, (submitted, context) => this.#modelCalls.complete({
        binding, fallback, input: submitted, content: record.content, requestId, resourceOwner: `processing:${requestId}`,
        system: options.system, thinkingLevel, retry, maxTokens: options.maxTokens, signal: context.signal,
        onCancel: () => { record.processing.cancel(requestId); },
        onAttempt: attempt => record.processing.recordModelAttempt(requestId, attempt),
      }));
    }), false, spaceId);
  }

  async #resolveConfiguration(target: SessionKey, selection?: Submit["selection"]): Promise<{
    promptSettings: PromptSettings;
    runOptions: RunOptions;
  }> {
    const views = await this.#readSettings({ kind: "session", ...target }, ["prompts", "runtime", "summaryPrompts"]);
    const values = (namespace: string) => Object.fromEntries(views.find(view => view.namespace === namespace)!.entries.map(entry => [entry.key, entry.effective]));
    const prompts = values("prompts") as PromptSettings;
    const runtime = values("runtime") as RuntimeSettings;
    const summaryPrompts = values("summaryPrompts") as SummaryPrompts;
    const chosen = selection?.model ?? runtime.model;
    const fallback = selection && Object.hasOwn(selection, "fallback") ? selection.fallback : runtime.fallback;
    if (fallback && !chosen) throw new RepaFault("configuration", "模型回退策略需要明确的主模型连接。");
    const resolved = chosen ? await this.#models.bind(chosen, fallback ?? undefined) : undefined;
    const connection = resolved?.binding;
    const sdk = sessionSettings(this.#store(target.spaceId).space.path, this.#options.agentDir, this.#options.trustExtensions ?? false);
    const model = connection ? { provider: connection.connection.provider, id: connection.modelId,
      ...(connection.connection.baseUrl ? { baseUrl: connection.connection.baseUrl } : {}) } : undefined;
    const sdkThinking = resolved ? defaultThinkingLevel(sdk, resolved.model) : "off";
    const thinkingLevel = selection?.thinkingLevel ?? runtime.thinkingLevel ?? sdkThinking;
    const tools = selection?.tools ?? runtime.tools;
    return {
      promptSettings: selection?.prompts ?? prompts,
      runOptions: {
        ...(connection ? { connection, model } : {}),
        ...(resolved?.fallback ? { fallback: resolved.fallback } : {}),
        thinkingLevel,
        ...(tools !== null ? { tools } : {}),
        compaction: selection?.compaction ?? runtime.compaction ?? sdk.getCompactionSettings(model),
        retry: selection?.retry ?? runtime.retry ?? sdk.getRetrySettings(),
        summaryPrompts: selection?.summaryPrompts ?? summaryPrompts,
        sources: views.flatMap(view => view.entries.map(entry => ({
          namespace: view.namespace, key: entry.key,
          source: (view.namespace === "prompts" && selection?.prompts) ||
            (view.namespace === "summaryPrompts" && selection?.summaryPrompts) ||
            (view.namespace === "runtime" && selection && Object.hasOwn(selection, entry.key))
            ? "request" as const : entry.source,
        }))),
      },
    };
  }
  contentResource(spaceId: string, id: string): Promise<Buffer> {
    return this.#activity(async () => {
      const record = this.#spaces.get(spaceId);
      if (!record) throw new RepaFault("not_found", "学习空间尚未打开。");
      return record.content.blobs.get(id);
    }, false);
  }
  uploadResource(spaceId: string, bytes: Uint8Array, mediaType: string, host: string = this.id): Promise<import("./content/schema.js").ResourcePreparation> {
    return this.#activity(async () => {
      const record = this.#spaces.get(spaceId);
      if (!record) throw new RepaFault("not_found", "学习空间尚未打开。");
      return record.content.upload(bytes, mediaType, host);
    }, true, spaceId);
  }
  checkpointResources(): void {
    for (const record of this.#spaces.values()) {
      try { record.content.retention.checkpoint(); }
      catch { /* 活跃连接的持有仍参与回收判定，已有落盘租约用于恢复。 */ }
    }
  }

  #assertSpaceAvailable(spaceId: string): void {
    if (this.#maintenance.has(spaceId)) throw new RepaFault("space_busy", "空间正在生成快照，完成后可继续操作。");
  }
  spaceCall(method: SpaceMethod, params: Params<SpaceMethod>): Promise<unknown> {
    const input = structuredClone(params);
    const p = <M extends SpaceMethod>() => input as Params<M>;
    if (method === "space.open") return this.openSpace(p<"space.open">().path);
    return this.#activity(async () => {
      if (method === "space.list") return this.listSpaces();
      if (method === "space.browse") return browseDirectory(p<"space.browse">());
      if (method === "space.recent") return this.#recentSpaces.list(p<"space.recent">().limit);
      if (method === "space.create") {
        const settings = await this.#configuration.get({ kind: "application" }, "spaces");
        const parent = settings.entries.find(entry => entry.key === "parentDirectory")?.effective;
        if (typeof parent !== "string")
          throw new RepaFault("parent_directory_required", "请先设置学习空间的父目录。");
        const directory = await createSpaceDirectory(parent, p<"space.create">().hint);
        return this.openSpace(directory);
      }
      if (method === "space.operation.get") return this.#spaceOperations.get(p<"space.operation.get">().operationId);
      if (method === "space.restore") return this.#spaceOperations.restore(p<"space.restore">());
      const request = p<"space.copy">();
      this.#assertSpaceAvailable(request.spaceId);
      const record = this.#spaces.get(request.spaceId);
      if (!record) throw new RepaFault("not_found", "学习空间尚未打开。");
      if (record.processing.active || this.#spaceActivities.get(request.spaceId) || [...this.#sessions.values()].some(session =>
        session.store === record.store && (session.active || session.opening || session.closing || session.deleting)))
        throw new RepaFault("space_busy", "空间仍有任务或保存正在执行，完成后可生成快照。");
      record.store.assertOwned();
      this.#maintenance.add(request.spaceId);
      try {
        return await this.#spaceOperations.capture({ ...request, source: record.store.space.path,
          kind: method === "space.backup" ? "backup" : "copy" }, record.content,
          [...this.#options.snapshotParticipants ?? [], ...await (await this.#plugins({ kind: "space", spaceId: record.store.space.id })).snapshotParticipants()]);
      } finally { this.#maintenance.delete(request.spaceId); }
    }, !["space.list", "space.browse", "space.recent", "space.operation.get"].includes(method));
  }

  #space(id: string): SpaceRecord {
    const record = this.#spaces.get(id);
    if (!record) throw new RepaFault("not_found", "学习空间尚未打开。");
    return record;
  }
  #store(id: string): RuntimeStore { return this.#space(id).store; }
  #record(key: SessionKey): SessionRecord {
    const record = this.#sessions.get(keyOf(key));
    if (!record)
      throw new RepaFault("not_found", "会话不存在或所属学习空间尚未打开。");
    return record;
  }
  #register(store: RuntimeStore, session: StoredSession): SessionRecord {
    const key = { spaceId: store.space.id, sessionId: session.id };
    const existing = this.#sessions.get(keyOf(key));
    if (existing) return existing;
    const record = this.#prepareSession(store, session);
    this.#sessions.set(keyOf(key), record);
    this.#emit({ type: "session", session: record.view });
    return record;
  }

  #prepareSession(store: RuntimeStore, session: StoredSession): SessionRecord {
    const key = { spaceId: store.space.id, sessionId: session.id };
    const stored = session.snapshot();
    const { messages, createdAt } = stored;
    const firstUser = messages
      .find((x) => x.role === "user")
      ?.content.find((x) => x.type === "text");
    const runs = [...store.runs.values()].filter(
      (x) => x.sessionId === key.sessionId,
    );
    const view: SessionView = {
      ...key,
      title:
        stored.name ??
        (firstUser?.type === "text"
          ? firstUser.text.slice(0, 120)
          : (runs[0]?.text.slice(0, 120) ?? "新会话")),
      createdAt,
      updatedAt: runs.reduce(
        (latest, run) => Math.max(latest, run.finishedAt ?? run.createdAt),
        messages.reduce(
          (latest, message) => Math.max(latest, message.timestamp),
          createdAt,
        ),
      ),
      runtime: "unloaded",
      messages,
      runs,
      interactions: [],
      notices: [],
    };
    const record: SessionRecord = { store, session, view };
    for (const request of store.requests.list(session.id)) {
      const entered = messages.filter(message => message.requestId === request.requestId).map(message => message.id);
      const run = request.runId ? store.runs.get(request.runId) : undefined;
      if (request.status === "queued") store.requests.pause(session.id, true);
      const restored = structuredClone(request);
      if (request.status === "running") restored.status = run && isTerminal(run) ? run.status : "interrupted";
      if (request.modelAttempts) restored.modelAttempts = interruptModelAttempts(request.modelAttempts);
      if (entered.length) restored.delivery = { status: "entered", messageIds: entered };
      else if (request.delivery.status === "entered" && request.delivery.messageIds.every(id => messages.some(message => message.id === id))) {
        restored.delivery = request.delivery;
      } else if (request.status === "queued") restored.delivery = { status: "pending" };
      else restored.delivery = { status: "not_entered", reason: "当前历史中没有该输入的持久记录。" };
      if (restored.status === "interrupted") store.requests.pause(session.id, true);
      if (!isDeepStrictEqual(restored, request)) store.requests.save(restored);
    }
    for (const request of store.requests.list(session.id)) {
      if ("previousRequestId" in request.submission && request.delivery.status === "entered") {
        const previous = store.requests.requests.get(request.submission.previousRequestId);
        if (previous && previous.delivery.status !== "entered") store.requests.save({ ...previous, delivery: request.delivery });
      }
    }
    for (const run of runs) {
      const requests = store.requests.list(session.id).filter(request => request.runId === run.id);
      run.requestIds = requests.map(request => request.requestId);
      run.options = requests[0]?.runOptions;
    }
    return record;
  }

  createSession(spaceId: string): SessionView {
    this.#assertAccepting();
    this.#assertSpaceAvailable(spaceId);
    const store = this.#store(spaceId);
    store.assertOwned();
    return structuredClone(
      this.#register(store, this.#spaces.get(spaceId)!.sessions.create()).view,
    );
  }
  listSessions(spaceId: string): SessionSummary[] {
    this.#store(spaceId);
    return structuredClone(
      this.#state.sessions
        .filter((x) => x.spaceId === spaceId)
        .sort(
          (a, b) =>
            b.updatedAt - a.updatedAt ||
            b.createdAt - a.createdAt ||
            a.sessionId.localeCompare(b.sessionId),
        )
        .map(
          ({
            spaceId,
            sessionId,
            title,
            createdAt,
            updatedAt,
            runtime,
            runs,
          }) => {
            const activeRun = runs.findLast((run) => !isTerminal(run));
            return {
              spaceId,
              sessionId,
              title,
              createdAt,
              updatedAt,
              runtime,
              ...(activeRun ? { activeRun } : {}),
            };
          },
        ),
    );
  }
  getSession(key: SessionKey): SessionView {
    return this.#sessionView(this.#record(key).view, true);
  }

  #sessionView(view: SessionView, history: boolean): SessionView {
    return structuredClone({ ...view, messages: history ? view.messages.slice(-100) : [], runs: history ? view.runs.slice(-100) : view.runs.filter(run => !isTerminal(run)) });
  }

  history(params: Params<"session.history">): Result<"session.history"> {
    if (params.before !== undefined && params.around !== undefined)
      throw new RepaFault("invalid_input", "历史分页和原位定位不能同时指定。");
    const { messages, revision } = this.#record(params).session.snapshot(params.revision);
    const limit = params.limit ?? 100;
    let end = params.before === undefined ? messages.length : messages.findIndex(message => message.id === params.before);
    if (end < 0) throw new RepaFault("invalid_cursor", "历史分页位置不属于所选会话历史。");
    let start = Math.max(0, end - limit);
    if (params.around !== undefined) {
      const index = messages.findIndex(message => message.id === params.around);
      if (index < 0) throw new RepaFault("invalid_cursor", "历史定位消息不属于所选会话历史。");
      start = Math.max(0, Math.min(index - Math.floor(limit / 2), messages.length - limit));
      end = Math.min(messages.length, start + limit);
    }
    return structuredClone({ revision, messages: messages.slice(start, end), ...(start > 0 ? { before: messages[start]!.id } : {}) });
  }
  branchSession(params: Params<"session.branch">): SessionView {
    this.#assertAccepting();
    this.#assertSpaceAvailable(params.spaceId);
    const source = this.#record(params);
    source.store.assertOwned();
    return structuredClone(
      this.#register(source.store, source.session.branch(params.messageId))
        .view,
    );
  }

  submit(params: Submit | Continue, hostId: string = this.id, source: CapabilitySource = { kind: "client", hostId }, signal?: AbortSignal): Promise<RequestRecord> {
    const input = structuredClone(params);
    return this.#activity(() => this.#admission.run(() => this.#submit(input, source, signal), signal), false, input.target.spaceId);
  }

  async #submit(submission: Submit | Continue, source: CapabilitySource, signal?: AbortSignal): Promise<RequestRecord> {
    const { target, requestId } = submission;
    const store = this.#store(target.spaceId);
    if (this.#spaces.get(target.spaceId)?.processing.requests.has(requestId))
      throw new RepaFault("request_id_conflict", "相同标识已用于后台处理。");
    const old = store.requests.requests.get(requestId);
    if (old) {
      if (!isDeepStrictEqual(old.submission, submission))
        throw new RepaFault("request_id_conflict", "相同请求标识已用于另一项输入。");
      return structuredClone(old);
    }
    this.#assertAccepting();
    const record = this.#record(target);
    let input = submission.input;
    const dispatch = "dispatch" in submission ? submission.dispatch : { kind: record.active ? "queue" as const : "start" as const };
    if ("previousRequestId" in submission) {
      const previous = store.requests.requests.get(submission.previousRequestId);
      if (!previous || previous.target.sessionId !== target.sessionId)
        throw new RepaFault("not_found", "原请求不属于该会话。");
      const run = previous.runId ? this.getRun(target.spaceId, previous.runId) : undefined;
      if (previous.status !== "not_entered" && !["failed", "cancelled", "interrupted"].includes(run?.status ?? previous.status))
        throw new RepaFault("request_not_failed", "只有未完成的任务需要接续。");
      input = this.#continuationInput(previous, input);
    }
    if (!input || !input.parts.length || input.parts.every(part => part.kind === "text" && !part.text.trim()))
      throw new RepaFault("invalid_input", "输入不能为空。");
    if (dispatch.kind === "steer" && submission.selection)
      throw new RepaFault("invalid_input", "运行中补充沿用目标运行配置。");
    const resolved = dispatch.kind === "steer"
      ? { promptSettings: record.active?.request.promptSettings ?? await this.#configuration.prompts({ kind: "session", ...target }),
          runOptions: record.active?.request.runOptions ?? {} }
      : await this.#resolveConfiguration(target, submission.selection);
    signal?.throwIfAborted();
    this.#assertAccepting();
    store.assertOwned();
    if (record.closing || record.deleting || (dispatch.kind === "start" &&
      (record.active || (!store.requests.paused.has(target.sessionId) && this.queue(target).requests.length))))
      throw new RepaFault("session_busy", "会话正在运行、关闭或已有待执行请求。");
    const request: RequestRecord = {
      requestId, target, submission, input, createdAt: Date.now(), sequence: store.requests.nextSequence(),
      source: structuredClone(source), ...resolved,
      status: "queued", delivery: { status: "pending" },
    };
    const content = this.#space(target.spaceId).content;
    content.retention.retain(`request:${requestId}`, inputResources(input));
    try { store.requests.save(request); }
    catch (error) {
      content.retention.releaseOwner(`request:${requestId}`);
      throw error;
    }
    this.#diagnoseAccepted(request);
    if (dispatch.kind === "steer") {
      const active = record.active;
      if (!active || active.run.id !== dispatch.expectedRunId || active.controller.signal.aborted) {
        request.status = "not_entered";
        request.delivery = { status: "not_entered", reason: "目标运行已改变或结束。" };
        this.#saveRequest(record, request);
      } else {
        request.runId = active.run.id;
        request.status = "running";
        this.#saveRequest(record, request);
        this.#updateRun(active, { requestIds: [...(active.run.requestIds ?? []), requestId] });
        const delivery = this.#steer(record, active, request);
        active.deliveries.push(delivery);
      }
    } else if (dispatch.kind === "start") this.#start(record, request);
    else this.#pump(record);
    this.#emitQueue(record);
    return store.requests.get(requestId);
  }

  #saveRequest(record: SessionRecord, request: RequestRecord): void {
    const previous = record.store.requests.requests.get(request.requestId);
    record.store.requests.save(request);
    if (previous && (previous.status !== request.status || previous.runId !== request.runId)) {
      this.diagnostics.record(request.error ? "error" : "info", "request.state", {
        ...request.target, requestId: request.requestId, runId: request.runId,
        status: request.status, code: request.error?.code,
      });
    }
    this.#emit({ type: "request", request });
  }

  #diagnoseAccepted(request: RequestRecord): void {
    this.diagnostics.record("info", "request.accepted", {
      ...request.target, requestId: request.requestId, submittedAt: request.createdAt,
      textLength: request.input.parts.reduce((length, part) => length + ("text" in part ? part.text.length : 0), 0),
      partCount: request.input.parts.length,
    });
  }

  getRequest(spaceId: string | undefined, requestId: string): Promise<RequestRecord | BackgroundRequest | { requestId: string; status: "unknown" }> {
    return this.#activity(async () => structuredClone((spaceId ? this.#store(spaceId).requests.requests.get(requestId) : undefined) ??
      (await this.#processing(spaceId)).requests.get(requestId) ?? { requestId, status: "unknown" }), false, spaceId);
  }

  /** 已装配能力提交独立处理；公共能力发现与分发由插件宿主持有。 */
  process(params: { spaceId: string; requestId: string; operation: string; input: Input }, execute: (input: Input, context: ProcessingContext) => Promise<ProcessingResult>): Promise<BackgroundRequest> {
    const submission = structuredClone(params);
    return this.#activity(async () => {
      const record = this.#spaces.get(submission.spaceId);
      if (!record) throw new RepaFault("not_found", "学习空间尚未打开。");
      if (record.store.requests.requests.has(submission.requestId)) throw new RepaFault("request_id_conflict", "相同标识已用于会话输入。");
      if (!record.processing.requests.has(submission.requestId)) this.#assertAccepting();
      return record.processing.submit(submission, execute);
    }, false, submission.spaceId);
  }

  cancelRequest(spaceId: string | undefined, requestId: string): Promise<BackgroundRequest> {
    return this.#activity(async () => (await this.#processing(spaceId)).cancel(requestId), false, spaceId);
  }

  queue(target: SessionKey): QueueView {
    const record = this.#record(target);
    return structuredClone({ target: { spaceId: target.spaceId, sessionId: target.sessionId }, status: record.store.requests.paused.has(target.sessionId) ? "paused" : "running",
      requests: record.store.requests.list(target.sessionId).filter(request => request.status === "queued") });
  }

  #emitQueue(record: SessionRecord): void {
    this.#emit({ type: "queue", queue: this.queue(record.view) });
  }

  resumeQueue(target: SessionKey): QueueView {
    this.#assertAccepting();
    this.#assertSpaceAvailable(target.spaceId);
    const record = this.#record(target);
    record.store.requests.pause(target.sessionId, false);
    this.#pump(record);
    this.#emitQueue(record);
    return this.queue(target);
  }

  cancelQueued(target: SessionKey, requestId: string): RequestRecord {
    this.#assertSpaceAvailable(target.spaceId);
    const record = this.#record(target);
    const request = record.store.requests.requests.get(requestId);
    if (!request || request.target.sessionId !== target.sessionId) throw new RepaFault("not_found", "排队请求不存在。");
    if (request.status === "cancelled") return structuredClone(request);
    if (request.status !== "queued") throw new RepaFault("request_started", "请求已离开队列，请查询其运行。");
    this.#saveRequest(record, { ...request, status: "cancelled", delivery: { status: "not_entered", reason: "排队请求已取消。" } });
    this.#emitQueue(record);
    return record.store.requests.get(requestId);
  }

  #pump(record: SessionRecord): void {
    if (record.active || record.closing || record.deleting || this.#finishing ||
      this.#state.lifecycle === "stopping" || record.store.requests.paused.has(record.view.sessionId)) return;
    const request = this.queue(record.view).requests[0];
    if (request) this.#start(record, request);
  }

  #continuationInput(previous: RequestRecord, supplement?: Input): Input {
    const parts = previous.delivery.status === "entered"
      ? [{ kind: "text" as const, text: `继续此前未完成的任务，原输入已在历史消息 ${previous.delivery.messageIds.join(", ")} 中。根据当前历史和文件继续。` }]
      : previous.input.parts;
    return { parts: [...parts, ...(supplement?.parts ?? [])] };
  }

  #start(record: SessionRecord, request: RequestRecord): void {
    if ("previousRequestId" in request.submission) {
      request = { ...request, input: this.#continuationInput(record.store.requests.get(request.submission.previousRequestId), request.submission.input) };
    }
    const run: Run = {
      id: randomUUID(), ...request.target, text: inputText(request.input), requestIds: [request.requestId],
      status: "accepted", phase: "preparing", createdAt: Date.now(), promptSettings: request.promptSettings, options: request.runOptions,
    };
    record.store.saveRun(run);
    this.#saveRequest(record, { ...request, runId: run.id, status: "running" });
    record.view.updatedAt = run.createdAt;
    if (!record.view.messages.length && !record.view.runs.length) record.view.title = run.text.slice(0, 120);
    let resolveReady = () => {};
    const ready = new Promise<void>(resolve => { resolveReady = resolve; });
    const active: ActiveRun = { run, request, controller: new AbortController(), done: Promise.resolve(), deliveries: [], ready, resolveReady };
    record.active = active;
    this.diagnostics.record("info", "run.started", {
      ...request.target, requestId: request.requestId, runId: run.id, submittedAt: request.createdAt,
    });
    active.done = Promise.resolve().then(() => this.#execute(record, active));
    this.#emit({ type: "session", session: record.view });
    this.#emit({ type: "run", run });
  }

  async #steer(record: SessionRecord, active: ActiveRun, request: RequestRecord): Promise<void> {
    try {
      await active.ready;
      const input = await prepareInput(request.input, this.#space(request.target.spaceId).content, request.requestId);
      if (active.controller.signal.aborted || record.active !== active || !record.host ||
        !await record.host.steer(request.requestId, input)) {
        this.#saveRequest(record, { ...request, status: "not_entered", delivery: { status: "not_entered", reason: "目标运行已停止接收输入。" } });
      }
    } catch (error) {
      this.diagnostics.record("error", "input.failed", {
        ...request.target, requestId: request.requestId, runId: active.run.id,
        code: error instanceof RepaFault ? error.code : "runtime",
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
      this.#saveRequest(record, { ...request, status: "not_entered", delivery: { status: "not_entered", reason: String(error) } });
    }
  }

  getRun(
    spaceId: string,
    runId: string,
  ): Run | { id: string; status: "unknown" } {
    const store = this.#store(spaceId);
    const saved = store.runs.get(runId);
    if (!saved) return { id: runId, status: "unknown" };
    const run = this.#sessions
        .get(keyOf(saved))
        ?.view.runs.find((x) => x.id === runId) ?? saved;
    const requestId = run.requestIds?.[0];
    const prompt = requestId ? store.requests.requests.get(requestId)?.prompt : undefined;
    return structuredClone({ ...run, ...(prompt ? { prompt } : {}) });
  }
  cancelRun(spaceId: string, runId: string): Run {
    const run = this.getRun(spaceId, runId);
    if (run.status === "unknown")
      throw new RepaFault("unknown_run", "无法确认该运行的执行状态。");
    if (isTerminal(run)) return run;
    const record = this.#record(run);
    const active = record.active;
    if (!active || active.run.id !== runId) return run;
    active.controller.abort();
    this.#updateRun(active, { status: "cancelling" });
    if (record.host)
      void record.host
        .cancel()
        .catch((error) => this.#notice(record, "cancel", String(error)));
    return structuredClone(active.run);
  }

  async #execute(record: SessionRecord, active: ActiveRun): Promise<void> {
    let result: { status: "completed" | "cancelled" | "failed" | "interrupted"; error?: Run["error"] } = { status: "cancelled" };
    let fallbackEligible = false;
    const binding = active.request.runOptions.connection;
    const attempt: ModelAttempt | undefined = binding
      ? { callId: active.run.id, index: 0, binding, startedAt: Date.now(), status: "running" } : undefined;
    const source: CapabilitySource = {
      kind: "agent", ...active.request.target, runId: active.run.id, requestId: active.request.requestId,
    };
    try {
      if (attempt) this.#recordModelAttempt(record.view.spaceId, source, active.request.requestId, attempt);
      if (!active.controller.signal.aborted) {
        this.#updateRun(active, { status: "running" });
        if (binding) await this.#models.assertBinding(binding);
        if (record.host && !isDeepStrictEqual(runtimeIdentity(record.binding), runtimeIdentity(binding))) {
          await record.host.close();
          record.host = undefined;
          record.binding = undefined;
        }
        if (!record.host && !active.controller.signal.aborted) {
          record.view.runtime = "loading";
          this.#emit({ type: "session", session: record.view });
          record.opening = this.#openHost(record, binding);
          try {
            record.host = await record.opening;
            record.binding = binding;
          } finally {
            record.opening = undefined;
          }
          record.view.runtime = "ready";
          this.#emit({ type: "session", session: record.view });
        }
        if (!active.controller.signal.aborted && record.host) {
          const request = active.request;
          const input = await prepareInput(request.input, this.#space(request.target.spaceId).content, request.requestId);
          const execution = active.controller.signal.aborted
            ? Promise.resolve({ status: "cancelled" as const })
            : record.host.send(input.text, request.promptSettings, { requestId: request.requestId, images: input.images, options: request.runOptions });
          active.resolveReady();
          const outcome = await execution;
          fallbackEligible = outcome.status === "failed" && outcome.fallbackEligible === true;
          result = {
            status: outcome.status,
            ...("error" in outcome && outcome.error
              ? { error: { code: "provider", message: outcome.error } }
              : {}),
          };
        }
      }
    } catch (error) {
      result = active.controller.signal.aborted
        ? { status: "cancelled" }
        : {
            status: "failed",
            error: {
              code: error instanceof RepaFault ? error.code : "runtime",
              message: error instanceof Error ? error.message : String(error),
            },
          };
      this.diagnostics.record(active.controller.signal.aborted ? "info" : "error", "runtime.failed", {
        ...active.request.target, requestId: active.request.requestId, runId: active.run.id,
        code: error instanceof RepaFault ? error.code : "runtime",
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
      if (!record.host) record.view.runtime = "unloaded";
    } finally {
      const cancelled = active.controller.signal.aborted;
      active.controller.abort();
      active.resolveReady();
      const deliveries = await Promise.allSettled(active.deliveries);
      const rejected = deliveries.find(delivery => delivery.status === "rejected");
      if (rejected?.status === "rejected") result = { status: "interrupted", error: { code: "storage", message: String(rejected.reason) } };
      const finished: Run & { status: typeof result.status } = {
        ...active.run,
        ...result,
        phase: "idle",
        finishedAt: Date.now(),
      };
      let continuation: RequestRecord | undefined;
      try {
        if (attempt) this.#recordModelAttempt(record.view.spaceId, source, active.request.requestId, {
          ...attempt, status: finished.status, finishedAt: finished.finishedAt, ...(finished.error ? { error: finished.error } : {}),
        });
        record.store.saveRun(finished);
        if (finished.status !== "completed") record.store.requests.pause(record.view.sessionId, true);
        // send 已等待 SDK idle 和历史保存；再投影完整条目确保工具资源已转交会话 owner。
        record.session.snapshot();
        const content = this.#space(record.view.spaceId).content;
        for (const request of record.store.requests.list(record.view.sessionId).filter(request => request.runId === finished.id)) {
          this.#saveRequest(record, {
            ...request,
            status: "dispatch" in request.submission && request.submission.dispatch.kind === "steer" && request.delivery.status !== "entered"
              ? "not_entered" : finished.status,
            delivery: request.delivery.status === "pending"
              ? { status: "not_entered", reason: "运行结束前输入未进入历史。" } : request.delivery,
            ...(finished.error ? { error: finished.error } : {}),
          });
          content.retention.retain(`request:${request.requestId}`, inputResources(request.input));
        }
        if (finished.status === "failed" && fallbackEligible && !cancelled && active.run.status !== "cancelling" &&
          !record.closing && !record.deleting &&
          !this.#finishing && this.#state.lifecycle !== "stopping")
          continuation = this.#modelFallbackRequest(record, active.request.requestId);
      } catch (error) {
        finished.status = "interrupted";
        finished.error = { code: "storage", message: `执行结果未能保存：${String(error)}` };
        record.store.requests.paused.add(record.view.sessionId);
        this.#notice(record, finished.error.code, finished.error.message);
      }
      active.run = finished;
      record.view.updatedAt = finished.finishedAt ?? record.view.updatedAt;
      this.#emit({ type: "run", run: finished });
      const endedAt = Date.now();
      this.diagnostics.record(finished.error ? "error" : "info", "run.finished", {
        ...active.request.target, requestId: active.request.requestId, runId: finished.id,
        status: finished.status, code: finished.error?.code, submittedAt: active.request.createdAt,
        firstStatusAt: active.firstStatusAt, firstTextAt: active.firstTextAt,
        durationMs: endedAt - finished.createdAt,
      }, endedAt);
      record.active = undefined;
      this.#emit({ type: "session", session: record.view });
      if (continuation) this.#start(record, continuation);
      else this.#pump(record);
      this.#emitQueue(record);
      this.#finishIfReady();
    }
  }
  #modelFallbackRequest(record: SessionRecord, previousRequestId: string): RequestRecord | undefined {
    const previous = record.store.requests.get(previousRequestId);
    const [connection, ...remaining] = previous.runOptions.fallback?.models ?? [];
    if (!connection) return undefined;
    const requestId = randomUUID();
    const { fallback: _fallback, ...options } = previous.runOptions;
    const request: RequestRecord = {
      requestId, target: previous.target, submission: { target: previous.target, requestId, previousRequestId },
      input: this.#continuationInput(previous), source: previous.source,
      continuation: { kind: "model_fallback", previousRequestId },
      promptSettings: previous.promptSettings,
      runOptions: {
        ...options, connection,
        model: { provider: connection.connection.provider, id: connection.modelId,
          ...(connection.connection.baseUrl ? { baseUrl: connection.connection.baseUrl } : {}) },
        ...(remaining.length ? { fallback: { on: "transient_error", models: remaining } } : {}),
      },
      createdAt: Date.now(), sequence: record.store.requests.nextSequence(), status: "queued", delivery: { status: "pending" },
    };
    // 自动接续只消费先前绑定的策略；失败运行和用户队列的暂停状态继续保留。
    const content = this.#space(record.view.spaceId).content;
    content.retention.retain(`request:${requestId}`, inputResources(request.input));
    this.#saveRequest(record, request);
    this.#diagnoseAccepted(request);
    this.#saveRequest(record, { ...previous, fallbackRequestId: requestId });
    this.#notice(record, "model_fallback", `按已受理的回退策略接续任务，使用连接 ${connection.connection.name} 的 ${connection.modelId}。`);
    return request;
  }

  async #openHost(record: SessionRecord, binding?: ModelBinding): Promise<ConversationRuntime> {
    const plugins = await this.#plugins({ kind: "space", spaceId: record.view.spaceId });
    const modelOverride = binding ? await this.#models.open(binding)
      : typeof this.#options.modelOverride === "function"
        ? await this.#options.modelOverride(
            record.store.space,
            record.view.sessionId,
          )
        : this.#options.modelOverride;
    if (!modelOverride)
      throw new RepaFault("connection_required", "请在 Repa 中选择模型连接；旧请求可选择连接后通过继续操作接续。");
    return record.session.openRuntime({
      content: this.#spaces.get(record.store.space.id)!.content,
      backgroundSources: this.#contributions.backgrounds(plugins.configuration, {
        content: this.#space(record.view.spaceId).content,
        invoke: async (selection, input) => {
          const selected = plugins.capabilities.resolve(selection, { kind: "space", spaceId: record.view.spaceId });
          if (selected.execution !== "query") throw new RepaFault("invalid_background_capability", "背景来源必须使用只读 query 能力。", { contract: selected.contract });
          return (await this.#invokeAgentCapability(record, plugins,
            { contract: selected.contract, implementationId: selected.implementationId }, input)).result;
        },
      }),
      resourceSettings: plugins.resourceSettings(),
      additionalExtensions: plugins.resources.additionalExtensions,
      additionalSkills: plugins.resources.additionalSkills,
      additionalPrompts: plugins.resources.additionalPrompts,
      applicationTools: [
        ...this.#capabilityTools(record, plugins),
        this.#execution.createTool(record.store.space.path, signal => this.#agentExecutionContext(record, signal)),
      ],
      agentDir: this.#options.agentDir,
      trustExtensions: this.#options.trustExtensions ?? false,
      modelOverride,
      onEvent: (event) => this.#hostEvent(record, event),
      ask: (dialog, options) => this.#ask(record, dialog, options),
    });
  }
  #hostEvent(record: SessionRecord, event: HostEvent): void {
    const key = {
      spaceId: record.view.spaceId,
      sessionId: record.view.sessionId,
    };
    const active = record.active;
    if (active && active.firstTextAt === undefined) {
      let textLength = 0;
      if (event.type === "delta" && event.kind === "text") textLength = event.text.length;
      else if (event.type === "message" && event.message.role === "assistant")
        textLength = event.message.content.reduce((length, part) => length + (part.type === "text" ? part.text.length : 0), 0);
      if (textLength > 0) {
        active.firstTextAt = Date.now();
        this.diagnostics.record("info", "run.first_text", {
          ...key, requestId: active.request.requestId, runId: active.run.id, textLength,
        }, active.firstTextAt);
      }
    }
    if (event.type === "prompt") {
      const active = record.active;
      if (active) {
        const request = record.store.requests.get(active.request.requestId);
        if (!isDeepStrictEqual(request.prompt, event.prompt)) this.#saveRequest(record, { ...request, prompt: event.prompt });
      }
    } else if (event.type === "entered") {
      const request = record.store.requests.requests.get(event.requestId);
      if (request) {
        this.#saveRequest(record, { ...request, delivery: { status: "entered", messageIds: [event.messageId] } });
        if ("previousRequestId" in request.submission) {
          const previous = record.store.requests.requests.get(request.submission.previousRequestId);
          if (previous && previous.delivery.status !== "entered")
            this.#saveRequest(record, { ...previous, delivery: { status: "entered", messageIds: [event.messageId] } });
        }
      }
    } else if (event.type === "title") {
      const first = record.view.messages
        .find((x) => x.role === "user")
        ?.content.find((x) => x.type === "text");
      record.view.title =
        event.title ??
        (first?.type === "text"
          ? first.text.slice(0, 120)
          : (record.view.runs[0]?.text.slice(0, 120) ?? "新会话"));
      this.#emit({ type: "session", session: record.view });
    } else if (event.type === "phase") {
      if (record.active) this.#updateRun(record.active, { phase: event.phase });
    } else if (event.type === "tool") {
      if (record.active)
        this.#emit({ ...event, ...key, runId: record.active.run.id });
    } else this.#emit({ ...event, ...key });
  }
  #updateRun(active: ActiveRun, update: Partial<Run>): void {
    active.run = { ...active.run, ...update };
    this.#emit({ type: "run", run: active.run });
  }
  #notice(record: SessionRecord, code: string, message: string, level: "info" | "error" = "error"): void {
    this.#emit({
      type: "notice",
      spaceId: record.view.spaceId,
      sessionId: record.view.sessionId,
      notice: { id: randomUUID(), code, message, level },
    });
  }
  #ask(record: SessionRecord, dialog: Dialog, options?: DialogOptions): Promise<Reply> {
    const active = record.active;
    if (!active) return Promise.resolve(null);
    return this.#interact({ spaceId: record.view.spaceId, sessionId: record.view.sessionId, runId: active.run.id }, active.controller.signal, dialog, options,
      (id, interaction, receipt) => {
        if (receipt) {
          const request = record.store.requests.get(active.request.requestId);
          this.#saveRequest(record, { ...request, interactionReplies: [...request.interactionReplies ?? [], receipt] });
        }
        if (interaction) this.#updateRun(active, { status: "waiting" });
        else if (active.run.status === "waiting" && record.view.interactions.every(item => item.id === id)) this.#updateRun(active, { status: "running" });
      });
  }

  #interact(owner: { spaceId: string; sessionId: string; runId: string } | { spaceId?: string; requestId: string }, signal: AbortSignal,
    dialog: Dialog, options: DialogOptions | undefined, changed: (id: string, interaction: Interaction | null, receipt?: InteractionReplyReceipt) => void): Promise<Reply> {
    if (signal.aborted || options?.signal?.aborted) return Promise.resolve(null);
    const id = randomUUID();
    const interaction: Interaction = { ...dialog, ...owner, id,
      ...(options?.timeout !== undefined ? { expiresAt: Date.now() + options.timeout } : {}) };
    const requestId = "requestId" in owner ? owner.requestId : this.#sessions.get(keyOf(owner))?.active?.request.requestId;
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: Reply, receipt?: InteractionReplyReceipt) => {
        if (!this.#pending.has(id)) return;
        // 接受答复先由所属请求落盘；保存失败时仍保留等待，重试不越过这道边界。
        changed(id, null, receipt);
        if (receipt) this.#rememberReply(owner.spaceId, "sessionId" in owner ? owner.sessionId : undefined, receipt);
        this.#pending.delete(id);
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        options?.signal?.removeEventListener("abort", abort);
        if ("sessionId" in owner) this.#emit({ type: "interaction", spaceId: owner.spaceId, sessionId: owner.sessionId, id, interaction: null });
        this.diagnostics.record("info", receipt ? "interaction.replied" : "interaction.closed", {
          ...owner, requestId, interactionId: id, responseId: receipt?.responseId,
          textLength: typeof value === "string" ? value.length : 0,
        });
        resolve(value);
      };
      const abort = () => finish(null);
      this.#pending.set(id, { interaction, resolve: receipt => finish(receipt.value, receipt) });
      signal.addEventListener("abort", abort, { once: true });
      options?.signal?.addEventListener("abort", abort, { once: true });
      if (options?.timeout !== undefined) timer = setTimeout(abort, options.timeout);
      if ("sessionId" in owner) this.#emit({ type: "interaction", spaceId: owner.spaceId, sessionId: owner.sessionId, id, interaction });
      changed(id, interaction);
      this.diagnostics.record("info", "interaction.opened", {
        ...owner, requestId, interactionId: id, interactionKind: dialog.kind,
      });
    });
  }
  #rememberReply(spaceId: string | undefined, sessionId: string | undefined, receipt: InteractionReplyReceipt): void {
    const scope = spaceId ?? "application";
    const receipts = this.#replyReceipts.get(scope) ?? new Map();
    receipts.set(receipt.id, { ...(sessionId ? { sessionId } : {}), receipt: structuredClone(receipt) });
    this.#replyReceipts.set(scope, receipts);
  }

  #restoreReplyReceipts(spaceId: string | undefined, requests: Iterable<RequestRecord | BackgroundRequest>): void {
    for (const request of requests) for (const receipt of request.interactionReplies ?? [])
      this.#rememberReply(spaceId, "target" in request ? request.target.sessionId : undefined, receipt);
  }

  reply(params: Params<"interaction.reply">): Promise<Result<"interaction.reply">> {
    const input = structuredClone(params);
    return this.#activity(async () => {
      if (input.spaceId === undefined) await this.#processing();
      const saved = this.#replyReceipts.get(input.spaceId ?? "application")?.get(input.id);
      if (saved && (input.sessionId === undefined || input.sessionId === saved.sessionId)) {
        const receipt = saved.receipt;
        if (receipt.responseId === input.responseId && receipt.value !== input.value)
          throw new RepaFault("response_id_conflict", "相同答复标识已用于另一份回答。");
        return { id: receipt.id, responseId: receipt.responseId, acceptedAt: receipt.acceptedAt,
          status: receipt.responseId === input.responseId ? "accepted" : "already_processed" };
      }
      const pending = this.#pending.get(input.id);
      if (!pending || pending.interaction.spaceId !== input.spaceId ||
          (pending.interaction.expiresAt !== undefined && pending.interaction.expiresAt <= Date.now()) ||
          (input.sessionId !== undefined && (!("sessionId" in pending.interaction) || pending.interaction.sessionId !== input.sessionId)))
        throw new RepaFault("interaction_expired", "该交互已经回答、取消或过期。");
      const question = pending.interaction;
      if (input.value !== null &&
          (question.kind === "confirm" ? typeof input.value !== "boolean" : typeof input.value !== "string" ||
            (question.kind === "select" && !question.options?.includes(input.value))))
        throw new RepaFault("invalid_reply", "回复不符合该交互的选项或数据类型。");
      const receipt: InteractionReplyReceipt = { id: input.id, responseId: input.responseId, value: input.value, acceptedAt: Date.now() };
      pending.resolve(receipt);
      return { id: receipt.id, responseId: receipt.responseId, acceptedAt: receipt.acceptedAt, status: "accepted" };
    }, false, input.spaceId);
  }

  async closeSession(key: SessionKey): Promise<void> {
    this.#assertSpaceAvailable(key.spaceId);
    const record = this.#record(key);
    if (record.closing) return record.closing;
    record.closing = (async () => {
      if (record.active) {
        this.cancelRun(key.spaceId, record.active.run.id);
        await record.active?.done;
      }
      try {
        await record.host?.close();
      } finally {
        record.host = undefined;
        record.view.runtime = "unloaded";
        this.#emit({ type: "session", session: record.view });
      }
    })();
    try {
      await record.closing;
    } finally {
      record.closing = undefined;
    }
  }
  removeSession(key: SessionKey): Promise<void> {
    return this.#activity(async () => {
      const record = this.#sessions.get(keyOf(key));
      if (!record) { this.#store(key.spaceId); return; }
      record.deleting = true;
      try {
        await this.closeSession(key);
        record.store.assertOwned();
        for (const request of record.store.requests.list(key.sessionId)) {
          if (request.status === "queued") this.cancelQueued(key, request.requestId);
          // 请求记录继续持有其输入；删除会话只释放会话历史自身的资源。
        }
        record.session.remove();
      } finally {
        if (!record.session.exists) {
          this.#sessions.delete(keyOf(key));
          this.#emit({ type: "session_removed", ...key });
        } else record.deleting = false;
      }
    }, true, key.spaceId);
  }

  snapshot(scope: Scope): Snapshot {
    return structuredClone({
      lifecycle: this.#state.lifecycle,
      processing: this.#state.processing?.filter(request => contains(scope, request)),
      execution: this.#execution.list().filter(execution => relevant(scope, { type: "execution", execution })),
      spaces: this.#state.spaces.filter(
        (x) => !("spaceId" in scope) || x.id === scope.spaceId,
      ),
      sessions: this.#state.sessions.filter((x) => contains(scope, x)).map(view => this.#sessionView(view, "sessionId" in scope)),
    });
  }
  watch(
    scope: Scope,
    cursor: string | undefined,
    send: (delivery: Delivery) => void,
  ): () => void {
    const watcher = { scope, send, cursor: this.#cursor() };
    this.#watchers.add(watcher);
    const suffix = cursor?.startsWith(`${this.id}:`)
      ? Number(cursor.slice(this.id.length + 1))
      : NaN;
    if (
      Number.isSafeInteger(suffix) &&
      suffix >= (this.#log[0]?.sequence ?? this.#sequence + 1) - 1 &&
      suffix <= this.#sequence
    ) {
      send({
        type: "changes",
        previousCursor: cursor!,
        cursor: this.#cursor(),
        changes: this.#log
          .filter((x) => x.sequence > suffix && relevant(scope, x.change))
          .map((x) => this.#scopedChange(x.change, scope)),
      });
    } else
      send({
        type: "snapshot",
        cursor: this.#cursor(),
        snapshot: this.snapshot(scope),
      });
    return () => {
      this.#watchers.delete(watcher);
    };
  }
  #scopedChange(change: Change, scope: Scope): Change {
    return change.type === "session" ? { type: "session", session: this.#sessionView(change.session, "sessionId" in scope) } : structuredClone(change);
  }
  #cursor(): string {
    return `${this.id}:${this.#sequence}`;
  }
  #emit(change: Change): void {
    this.#diagnoseChange(change);
    applyChange(this.#state, change);
    this.#log.push({
      sequence: ++this.#sequence,
      change: change.type === "session"
        ? { type: "session", session: this.#sessionView(change.session, true) } : structuredClone(change),
    });
    if (this.#log.length > (this.#options.eventBufferSize ?? 1024))
      this.#log.shift();
    for (const watcher of this.#watchers) {
      if (!relevant(watcher.scope, change)) continue;
      try {
        watcher.send({
          type: "changes",
          previousCursor: watcher.cursor,
          cursor: this.#cursor(),
          changes: [this.#scopedChange(change, watcher.scope)],
        });
        watcher.cursor = this.#cursor();
      } catch {
        this.#watchers.delete(watcher);
      }
    }
  }
  #diagnoseChange(change: Change): void {
    if (change.type === "run") {
      const run = change.run;
      const active = this.#sessions.get(keyOf(run))?.active;
      if (active && active.run.id === run.id && active.firstStatusAt === undefined) {
        active.firstStatusAt = Date.now();
        this.diagnostics.record("info", "run.first_status", {
          spaceId: run.spaceId, sessionId: run.sessionId, requestId: active.request.requestId,
          runId: run.id, status: run.status, phase: run.phase,
        }, active.firstStatusAt);
      }
      this.diagnostics.record("debug", "run.state", {
        spaceId: run.spaceId, sessionId: run.sessionId, requestId: active?.request.requestId,
        runId: run.id, status: run.status, phase: run.phase,
      });
    } else if (change.type === "tool") {
      this.diagnostics.record(change.status === "failed" ? "error" : "info",
        change.status === "running" ? "tool.started" : "tool.finished", {
          ...change, requestId: this.#sessions.get(keyOf(change))?.active?.request.requestId,
          toolName: change.name,
        });
    } else if (change.type === "notice") {
      const active = change.sessionId ? this.#sessions.get(keyOf({ spaceId: change.spaceId, sessionId: change.sessionId }))?.active : undefined;
      this.diagnostics.record(change.notice.level === "warning" ? "warn" : change.notice.level, "runtime.notice", {
        spaceId: change.spaceId, sessionId: change.sessionId, requestId: active?.request.requestId,
        runId: active?.run.id, code: change.notice.code,
      });
    } else if (change.type === "processing") {
      const request = change.request;
      const previous = this.#state.processing?.find(item => item.spaceId === request.spaceId && item.requestId === request.requestId);
      // 只记录实际状态变化；重开时投影的旧终态不冒充本次完成。
      if ((previous || request.status === "accepted") && previous?.status !== request.status) {
        this.diagnostics.record(request.error ? "error" : "info", `processing.${request.status}`, {
          spaceId: request.spaceId, requestId: request.requestId, operation: request.operation,
          status: request.status, code: request.error?.code, submittedAt: request.createdAt,
          ...(request.finishedAt !== undefined ? { durationMs: request.finishedAt - request.createdAt } : {}),
        });
      }
    } else if (change.type === "lifecycle") {
      this.diagnostics.record("info", "application.state", { status: change.lifecycle });
    }
  }
  #assertAccepting(): void {
    if (this.#state.lifecycle !== "running")
      throw new RepaFault("shutting_down", "后端正在退出，暂不受理新任务。");
  }
  shutdown(mode: "drain" | "cancel"): void {
    if (this.#state.lifecycle === "stopped" || this.#finishing) return;
    this.#explicitShutdown = true;
    this.#emit({
      type: "lifecycle",
      lifecycle: mode === "cancel" ? "stopping" : "draining",
    });
    if (mode === "cancel")
      for (const record of this.#sessions.values()) {
        record.store.requests.pause(record.view.sessionId, true);
        if (record.active)
          this.cancelRun(record.view.spaceId, record.active.run.id);
      }
    if (mode === "cancel") for (const record of this.#spaces.values()) record.processing.cancelAll();
    if (mode === "cancel") this.#applicationRequests?.cancelAll();
    if (mode === "cancel") for (const runtime of this.#pluginRuntimes.values())
      void runtime.then(value => value.capabilities.cancel(), () => {});
    if (mode === "cancel") this.#models.cancelAll();
    this.#finishIfReady();
  }
  #finishIfReady(): void {
    if (
      this.#finishing ||
      this.#state.lifecycle === "running" ||
      this.#state.lifecycle === "stopped" ||
      this.#openingSpaces.size ||
      this.#activities ||
      this.#openingApplicationRequests || this.#applicationRequests?.active ||
      this.#models.active ||
      [...this.#spaces.values()].some(record => record.processing.active) ||
      [...this.#sessions.values()].some((x) => x.active)
    )
      return;
    this.#finishing = true;
    void (async () => {
      const errors: unknown[] = [];
      for (const record of this.#sessions.values()) {
        try {
          await this.closeSession(record.view);
        } catch (error) {
          errors.push(error);
          this.#notice(record, "shutdown", String(error));
        }
      }
      for (const runtime of this.#pluginRuntimes.values()) {
        try { await (await runtime).capabilities.close(); } catch (error) { errors.push(error); }
      }
      try {
        await this.#applicationRequests?.settled();
        await this.#releaseApplicationRequests?.();
      } catch (error) { errors.push(error); }
      for (const { store, content, processing, watcher, watchTimer } of this.#spaces.values()) {
        try {
          clearTimeout(watchTimer);
          watcher?.close();
          await processing.settled();
          await content.settled();
          store.release();
        } catch (error) {
          errors.push(error);
        }
      }
      this.#emit({ type: "lifecycle", lifecycle: "stopped" });
      this.#watchers.clear();
      this.#display.dispose();
      this.#replyReceipts.clear();
      if (errors.length)
        this.#rejectClosed(
          new AggregateError(errors, "后端退出时有资源未能正常清理。"),
        );
      else this.#resolveClosed();
    })();
  }
}
