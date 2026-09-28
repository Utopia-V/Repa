import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { existsSync, watch, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "./configuration/store.js";
import type { SettingScope } from "./configuration/schema.js";
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
import { applyChange, contains, relevant } from "./state.js";

export interface ApplicationOptions {
  agentDir?: string;
  appDirectory?: string;
  resources?: ResourceRetentionOptions;
  snapshotParticipants?: readonly SpaceSnapshotParticipant[];
  trustExtensions?: boolean;
  eventBufferSize?: number;
  exitWhenDetached?: boolean;
  modelOverride?:
    | PiModelOverride
    | ((space: Space, sessionId: string) => Promise<PiModelOverride>);
}
interface ActiveRun {
  run: Run;
  controller: AbortController;
  done: Promise<void>;
}
interface SpaceRecord {
  store: RuntimeStore;
  sessions: PiSessionStore;
  content: ContentStore;
  watcher?: FSWatcher;
  watchTimer?: ReturnType<typeof setTimeout>;
}
interface SessionRecord {
  store: RuntimeStore;
  session: StoredSession;
  view: SessionView;
  host?: ConversationRuntime;
  opening?: Promise<ConversationRuntime>;
  active?: ActiveRun;
  closing?: Promise<void>;
  deleting?: boolean;
}
interface PendingReply {
  interaction: Interaction;
  resolve: (value: Reply) => void;
}
const keyOf = (key: SessionKey) => `${key.spaceId}/${key.sessionId}`;

export class RepaApplication {
  readonly id = randomUUID();
  readonly closed: Promise<void>;
  readonly #options: ApplicationOptions;
  readonly #configuration: ConfigStore;
  readonly #access: Promise<ContentAccessStore>;
  readonly #admission = new SerialQueue();
  readonly #spaceOperations: SpaceOperations;
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
  readonly #watchers = new Set<{
    scope: Scope;
    send: (value: Delivery) => void;
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
    if (
      options.eventBufferSize !== undefined &&
      (!Number.isInteger(options.eventBufferSize) ||
        options.eventBufferSize < 1)
    )
      throw new Error("事件缓存大小必须为正整数。");
    this.#options = options;
    const appDirectory = path.resolve(options.appDirectory ?? options.agentDir ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "repa"));
    this.#configuration = new ConfigStore({ appDirectory, resolveSpace: (id) => this.#store(id).space.path });
    this.#access = ContentAccessStore.open(appDirectory);
    this.#spaceOperations = new SpaceOperations(path.join(appDirectory, "space-operations"));
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

  async openSpace(directory: string): Promise<Space> {
    this.#assertAccepting();
    await mkdir(path.resolve(directory), { recursive: true });
    directory = await realpath(directory);
    const existing = [...this.#spaces.values()].find(
      (x) => x.store.space.path === directory,
    );
    if (existing) return structuredClone(existing.store.space);
    const opening = this.#openingSpaces.get(directory);
    if (opening) return opening;
    const promise = this.#openSpace(directory);
    this.#openingSpaces.set(directory, promise);
    try {
      return await promise;
    } finally {
      this.#openingSpaces.delete(directory);
      this.#finishIfReady();
    }
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
        spaceId: store.space.id, root: store.space.path,
        assertOwned: () => store.assertOwned(),
        canReadExternal: (file) => access.canRead(store.space.id, file),
        onChange: (result) => this.#contentChanged(store.space.id, result.changes.map((entry) => entry.path), result),
      });
      for (const id of this.#clients) content.retention.setHostActive(id, true);
      const sessions = new PiSessionStore(store.space.path, content.retention);
      const existing = await sessions.list();
      this.#assertAccepting();
      const record: SpaceRecord = { store, sessions, content };
      this.#spaces.set(store.space.id, record);
      this.#emit({ type: "space", space: store.space });
      this.#watchContent(record);
      for (const session of existing) this.#register(store, session);
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
    const mutation = !["content.list", "content.get", "content.read", "operation.get", "context.get", "context.preview", "resource.hold.get"].includes(method);
    return this.#activity(async () => {
      const record = this.#spaces.get(spaceId);
      if (!record) throw new RepaFault("not_found", "学习空间尚未打开。");
      const content = record.content;
      switch (method) {
        case "content.list": return content.list(p<"content.list">());
        case "content.get": return content.get(p<"content.get">().target);
        case "content.read": return content.read(p<"content.read">(), host);
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
        case "context.get": return content.context();
        case "context.set": return content.setContext(p<"context.set">());
        case "context.preview": return content.contextView();
      }
    }, mutation, spaceId);
  }
  #checkScope(scope: SettingScope): void {
    if (scope.kind !== "application") this.#store(scope.spaceId).assertOwned();
    if (scope.kind === "session") this.#record(scope);
  }
  settingsCall(method: "settings.get" | "settings.set" | "settings.reset", params: Params<"settings.get" | "settings.set" | "settings.reset">): Promise<unknown> {
    const input = structuredClone(params);
    return this.#activity(async () => {
      this.#checkScope(input.scope);
      if (method === "settings.get") return this.#configuration.get(input.scope, input.namespace);
      const view = method === "settings.set"
        ? await this.#configuration.set(input as Params<"settings.set">)
        : await this.#configuration.reset(input as Params<"settings.reset">);
      this.#emit({ type: "settings", scope: input.scope, namespace: input.namespace });
      return view;
    }, method !== "settings.get", input.scope.kind === "application" ? undefined : input.scope.spaceId);
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
    return this.#activity(async () => {
      if (method === "space.operation.get") return this.#spaceOperations.get(input.operationId);
      if (method === "space.restore") return this.#spaceOperations.restore(input as Params<"space.restore">);
      const request = input as Params<"space.copy">;
      this.#assertSpaceAvailable(request.spaceId);
      const record = this.#spaces.get(request.spaceId);
      if (!record) throw new RepaFault("not_found", "学习空间尚未打开。");
      if (this.#spaceActivities.get(request.spaceId) || [...this.#sessions.values()].some(session =>
        session.store === record.store && (session.active || session.opening || session.closing || session.deleting)))
        throw new RepaFault("space_busy", "空间仍有任务或保存正在执行，完成后可生成快照。");
      record.store.assertOwned();
      this.#maintenance.add(request.spaceId);
      try {
        return await this.#spaceOperations.capture({ ...request, source: record.store.space.path,
          kind: method === "space.backup" ? "backup" : "copy" }, record.content, this.#options.snapshotParticipants ?? []);
      } finally { this.#maintenance.delete(request.spaceId); }
    }, method !== "space.operation.get");
  }

  #store(id: string): RuntimeStore {
    const store = this.#spaces.get(id)?.store;
    if (!store) throw new RepaFault("not_found", "学习空间尚未打开。");
    return store;
  }
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
    this.#sessions.set(keyOf(key), record);
    this.#emit({ type: "session", session: view });
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
    return structuredClone(this.#record(key).view);
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

  submit(params: Params<"run.submit">): Promise<Run> {
    const input = structuredClone(params);
    return this.#activity(() => this.#admission.run(() => this.#submit(input)), false, input.spaceId);
  }
  async #submit(params: Params<"run.submit">): Promise<Run> {
    const store = this.#store(params.spaceId);
    const old = store.runs.get(params.requestId);
    if (old) {
      if (old.sessionId !== params.sessionId || old.text !== params.text)
        throw new RepaFault(
          "request_conflict",
          "相同请求标识已用于另一项请求。",
        );
      return this.getRun(params.spaceId, params.requestId) as Run;
    }
    this.#assertAccepting();
    if (!params.text.trim())
      throw new RepaFault("invalid_input", "消息不能为空。");
    const record = this.#record(params);
    if (record.active || record.closing || record.deleting)
      throw new RepaFault("busy", "该会话仍有任务正在运行或关闭。");
    const promptSettings = await this.#configuration.prompts({ kind: "session", spaceId: params.spaceId, sessionId: params.sessionId });
    this.#assertAccepting();
    store.assertOwned();
    if (record.active || record.closing || record.deleting)
      throw new RepaFault("busy", "该会话仍有任务正在运行或关闭。");
    const run: Run = {
      id: params.requestId,
      spaceId: params.spaceId,
      sessionId: params.sessionId,
      text: params.text,
      status: "accepted",
      phase: "preparing",
      createdAt: Date.now(),
      promptSettings,
    };
    store.saveRun(run);
    record.view.updatedAt = run.createdAt;
    if (!record.view.messages.length && !record.view.runs.length)
      record.view.title = params.text.slice(0, 120);
    const active: ActiveRun = {
      run,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    record.active = active;
    active.done = Promise.resolve().then(() => this.#execute(record, active));
    this.#emit({ type: "session", session: record.view });
    this.#emit({ type: "run", run });
    return structuredClone(run);
  }
  getRun(
    spaceId: string,
    requestId: string,
  ): Run | { id: string; status: "unknown" } {
    const store = this.#store(spaceId);
    const saved = store.runs.get(requestId);
    if (!saved) return { id: requestId, status: "unknown" };
    return structuredClone(
      this.#sessions
        .get(keyOf(saved))
        ?.view.runs.find((x) => x.id === requestId) ?? saved,
    );
  }
  cancelRun(spaceId: string, requestId: string): Run {
    const run = this.getRun(spaceId, requestId);
    if (run.status === "unknown")
      throw new RepaFault("unknown_request", "无法确认该请求的执行状态。");
    if (isTerminal(run)) return run;
    const record = this.#record(run);
    const active = record.active;
    if (!active || active.run.id !== requestId) return run;
    active.controller.abort();
    this.#updateRun(active, { status: "cancelling" });
    if (record.host)
      void record.host
        .cancel()
        .catch((error) => this.#notice(record, "cancel", String(error)));
    return structuredClone(active.run);
  }

  async #execute(record: SessionRecord, active: ActiveRun): Promise<void> {
    let result: Partial<Run> = { status: "cancelled" };
    try {
      if (!active.controller.signal.aborted) {
        this.#updateRun(active, { status: "running" });
        if (!record.host) {
          record.view.runtime = "loading";
          this.#emit({ type: "session", session: record.view });
          record.opening = this.#openHost(record);
          try {
            record.host = await record.opening;
          } finally {
            record.opening = undefined;
          }
          record.view.runtime = "ready";
          this.#emit({ type: "session", session: record.view });
        }
        if (!active.controller.signal.aborted) {
          const outcome = await record.host.send(active.run.text, active.run.promptSettings!);
          result = {
            status: outcome.status,
            ...(outcome.error
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
      if (!record.host) record.view.runtime = "unloaded";
    } finally {
      active.controller.abort();
      const finished: Run = {
        ...active.run,
        ...result,
        phase: "idle",
        finishedAt: Date.now(),
      };
      try {
        record.store.saveRun(finished);
      } catch (error) {
        finished.status = "interrupted";
        finished.error = {
          code: "storage",
          message: `执行结果未能保存：${String(error)}`,
        };
      }
      active.run = finished;
      record.view.updatedAt = finished.finishedAt!;
      this.#emit({ type: "run", run: finished });
      record.active = undefined;
      this.#emit({ type: "session", session: record.view });
      this.#finishIfReady();
    }
  }
  async #openHost(record: SessionRecord): Promise<ConversationRuntime> {
    const modelOverride =
      typeof this.#options.modelOverride === "function"
        ? await this.#options.modelOverride(
            record.store.space,
            record.view.sessionId,
          )
        : this.#options.modelOverride;
    return record.session.openRuntime({
      content: this.#spaces.get(record.store.space.id)!.content,
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
    if (event.type === "title") {
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
  #notice(record: SessionRecord, code: string, message: string): void {
    this.#emit({
      type: "notice",
      spaceId: record.view.spaceId,
      sessionId: record.view.sessionId,
      notice: { id: randomUUID(), code, message, level: "error" },
    });
  }
  #ask(
    record: SessionRecord,
    dialog: Dialog,
    options?: DialogOptions,
  ): Promise<Reply> {
    const active = record.active;
    if (!active || active.controller.signal.aborted || options?.signal?.aborted)
      return Promise.resolve(null);
    const id = randomUUID();
    const interaction: Interaction = {
      ...dialog,
      id,
      spaceId: record.view.spaceId,
      sessionId: record.view.sessionId,
      runId: active.run.id,
      ...(options?.timeout !== undefined
        ? { expiresAt: Date.now() + options.timeout }
        : {}),
    };
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: Reply) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer);
        active.controller.signal.removeEventListener("abort", abort);
        options?.signal?.removeEventListener("abort", abort);
        this.#emit({
          type: "interaction",
          spaceId: interaction.spaceId,
          sessionId: interaction.sessionId,
          id,
          interaction: null,
        });
        if (active.run.status === "waiting" && !record.view.interactions.length)
          this.#updateRun(active, { status: "running" });
        resolve(value);
      };
      const abort = () => finish(null);
      this.#pending.set(id, { interaction, resolve: finish });
      active.controller.signal.addEventListener("abort", abort, { once: true });
      options?.signal?.addEventListener("abort", abort, { once: true });
      if (options?.timeout !== undefined)
        timer = setTimeout(abort, options.timeout);
      this.#updateRun(active, { status: "waiting" });
      this.#emit({
        type: "interaction",
        spaceId: interaction.spaceId,
        sessionId: interaction.sessionId,
        id,
        interaction,
      });
    });
  }
  reply(params: Params<"interaction.reply">): void {
    const pending = this.#pending.get(params.id);
    if (!pending || !contains(params, pending.interaction))
      throw new RepaFault(
        "interaction_expired",
        "该交互已经回答、取消或过期。",
      );
    const question = pending.interaction;
    if (
      params.value !== null &&
      (question.kind === "confirm"
        ? typeof params.value !== "boolean"
        : typeof params.value !== "string" ||
          (question.kind === "select" &&
            !question.options?.includes(params.value)))
    )
      throw new RepaFault(
        "invalid_reply",
        "回复不符合该交互的选项或数据类型。",
      );
    pending.resolve(params.value);
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
      spaces: this.#state.spaces.filter(
        (x) => !("spaceId" in scope) || x.id === scope.spaceId,
      ),
      sessions: this.#state.sessions.filter((x) => contains(scope, x)),
    });
  }
  watch(
    scope: Scope,
    cursor: string | undefined,
    send: (delivery: Delivery) => void,
  ): () => void {
    const watcher = { scope, send };
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
        cursor: this.#cursor(),
        changes: this.#log
          .filter((x) => x.sequence > suffix && relevant(scope, x.change))
          .map((x) => structuredClone(x.change)),
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
  #cursor(): string {
    return `${this.id}:${this.#sequence}`;
  }
  #emit(change: Change): void {
    applyChange(this.#state, change);
    this.#log.push({
      sequence: ++this.#sequence,
      change: structuredClone(change),
    });
    if (this.#log.length > (this.#options.eventBufferSize ?? 1024))
      this.#log.shift();
    for (const watcher of this.#watchers) {
      if (!relevant(watcher.scope, change)) continue;
      try {
        watcher.send({
          type: "changes",
          cursor: this.#cursor(),
          changes: [structuredClone(change)],
        });
      } catch {
        this.#watchers.delete(watcher);
      }
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
        if (record.active)
          this.cancelRun(record.view.spaceId, record.active.run.id);
      }
    this.#finishIfReady();
  }
  #finishIfReady(): void {
    if (
      this.#finishing ||
      this.#state.lifecycle === "running" ||
      this.#state.lifecycle === "stopped" ||
      this.#openingSpaces.size ||
      this.#activities ||
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
      for (const { store, content, watcher, watchTimer } of this.#spaces.values()) {
        try {
          clearTimeout(watchTimer);
          watcher?.close();
          await content.settled();
          store.release();
        } catch (error) {
          errors.push(error);
        }
      }
      this.#emit({ type: "lifecycle", lifecycle: "stopped" });
      this.#watchers.clear();
      if (errors.length)
        this.#rejectClosed(
          new AggregateError(errors, "后端退出时有资源未能正常清理。"),
        );
      else this.#resolveClosed();
    })();
  }
}
