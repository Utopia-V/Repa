import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { Check } from "typebox/value";
import { WebSocket, WebSocketServer } from "ws";
import { createAgentRuntime, withFileMutationQueue, type AgentRuntime, type AgentSpace } from "../agent.js";
import type { AskRoute } from "../ask.js";
import { restoreInPlace, restoreToNew } from "../backup/restore.js";
import { SpaceBackups } from "../backup/schedule.js";
import { deleteBackup, groupStatus, listBackups } from "../backup/store.js";
import { resolveAppHome } from "../home.js";
import { createFeedbackBundle } from "../feedback/bundle.js";
import { RecentErrors } from "../feedback/errors.js";
import {
  canRender,
  checkResponse,
  AskSubmitResultSchema,
  type AskSubmitResult,
  type ItemResponse,
} from "../interaction.js";
import type { AskOutcome, Plugin, Services } from "../plugin.js";
import { openPluginHost, type PluginHost } from "../plugins.js";
import {
  methods,
  notifications,
  PROTOCOL_VERSION,
  type ClientCapabilities,
  type Method,
  type Notification,
  type NotificationParams,
  type Params,
} from "../protocol.js";
import { RepaFault, type Confirmation, type Confirm } from "../schema.js";
import { SettingsStore } from "../settings.js";
import { createSpace, openSpace, type Space } from "../space.js";
import { browseDirectory, listRoots } from "../space/browse.js";
import { ReverseRequests } from "./reverse.js";
import { errorResponse, parseRequest, RpcFault, type RpcId } from "./json-rpc.js";

/** 协议后端的装配选项，用于指定应用配置、插件和 Agent 运行时。 */
export interface ServerOptions {
  home?: string;
  port?: number;
  token?: string;
  plugins?: Plugin[];
  runtime?: AgentRuntime;
  /** 是否提供通用 Agent；学习者版本关掉它。默认提供。 */
  generalAgent?: boolean;
  /** 用户能直接对话的 Agent；省略时按各定义的 direct，通用 Agent 默认可以。 */
  directAgents?: string[];
}

/** 运行中的协议后端；嵌入宿主用它交付连接并等待保存、收尾完成。 */
export interface RepaServer {
  connection: { url: string; token: string };
  closed: Promise<void>;
  close(): Promise<void>;
}

interface Peer {
  socket: WebSocket;
  authenticated: boolean;
  subscribed: boolean;
  alive: boolean;
  /** initialize 里的声明；没有声明时为空对象。 */
  capabilities: ClientCapabilities;
  /** 初始化的先后，同一服务有多个提供方时交给最近初始化的连接。 */
  serial: number;
  logins: Set<AbortController>;
  /** 正在生成的反馈包；断线或关闭后端时取消，自述的模型调用不会一直挂着。 */
  feedbacks: Set<AbortController>;
}

type PendingData =
  | { kind: "confirm"; request: Confirmation }
  | {
    kind: "ask";
    request: NotificationParams<"ask.request">;
    onSubmit?: (response: ItemResponse) => Promise<AskSubmitResult>;
    /** 上一次提交处理完之前，不接受下一次提交。 */
    busy: boolean;
  }
  | { kind: "service"; service: string };

interface ActiveSpace {
  space: Space;
  plugins: PluginHost;
  agent: AgentSpace;
  backups: SpaceBackups;
}

/** 启动本机 HTTP 与 WebSocket 后端，返回连接凭据及可等待的关闭入口。 */
export async function startServer(options: ServerOptions = {}): Promise<RepaServer> {
  const token = options.token ?? randomBytes(32).toString("hex");
  if (token.length < 32) throw new RepaFault("invalid_token", "连接令牌至少需要 32 个字符");
  const home = resolveAppHome({ home: options.home });
  const settings = await SettingsStore.open(home);
  const runtime: AgentRuntime = options.runtime ?? await createAgentRuntime({ agentDir: path.join(home, "agent") });
  const serverId = randomUUID();
  const peers = new Set<Peer>();
  const reverse = new ReverseRequests<Peer, PendingData>();
  let initialized = 0;
  const owner = new AsyncLocalStorage<Peer>();
  const operations = new Set<Promise<unknown>>();
  let active: ActiveSpace | undefined;
  let stopping = false;
  let closePromise: Promise<void> | undefined;
  let lifecycle = Promise.resolve();
  let finishClosed: () => void;
  const closed = new Promise<void>((resolve) => {
    finishClosed = resolve;
  });
  const http = createServer((_request, response) => response.writeHead(404).end());
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
    perMessageDeflate: false,
  });

  // 发给前端的错误事件同时记一份，反馈包从这里取；后端没有日志文件。
  const recordError = (method: Notification, params: unknown) => {
    if (method === "session.event" && Check(notifications["session.event"], params) && params.type === "error") {
      const data = params.data;
      const code = data !== null && typeof data === "object" && "code" in data && typeof data.code === "string" ? data.code : undefined;
      errors.add({ source: `session:${params.sessionId}`, message: params.text ?? "", ...(code === undefined ? {} : { code }) });
    }
  };
  const send = (peer: Peer, value: unknown) => {
    if (!peer.alive || peer.socket.readyState !== WebSocket.OPEN) return;
    if (peer.socket.bufferedAmount > 8 * 1024 * 1024) {
      peer.socket.close(1013, "resynchronize");
      return;
    }
    peer.socket.send(JSON.stringify(value));
  };
  const errors = new RecentErrors(() => runtime.now());
  const emit = <N extends Notification>(method: N, params: NotificationParams<N>) => {
    if (!Check(notifications[method], params)) throw new RepaFault("invalid_event", "模块发出了无效事件");
    recordError(method, params);
    for (const peer of peers) {
      if (peer.subscribed) send(peer, { jsonrpc: "2.0", method, params });
    }
  };
  const cancelPeer = (peer: Peer) => {
    peer.alive = false;
    for (const controller of peer.logins) controller.abort();
    for (const controller of peer.feedbacks) controller.abort();
    reverse.endPeer(peer);
    peers.delete(peer);
  };
  const confirmFor = (peer: Peer | undefined): Confirm => (request, signal) => {
    if (!peer?.alive || !peer.authenticated || stopping || signal?.aborted) {
      return Promise.reject(new RepaFault("confirmation_cancelled", "当前没有可以接收确认的连接"));
    }
    if (!Check(notifications["confirm.request"].properties.request, request)) {
      return Promise.reject(new RepaFault("invalid_confirmation", "确认请求不符合接口要求"));
    }
    const pending = reverse.create<string | boolean | null>(peer, { kind: "confirm", request }, {
      signal,
      aborted: () => new RepaFault("confirmation_cancelled", "确认已取消"),
      disconnected: () => new RepaFault("confirmation_cancelled", "确认连接已断开"),
      closed: () => new RepaFault("confirmation_cancelled", "空间正在关闭"),
    });
    send(peer, { jsonrpc: "2.0", method: "confirm.request", params: { id: pending.id, request } });
    return pending.result;
  };
  /**
   * 对话里的询问只发给发起这次运行的连接：断线、运行中止和关空间都结束询问。
   * 连接没有声明 Item 需要的能力时不发送，直接得到 unsupported。
   */
  const askFor = (peer: Peer | undefined): AskRoute => (input, options) => {
    const signal = options.signal;
    if (!peer?.alive || !peer.authenticated || stopping) {
      return Promise.reject(new RepaFault("ask_unavailable", "当前运行没有可以作答的连接"));
    }
    if (signal?.aborted) return Promise.reject(new RepaFault("ask_cancelled", "询问已取消：运行已中止", { reason: "aborted" }));
    if (!canRender(peer.capabilities.interaction, input.item)) return Promise.resolve({ action: "unsupported" });
    // 编号由待答表生成；校验时用合法占位值，避免无效请求进入表。
    if (!Check(notifications["ask.request"], { id: "pending", ...input })) return Promise.reject(new RepaFault("invalid_ask", "询问不符合交互词汇"));
    const data: Extract<PendingData, { kind: "ask" }> = { kind: "ask", request: { id: "pending", ...input }, onSubmit: options.onSubmit, busy: false };
    const pending = reverse.create<AskOutcome>(peer, data, {
      signal,
      aborted: () => new RepaFault("ask_cancelled", "询问已取消：运行已中止", { reason: "aborted" }),
      disconnected: () => new RepaFault("ask_cancelled", "用户没有作答：连接已断开", { reason: "disconnected" }),
      closed: () => new RepaFault("ask_cancelled", "询问已取消：空间正在关闭", { reason: "closed" }),
      notifyClosed: (id, reason) => send(peer, { jsonrpc: "2.0", method: "ask.closed", params: { id, reason } }),
    });
    data.request.id = pending.id;
    send(peer, { jsonrpc: "2.0", method: "ask.request", params: data.request });
    return pending.result;
  };

  const replyAsk = async (peer: Peer, input: Params<"ask.reply">): Promise<AskSubmitResult | null> => {
    const pending = reverse.get(input.id);
    if (!pending || pending.peer !== peer || pending.data.kind !== "ask") throw new RepaFault("ask_not_found", "询问不存在、已经结束或不属于当前连接");
    const data = pending.data;
    const response = input.response;
    if ((response !== undefined) !== (input.action === "submit") || (input.message !== undefined && input.action !== "decline")) {
      throw new RepaFault("invalid_ask_reply", "response 只随 submit，message 只随 decline");
    }
    if (input.action === "decline") {
      pending.end({ value: { action: "decline", ...(input.message === undefined ? {} : { message: input.message }) } }, "answered");
      return null;
    }
    if (input.action === "cancel" || input.action === "unsupported") {
      pending.end({ value: { action: input.action } }, "cancelled");
      return null;
    }
    // 前面已确认 submit 带了作答；这里再查一次，类型上也就收窄了。
    if (response === undefined) throw new RepaFault("invalid_ask_reply", "提交需要带上作答");
    if (data.busy) throw new RepaFault("ask_busy", "上一次提交还在处理，请稍后再交");
    const checked = checkResponse(data.request.item, response);
    if (!checked.ok) return { status: "invalid", problems: checked.problems };
    let result: AskSubmitResult = { status: "accepted" };
    if (data.onSubmit !== undefined) {
      data.busy = true;
      try {
        result = await data.onSubmit(response);
      } catch {
        // 调用方处理失败时询问保持打开，用户可以再交或不按卡片作答；不把插件内部错误交给前端。
        throw new RepaFault("ask_submit_failed", "这次作答没能处理，请再交一次或换一种方式回答");
      } finally {
        data.busy = false;
      }
      if (!Check(AskSubmitResultSchema, result)) throw new RepaFault("ask_submit_failed", "调用方对这次作答的处理结果不符合交互词汇");
    }
    // 处理期间询问可能已经因为中止、断线或关空间结束；结果不再交回。
    if (reverse.get(input.id) !== pending) throw new RepaFault("ask_not_found", "询问已经结束");
    if (result.status === "invalid") return result;
    pending.end({ value: { action: "submit", response } }, "answered");
    return result;
  };
  /**
   * 前端服务的路由：优先交给发起当前操作的连接，它没有声明时交给最近初始化、声明了这项服务的连接。
   * 中止、断线和关空间都结束请求，失败不自动换连接重试。
   */
  const serviceFor = (initiator: Peer | undefined): Services["call"] => (service, input, options = {}) => {
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(new RepaFault("service_cancelled", "服务请求已取消", { service, reason: "aborted" }));
    const provides = (peer: Peer) => peer.alive && peer.authenticated && (peer.capabilities.services ?? []).includes(service);
    const target = initiator !== undefined && provides(initiator)
      ? initiator
      : [...peers].filter(provides).sort((left, right) => right.serial - left.serial)[0];
    if (stopping || target === undefined) return Promise.reject(new RepaFault("service_unavailable", "没有连接提供这项服务", { service }));
    // 只转交 JSON 数据；先序列化一次，既拦下不能传输的值，也让之后对原对象的修改不影响请求。
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(input);
    } catch {
      encoded = undefined;
    }
    if (encoded === undefined) return Promise.reject(new RepaFault("invalid_service_input", "服务输入必须是 JSON 数据", { service }));
    const pending = reverse.create<unknown>(target, { kind: "service", service }, {
      signal,
      aborted: () => new RepaFault("service_cancelled", "服务请求已取消", { service, reason: "aborted" }),
      disconnected: () => new RepaFault("service_cancelled", "提供服务的连接已断开", { service, reason: "disconnected" }),
      closed: () => new RepaFault("service_cancelled", "服务请求已取消：空间正在关闭", { service, reason: "closed" }),
      notifyClosed: (id, reason) => send(target, { jsonrpc: "2.0", method: "service.closed", params: { id, reason } }),
    });
    send(target, { jsonrpc: "2.0", method: "service.request", params: { id: pending.id, service, input: JSON.parse(encoded) as unknown } });
    return pending.result;
  };

  const requireActive = (): ActiveSpace => {
    if (!active) throw new RepaFault("space_not_open", "请先打开空间");
    return active;
  };
  const closeActive = async () => {
    const current = active;
    active = undefined;
    if (!current) return;
    // 登录确认不属于空间；只结束命令确认，以及空间里的询问和服务。
    reverse.endWhere((data) => data.kind !== "confirm" || data.request.kind === "command");
    const failures: unknown[] = [];
    // 先停止 Agent，再关插件，写入者都停下以后备份最后一次；最后空间落盘并释放锁。每个 owner 都取得收尾机会。
    // 关闭时的备份在释放空间锁之前完成，上一次使用的改动不必等到下次打开才进入备份。
    for (const close of [() => current.agent.close(), () => current.plugins.close(), () => current.backups.close(), () => current.space.close()]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "关闭空间失败");
  };
  const serializeLifecycle = <T>(action: () => Promise<T>): Promise<T> => {
    const result = lifecycle.then(action);
    lifecycle = result.then(() => undefined, () => undefined);
    return result;
  };
  const loadSpace = (root: string, create: boolean) => serializeLifecycle(async () => {
    if (stopping) throw new RepaFault("closed", "服务正在关闭");
    const resolved = path.resolve(root);
    if (active?.space.root === resolved && !create) return { root: resolved, disabledPlugins: active.plugins.disabled() };
    await closeActive();
    // 插件写入与 Agent 的写入工具共用同一文件的写入队列。
    const space = await (create ? createSpace : openSpace)(resolved, { fileQueue: withFileMutationQueue });
    let plugins: PluginHost | undefined;
    let agent: AgentSpace | undefined;
    try {
      plugins = await openPluginHost({
        space,
        plugins: options.plugins ?? [],
        now: () => runtime.now(),
        ask: (request, askOptions) => askFor(owner.getStore())(request, askOptions),
        services: { call: (service, input, callOptions) => serviceFor(owner.getStore())(service, input, callOptions) },
        // 插件导出数据与反馈包用同一套脱敏：保存的凭据由运行时读出，读不到时导出失败。
        exports: { home, credentials: () => runtime.credentials() },
        models: (pluginId) => ({
          complete: (request) => runtime.complete(request, { pluginId, root: space.root, sessionsDir: space.sessionsDir }),
          completeStructured: (request, schema) => runtime.completeStructured(request, schema, { pluginId, root: space.root, sessionsDir: space.sessionsDir }),
          runAgent: (task) => {
            if (!agent) return Promise.reject(new RepaFault("space_not_ready", "空间尚未完成打开"));
            return agent.runAgent(task);
          },
          defaultModel: () => runtime.defaultModel(),
        }),
        async abortAgent(id) {
          if (!agent) {
            throw new RepaFault("space_not_ready", "空间尚未完成打开");
          }
          await agent.abortAgent(id);
        },
        emit: (pluginId, event) => emit("plugin.event", { pluginId, event }),
        onError: (error) => {
          errors.add({ source: "plugin-host", message: error instanceof Error ? error.message : String(error), code: "plugin_failed", ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}) });
          emit("plugin.event", { pluginId: "host", event: { type: "error", code: "plugin_failed" } });
        },
      });
      const host = plugins;
      // 停用的插件不提供 Agent，装配点名的直接对话 Agent 可能因此不在：这时去掉不在的，空间照常打开，停用原因已在 disabledPlugins 里。
      // 没有插件停用时原样交给运行时核对，写错的 id 仍报 unknown_agent。
      let directAgents = options.directAgents;
      if (directAgents !== undefined && host.disabled().length > 0) {
        const available = new Set([...(options.generalAgent === false ? [] : ["general"]), ...host.agents().map((definition) => definition.id)]);
        directAgents = directAgents.filter((id) => available.has(id));
      }
      agent = await runtime.openSpace({
        root: space.root,
        sessionsDir: space.sessionsDir,
        instructions: () => host.instructions(),
        tools: () => host.tools(),
        views: () => host.views(),
        agents: () => host.agents(),
        generalAgent: options.generalAgent,
        directAgents,
        overrides: () => settings.overrides(space.root),
        commandPolicy: () => settings.get().commandPolicy,
        record: async (runId, action) => (await space.record({ kind: "agent", runId }, action)).value,
        writes: space.writes,
        onEvent: (event) => emit("session.event", event),
        confirm: (request, signal) => confirmFor(owner.getStore())(request, signal),
        ask: (request, askOptions) => askFor(owner.getStore())(request, askOptions),
      });
      await host.start();
      await settings.remember(space.root);
      const backups = new SpaceBackups({
        home,
        space,
        now: () => runtime.now(),
        settings: () => settings.get().backup,
        onUpdate: (status) => emit("backup.updated", status),
        onError: (error) => {
          errors.add({
            source: "backup",
            message: error instanceof Error ? error.message : String(error),
            ...(error instanceof Error && "code" in error && typeof error.code === "string" ? { code: error.code } : {}),
          });
        },
      });
      active = { space, plugins, agent, backups };
      backups.start();
      return { root: space.root, disabledPlugins: plugins.disabled() };
    } catch (error) {
      await agent?.close().catch(() => undefined);
      await plugins?.close().catch(() => undefined);
      await space.close().catch(() => undefined);
      throw error;
    }
  });

  // 前端只能与可直接对话的 Agent 建会话和发消息；后台任务与子 Agent 不经过这里。
  const requireDirect = (agent: AgentSpace, id: string) => {
    const info = agent.agents().find((item) => item.id === id);
    if (!info) throw new RepaFault("agent_not_found", "Agent 不存在或未启用", { agent: id });
    if (!info.direct) throw new RepaFault("agent_not_direct", "这个 Agent 不能直接对话", { agent: id });
  };
  const directSession = async (sessionId: string) => {
    const { agent } = requireActive();
    const session = await agent.get(sessionId);
    requireDirect(agent, session.info().agent);
    return session;
  };

  const dispatch = async (peer: Peer, method: Method, params: unknown): Promise<unknown> => {
    const p = <M extends Method>() => params as Params<M>;
    switch (method) {
      case "initialize": {
        const input = p<"initialize">();
        const supplied = Buffer.from(input.token);
        const expected = Buffer.from(token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new RpcFault(-32001, "连接授权失败");
        if (input.version !== PROTOCOL_VERSION) throw new RpcFault(-32002, "协议版本不兼容");
        peer.authenticated = true;
        peer.capabilities = input.capabilities ?? {};
        peer.serial = ++initialized;
        return { version: PROTOCOL_VERSION, serverId };
      }
      case "space.list":
        return settings.get().recentSpaces;
      case "space.open":
        return loadSpace(p<"space.open">().root, false);
      case "space.create":
        return loadSpace(p<"space.create">().root, true);
      case "space.close":
        await serializeLifecycle(closeActive);
        return null;
      case "space.roots":
        return listRoots();
      case "space.browse":
        return browseDirectory(p<"space.browse">().path);
      case "agent.list":
        return requireActive().agent.agents();
      case "session.list":
        return requireActive().agent.list();
      case "session.create": {
        const input = p<"session.create">();
        const { agent } = requireActive();
        const id = input.agent ?? "general";
        requireDirect(agent, id);
        return (await agent.create({ agent: id, model: input.model })).info();
      }
      case "session.history":
        return (await requireActive().agent.get(p<"session.history">().sessionId)).history();
      case "session.send": {
        const input = p<"session.send">();
        await (await directSession(input.sessionId)).send(input.text);
        return null;
      }
      case "session.steer": {
        const input = p<"session.steer">();
        await (await directSession(input.sessionId)).steer(input.text);
        return null;
      }
      case "session.followUp": {
        const input = p<"session.followUp">();
        await (await directSession(input.sessionId)).followUp(input.text);
        return null;
      }
      case "session.abort":
        await (await requireActive().agent.get(p<"session.abort">().sessionId)).abort();
        return null;
      case "session.setModel": {
        const input = p<"session.setModel">();
        await (await requireActive().agent.get(input.sessionId)).setModel(input.model);
        return null;
      }
      case "session.compact":
        await (await requireActive().agent.get(p<"session.compact">().sessionId)).compact();
        return null;
      case "session.fork": {
        const input = p<"session.fork">();
        return (await (await directSession(input.sessionId)).fork(input.entryId)).info();
      }
      case "confirm.reply": {
        const input = p<"confirm.reply">();
        const pending = reverse.get(input.id);
        if (!pending || pending.peer !== peer || pending.data.kind !== "confirm") throw new RepaFault("confirmation_not_found", "确认不存在或不属于当前连接");
        const kind = pending.data.request.kind;
        if (
          (kind === "command" && typeof input.value !== "boolean" && input.value !== null) ||
          ((kind === "input" || kind === "select") && typeof input.value !== "string" && input.value !== null) ||
          (kind === "select" && typeof input.value === "string" && !pending.data.request.options?.includes(input.value))
        ) {
          throw new RepaFault("invalid_confirmation_reply", "确认回答不符合请求要求");
        }
        pending.end({ value: input.value });
        return null;
      }
      case "ask.reply":
        return replyAsk(peer, p<"ask.reply">());
      case "service.reply": {
        const input = p<"service.reply">();
        const pending = reverse.get(input.id);
        if (!pending || pending.peer !== peer || pending.data.kind !== "service") throw new RepaFault("service_request_not_found", "服务请求不存在、已经结束或不属于当前连接");
        if ("error" in input) {
          pending.end({ error: new RepaFault("service_failed", input.error.message, { service: pending.data.service, code: input.error.code }) });
        } else {
          pending.end({ value: input.result });
        }
        return null;
      }
      case "history.list":
        return requireActive().space.history.list(p<"history.list">().limit);
      case "history.changes":
        return requireActive().space.history.changes(p<"history.changes">().since);
      case "history.undo":
        return requireActive().space.history.undo(p<"history.undo">().revision);
      case "history.undoRun":
        return requireActive().space.history.undoRun(p<"history.undoRun">().runId);
      case "plugin.disabled":
        return requireActive().plugins.disabled();
      case "plugin.list":
        return requireActive().plugins.list();
      case "plugin.call": {
        const input = p<"plugin.call">();
        // 交给插件的是副本，插件改动它不会影响这个连接的路由。
        return requireActive().plugins.call(input.pluginId, input.method, input.input, { capabilities: structuredClone(peer.capabilities) });
      }
      case "prompt.list":
        return (await requireActive().agent.preview(p<"prompt.list">().agent)).sections;
      case "prompt.preview":
        return requireActive().agent.preview(p<"prompt.preview">().agent);
      case "prompt.set": {
        const input = p<"prompt.set">();
        await settings.setPrompt(
          input.scope,
          input.id,
          input.override,
          input.scope === "space" ? requireActive().space.root : active?.space.root,
        );
        return null;
      }
      case "prompt.reset": {
        const input = p<"prompt.reset">();
        await settings.setPrompt(
          input.scope,
          input.id,
          undefined,
          input.scope === "space" ? requireActive().space.root : active?.space.root,
        );
        return null;
      }
      case "model.list":
        return runtime.listModels();
      case "model.providers":
        return runtime.listProviders();
      case "model.getDefault":
        return runtime.defaultModel() ?? null;
      case "model.setDefault":
        await runtime.setDefaultModel(p<"model.setDefault">().model);
        return null;
      case "auth.login": {
        const input = p<"auth.login">();
        const controller = new AbortController();
        peer.logins.add(controller);
        try {
          await runtime.login(input.provider, input.type, confirmFor(peer), controller.signal);
        } catch {
          throw new RepaFault(
            controller.signal.aborted ? "login_cancelled" : "login_failed",
            controller.signal.aborted ? "登录已取消" : "登录失败，请检查连接与输入",
          );
        } finally {
          controller.abort();
          peer.logins.delete(controller);
        }
        return null;
      }
      case "auth.setKey": {
        const input = p<"auth.setKey">();
        try {
          await runtime.setKey(input.provider, input.key);
        } catch (error) {
          // requires_interactive_login 告诉前端改走 auth.login，不能被合并成笼统的失败。
          if (error instanceof RepaFault) throw error;
          throw new RepaFault("auth_failed", "保存模型凭据失败");
        }
        return null;
      }
      case "auth.logout":
        try {
          await runtime.logout(p<"auth.logout">().provider);
        } catch {
          throw new RepaFault("auth_failed", "删除模型凭据失败");
        }
        return null;
      case "feedback.create": {
        const input = p<"feedback.create">();
        const current = requireActive();
        const controller = new AbortController();
        peer.feedbacks.add(controller);
        try {
          return await createFeedbackBundle({
            now: () => runtime.now(),
            home,
            root: current.space.root,
            agent: current.agent,
            history: current.space.history,
            complete: (request) => runtime.complete(request),
            credentials: () => runtime.credentials(),
            errors,
            commandPolicy: settings.get().commandPolicy,
            plugins: current.plugins.list(),
          }, input, controller.signal);
        } finally {
          peer.feedbacks.delete(controller);
        }
      }
      case "settings.get":
        return settings.get();
      case "settings.set": {
        const result = await settings.set(p<"settings.set">());
        active?.backups.reschedule();
        return result;
      }
      case "backup.status":
        return active === undefined ? null : active.backups.status();
      case "backup.create": {
        const { backups } = requireActive();
        try {
          return await backups.check();
        } catch (error) {
          // 原因已记进备份状态，设置页从那里显示；这里给调用方可以分支的错误码。
          if (error instanceof RepaFault) throw error;
          throw new RepaFault("backup_failed", `备份没有完成：${error instanceof Error ? error.message : String(error)}`, {
            ...(error instanceof Error && "code" in error && typeof error.code === "string" ? { code: error.code } : {}),
          });
        }
      }
      case "backup.list":
        return listBackups(home);
      case "backup.restore": {
        const input = p<"backup.restore">();
        if (active?.space.root === input.root) throw new RepaFault("space_locked", "空间正在使用，关闭空间以后再恢复", { root: input.root });
        const before = await restoreInPlace({ home, root: input.root, id: input.id, now: runtime.now() });
        emit("backup.updated", await groupStatus(home, input.root));
        return before;
      }
      case "backup.restoreTo": {
        const input = p<"backup.restoreTo">();
        return { root: await restoreToNew({ home, root: input.root, id: input.id, target: input.target }) };
      }
      case "backup.delete": {
        const input = p<"backup.delete">();
        await deleteBackup(home, input.root, input.id);
        emit("backup.updated", active?.space.root === input.root ? await active.backups.status() : await groupStatus(home, input.root));
        return null;
      }
    }
  };

  const handle = async (peer: Peer, value: unknown): Promise<(() => unknown) | undefined> => {
    let id: RpcId = null;
    let notification = false;
    try {
      const request = parseRequest(value);
      notification = !Object.hasOwn(request, "id");
      id = request.id ?? null;
      // Repa 的操作需要响应确认，客户端 notification 不触发副作用。
      if (notification) return undefined;
      if (stopping || !peer.alive) throw new RepaFault("closed", "服务或连接已经关闭");
      if (!peer.authenticated && request.method !== "initialize") throw new RpcFault(-32001, "请先授权连接");
      if (!Object.hasOwn(methods, request.method)) throw new RpcFault(-32601, "Method not found");
      const method = request.method as Method;
      const params = request.params === undefined ? {} : request.params;
      if (!Check(methods[method].params, params)) throw new RpcFault(-32602, "Invalid params");
      const result = await owner.run(peer, () => dispatch(peer, method, params));
      // 响应即将写入时才订阅并取基线；批量请求也等全部完成后同步生成响应。
      // 从订阅、内存投影到 socket.send 之间没有 await，之后的广播只能排在响应后面。
      return () => {
        let output = result;
        if (method === "initialize") {
          peer.subscribed = true;
          output = {
            version: PROTOCOL_VERSION,
            serverId,
            baseline: {
              space: active === undefined ? null : { root: active.space.root },
              sessions: active?.agent.baseline() ?? [],
              disabledPlugins: active?.plugins.disabled() ?? [],
            },
          };
        }
        if (!Check(methods[method].result, output)) return errorResponse(id, new RpcFault(-32603, "Internal error"));
        return { jsonrpc: "2.0", id, result: output };
      };
    } catch (error) {
      if (notification) return undefined;
      // 内部错误不把细节交给前端，记进最近错误，反馈包里能看到原因。
      if (!(error instanceof RpcFault) && !(error instanceof RepaFault)) {
        errors.add({ source: "rpc", message: error instanceof Error ? error.message : String(error), ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}) });
      }
      const fault = error instanceof RpcFault ? error : error instanceof RepaFault
        ? new RpcFault(-32000, error.message, { code: error.code, ...(error.details === undefined ? {} : { details: error.details }) })
        : new RpcFault(-32603, "Internal error");
      return () => errorResponse(id, fault);
    }
  };
  http.on("upgrade", (request, socket, head) => {
    if (stopping || request.url !== "/rpc") {
      socket.destroy();
      return;
    }
    websocket.handleUpgrade(request, socket, head, (socket) => websocket.emit("connection", socket));
  });
  websocket.on("connection", (socket) => {
    const peer: Peer = {
      socket,
      authenticated: false,
      subscribed: false,
      alive: true,
      capabilities: {},
      serial: 0,
      logins: new Set(),
      feedbacks: new Set(),
    };
    peers.add(peer);
    const timer = setTimeout(() => {
      if (!peer.authenticated) socket.close(4001, "authentication required");
    }, 5000);
    timer.unref();
    socket.on("close", () => {
      clearTimeout(timer);
      cancelPeer(peer);
    });
    socket.on("error", () => {
      cancelPeer(peer);
      socket.terminate();
    });
    socket.on("message", (data, binary) => {
      const operation = (async () => {
        if (binary) {
          send(peer, errorResponse(null, new RpcFault(-32600, "Invalid Request")));
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(data.toString());
        } catch {
          send(peer, errorResponse(null, new RpcFault(-32700, "Parse error")));
          return;
        }
        if (Array.isArray(value)) {
          if (!value.length) {
            send(peer, errorResponse(null, new RpcFault(-32600, "Invalid Request")));
            return;
          }
          const replies = (await Promise.all(value.map((item) => handle(peer, item)))).filter((item) => item !== undefined);
          if (replies.length) send(peer, replies.map((reply) => reply()));
        } else {
          const reply = await handle(peer, value);
          if (reply !== undefined) send(peer, reply());
        }
      })();
      operations.add(operation);
      operation.then(
        () => operations.delete(operation),
        () => {
          operations.delete(operation);
          socket.terminate();
        },
      );
    });
  });

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    stopping = true;
    closePromise = (async () => {
      const failures: unknown[] = [];
      for (const peer of peers) {
        cancelPeer(peer);
        peer.socket.terminate();
      }
      const transport = Promise.all([
        new Promise<void>((resolve) => websocket.close(() => resolve())),
        new Promise<void>((resolve) => http.close(() => resolve())),
      ]);
      // 先取消运行时；打开空间时的初始插件任务也可能正在等待 Agent 回合。
      for (const stop of [() => runtime.close(), () => serializeLifecycle(closeActive)]) {
        try {
          await stop();
        } catch (error) {
          failures.push(error);
        }
      }
      await Promise.allSettled([...operations]);
      await transport;
      finishClosed();
      if (failures.length) throw new AggregateError(failures, "关闭服务失败");
    })();
    return closePromise;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(options.port ?? 0, "127.0.0.1", () => {
        http.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
  const address = http.address();
  if (!address || typeof address === "string") {
    await close();
    throw new RepaFault("listen_failed", "后端未取得本机端口");
  }
  return { connection: { url: `ws://127.0.0.1:${address.port}/rpc`, token }, closed, close };
}
