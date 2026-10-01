import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { existsSync, watch, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareInput, inputResources, inputText } from "./requests/input.js";
import type { Submit, Continue, RequestRecord, QueueView } from "./requests/schema.js";
import { BackgroundRequests, type ProcessingContext } from "./requests/background.js";
import type { BackgroundRequest, Input, ProcessingResult } from "./requests/schema.js";
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
  request: RequestRecord;
  controller: AbortController;
  done: Promise<void>;
  deliveries: Promise<void>[];
  ready: Promise<void>;
  resolveReady: () => void;
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
      const processing = new BackgroundRequests(content, () => store.assertOwned(), request => {
        this.#emit({ type: "processing", request });
        this.#finishIfReady();
      }, (requestId, signal, dialog, options) => this.#interact({ spaceId: store.space.id, requestId }, signal, dialog, options,
        (id, interaction) => processing.interaction(requestId, id, interaction)));
      const record: SpaceRecord = { store, sessions, content, processing };
      this.#spaces.set(store.space.id, record);
      for (const request of processing.requests.values()) this.#emit({ type: "processing", request });
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
      if (record.processing.active || this.#spaceActivities.get(request.spaceId) || [...this.#sessions.values()].some(session =>
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
    return this.#sessionView(this.#record(key).view, true);
  }

  #sessionView(view: SessionView, history: boolean): SessionView {
    return structuredClone({ ...view, messages: history ? view.messages.slice(-100) : [], runs: history ? view.runs.slice(-100) : view.runs.filter(run => !isTerminal(run)) });
  }

  history(params: Params<"session.history">): { messages: import("./protocol.js").Message[]; before?: string } {
    const messages = this.#record(params).session.snapshot().messages;
    const end = params.before === undefined ? messages.length : messages.findIndex(message => message.id === params.before);
    if (end < 0) throw new RepaFault("invalid_cursor", "历史分页位置不属于当前会话分支。");
    const start = Math.max(0, end - (params.limit ?? 100));
    return structuredClone({ messages: messages.slice(start, end), ...(start > 0 ? { before: messages[start]!.id } : {}) });
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

  submit(params: Submit | Continue, hostId: string = this.id): Promise<RequestRecord> {
    const input = structuredClone(params);
    return this.#activity(() => this.#admission.run(() => this.#submit(input, hostId)), false, input.target.spaceId);
  }

  async #submit(submission: Submit | Continue, hostId: string): Promise<RequestRecord> {
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
    const promptSettings = dispatch.kind === "steer" && record.active
      ? record.active.request.promptSettings
      : submission.selection?.prompts ?? await this.#configuration.prompts({ kind: "session", ...target });
    this.#assertAccepting();
    store.assertOwned();
    if (record.closing || record.deleting || (dispatch.kind === "start" &&
      (record.active || (!store.requests.paused.has(target.sessionId) && this.queue(target).requests.length))))
      throw new RepaFault("session_busy", "会话正在运行、关闭或已有待执行请求。");
    const request: RequestRecord = {
      requestId, target, submission, input, createdAt: Date.now(), sequence: store.requests.nextSequence(),
      source: { kind: "client", hostId }, promptSettings,
      runOptions: dispatch.kind === "steer" && record.active ? record.active.run.options ?? {} : {
        ...(record.host?.selection() ?? record.session.selection(this.#options.agentDir)),
        ...(submission.selection?.model ? { model: submission.selection.model } : {}),
        ...(submission.selection?.thinkingLevel !== undefined ? { thinkingLevel: submission.selection.thinkingLevel } : {}),
        ...(submission.selection?.tools !== undefined ? { tools: submission.selection.tools } : {}),
      },
      status: "queued", delivery: { status: "pending" },
    };
    const content = this.#space(target.spaceId).content;
    content.retention.retain(`request:${requestId}`, inputResources(input));
    try { store.requests.save(request); }
    catch (error) {
      content.retention.releaseOwner(`request:${requestId}`);
      throw error;
    }
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
    record.store.requests.save(request);
    this.#emit({ type: "request", request });
  }

  getRequest(spaceId: string, requestId: string): RequestRecord | BackgroundRequest | { requestId: string; status: "unknown" } {
    return structuredClone(this.#store(spaceId).requests.requests.get(requestId) ?? this.#spaces.get(spaceId)?.processing.requests.get(requestId) ?? { requestId, status: "unknown" });
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

  cancelRequest(spaceId: string, requestId: string): BackgroundRequest {
    const record = this.#spaces.get(spaceId);
    if (!record) throw new RepaFault("not_found", "学习空间尚未打开。");
    return record.processing.cancel(requestId);
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
    return structuredClone(
      this.#sessions
        .get(keyOf(saved))
        ?.view.runs.find((x) => x.id === runId) ?? saved,
    );
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
          const request = active.request;
          const input = await prepareInput(request.input, this.#space(request.target.spaceId).content, request.requestId);
          const execution = active.controller.signal.aborted
            ? Promise.resolve({ status: "cancelled" as const })
            : record.host.send(input.text, request.promptSettings, { requestId: request.requestId, images: input.images, options: request.runOptions });
          active.resolveReady();
          const outcome = await execution;
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
      if (!record.host) record.view.runtime = "unloaded";
    } finally {
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
      try {
        record.store.saveRun(finished);
        if (finished.status !== "completed") record.store.requests.pause(record.view.sessionId, true);
        for (const request of record.store.requests.list(record.view.sessionId).filter(request => request.runId === finished.id)) {
          this.#saveRequest(record, {
            ...request,
            status: "dispatch" in request.submission && request.submission.dispatch.kind === "steer" && request.delivery.status !== "entered"
              ? "not_entered" : finished.status,
            delivery: request.delivery.status === "pending"
              ? { status: "not_entered", reason: "运行结束前输入未进入历史。" } : request.delivery,
            ...(finished.error ? { error: finished.error } : {}),
          });
        }
      } catch (error) {
        finished.status = "interrupted";
        finished.error = { code: "storage", message: `执行结果未能保存：${String(error)}` };
        record.store.requests.paused.add(record.view.sessionId);
        this.#notice(record, finished.error.code, finished.error.message);
      }
      active.run = finished;
      record.view.updatedAt = finished.finishedAt ?? record.view.updatedAt;
      this.#emit({ type: "run", run: finished });
      record.active = undefined;
      this.#emit({ type: "session", session: record.view });
      this.#pump(record);
      this.#emitQueue(record);
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
    if (event.type === "entered") {
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
  #notice(record: SessionRecord, code: string, message: string): void {
    this.#emit({
      type: "notice",
      spaceId: record.view.spaceId,
      sessionId: record.view.sessionId,
      notice: { id: randomUUID(), code, message, level: "error" },
    });
  }
  #ask(record: SessionRecord, dialog: Dialog, options?: DialogOptions): Promise<Reply> {
    const active = record.active;
    if (!active) return Promise.resolve(null);
    return this.#interact({ spaceId: record.view.spaceId, sessionId: record.view.sessionId, runId: active.run.id }, active.controller.signal, dialog, options,
      (_id, interaction) => {
        if (interaction) this.#updateRun(active, { status: "waiting" });
        else if (active.run.status === "waiting" && !record.view.interactions.length) this.#updateRun(active, { status: "running" });
      });
  }

  #interact(owner: { spaceId: string; sessionId: string; runId: string } | { spaceId: string; requestId: string }, signal: AbortSignal,
    dialog: Dialog, options: DialogOptions | undefined, changed: (id: string, interaction: Interaction | null) => void): Promise<Reply> {
    if (signal.aborted || options?.signal?.aborted) return Promise.resolve(null);
    const id = randomUUID();
    const interaction: Interaction = { ...dialog, ...owner, id,
      ...(options?.timeout !== undefined ? { expiresAt: Date.now() + options.timeout } : {}) };
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: Reply) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        options?.signal?.removeEventListener("abort", abort);
        if ("sessionId" in owner) this.#emit({ type: "interaction", spaceId: owner.spaceId, sessionId: owner.sessionId, id, interaction: null });
        changed(id, null);
        resolve(value);
      };
      const abort = () => finish(null);
      this.#pending.set(id, { interaction, resolve: finish });
      signal.addEventListener("abort", abort, { once: true });
      options?.signal?.addEventListener("abort", abort, { once: true });
      if (options?.timeout !== undefined) timer = setTimeout(abort, options.timeout);
      if ("sessionId" in owner) this.#emit({ type: "interaction", spaceId: owner.spaceId, sessionId: owner.sessionId, id, interaction });
      changed(id, interaction);
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
    this.#finishIfReady();
  }
  #finishIfReady(): void {
    if (
      this.#finishing ||
      this.#state.lifecycle === "running" ||
      this.#state.lifecycle === "stopped" ||
      this.#openingSpaces.size ||
      this.#activities ||
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
      if (errors.length)
        this.#rejectClosed(
          new AggregateError(errors, "后端退出时有资源未能正常清理。"),
        );
      else this.#resolveClosed();
    })();
  }
}
