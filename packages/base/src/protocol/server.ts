import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Check } from "typebox/value";
import { WebSocket, WebSocketServer } from "ws";
import { createAgentRuntime, withFileMutationQueue, type AgentRuntime, type AgentSpace } from "../agent.js";
import type { AskRoute } from "../ask.js";
import {
  canRender,
  checkResponse,
  SubmitResultSchema,
  type AskClosed,
  type AskRequest,
  type ItemResponse,
  type SubmitResult,
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
import { errorResponse, parseRequest, RpcFault, type RpcId } from "./json-rpc.js";

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

export interface RepaServer {
  connection: { url: string; token: string };
  closed: Promise<void>;
  close(): Promise<void>;
}

interface Peer {
  socket: WebSocket;
  authenticated: boolean;
  alive: boolean;
  /** initialize 里的声明；没有声明时为空对象。 */
  capabilities: ClientCapabilities;
  /** 初始化的先后，同一服务有多个提供方时交给最近初始化的连接。 */
  serial: number;
  confirmations: Set<string>;
  asks: Set<string>;
  services: Set<string>;
  logins: Set<AbortController>;
}

interface PendingConfirmation {
  peer: Peer;
  request: Confirmation;
  finish(value?: string | boolean | null, error?: Error): void;
}

type AskEnd = { outcome: AskOutcome } | { error: RepaFault };

interface PendingAsk {
  peer: Peer;
  request: AskRequest;
  evaluate?: (response: ItemResponse) => Promise<SubmitResult>;
  /** 正在判分，同一询问的下一次提交要等它结束。 */
  busy: boolean;
  /** reason 有值时通知前端收起卡片；断线时连接已经不在，不通知。 */
  end(result: AskEnd, reason?: AskClosed["reason"]): void;
}

type ServiceEnd = { value: unknown } | { error: RepaFault };

interface PendingService {
  peer: Peer;
  service: string;
  /** reason 有值时通知前端停止这次请求。 */
  end(result: ServiceEnd, reason?: "aborted" | "closed"): void;
}

interface ActiveSpace {
  space: Space;
  plugins: PluginHost;
  agent: AgentSpace;
}

export async function startServer(options: ServerOptions = {}): Promise<RepaServer> {
  const token = options.token ?? randomBytes(32).toString("hex");
  if (token.length < 32) throw new RepaFault("invalid_token", "连接令牌至少需要 32 个字符");
  const home = path.resolve(options.home ?? process.env.REPA_HOME ?? path.join(os.homedir(), ".repa"));
  const settings = await SettingsStore.open(home);
  const runtime: AgentRuntime = options.runtime ?? await createAgentRuntime({ agentDir: path.join(home, "agent") });
  const serverId = randomUUID();
  const peers = new Set<Peer>();
  const confirmations = new Map<string, PendingConfirmation>();
  const asks = new Map<string, PendingAsk>();
  const services = new Map<string, PendingService>();
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

  const send = (peer: Peer, value: unknown) => {
    if (!peer.alive || peer.socket.readyState !== WebSocket.OPEN) return;
    if (peer.socket.bufferedAmount > 8 * 1024 * 1024) {
      peer.socket.close(1013, "resynchronize");
      return;
    }
    peer.socket.send(JSON.stringify(value));
  };
  const emit = <N extends Notification>(method: N, params: NotificationParams<N>) => {
    if (!Check(notifications[method], params)) throw new RepaFault("invalid_event", "模块发出了无效事件");
    for (const peer of peers) {
      if (peer.authenticated) send(peer, { jsonrpc: "2.0", method, params });
    }
  };
  const cancelPeer = (peer: Peer) => {
    peer.alive = false;
    for (const controller of peer.logins) controller.abort();
    for (const id of peer.confirmations) {
      confirmations.get(id)?.finish(
        undefined,
        new RepaFault("confirmation_cancelled", "确认连接已断开"),
      );
    }
    for (const id of [...peer.asks]) {
      asks.get(id)?.end({ error: new RepaFault("ask_cancelled", "用户没有作答：连接已断开", { reason: "disconnected" }) });
    }
    for (const id of [...peer.services]) {
      const pending = services.get(id);
      pending?.end({ error: new RepaFault("service_cancelled", "提供服务的连接已断开", { service: pending.service, reason: "disconnected" }) });
    }
    peers.delete(peer);
  };
  const confirmFor = (peer: Peer | undefined): Confirm => (request, signal) => {
    if (!peer?.alive || !peer.authenticated || stopping || signal?.aborted) {
      return Promise.reject(new RepaFault("confirmation_cancelled", "当前没有可以接收确认的连接"));
    }
    if (!Check(notifications["confirm.request"].properties.request, request)) {
      return Promise.reject(new RepaFault("invalid_confirmation", "确认请求不符合接口要求"));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => pending.finish(undefined, new RepaFault("confirmation_cancelled", "确认已取消"));
      const pending: PendingConfirmation = {
        peer,
        request,
        finish(value, error) {
          if (!confirmations.delete(id)) return;
          peer.confirmations.delete(id);
          signal?.removeEventListener("abort", abort);
          if (error) reject(error);
          else resolve(value ?? null);
        },
      };
      confirmations.set(id, pending);
      peer.confirmations.add(id);
      signal?.addEventListener("abort", abort, { once: true });
      send(peer, { jsonrpc: "2.0", method: "confirm.request", params: { id, request } });
    });
  };
  /**
   * 对话里的询问只发给发起这次运行的连接，沿用确认通道的待答表、连接绑定和取消：断线、运行中止和关空间都结束询问。
   * 连接没有声明这道题需要的能力时不发送，直接得到 unsupported。
   */
  const askFor = (peer: Peer | undefined): AskRoute => (input, options) => {
    const signal = options.signal;
    if (!peer?.alive || !peer.authenticated || stopping) {
      return Promise.reject(new RepaFault("ask_unavailable", "当前运行没有可以作答的连接"));
    }
    if (signal?.aborted) return Promise.reject(new RepaFault("ask_cancelled", "询问已取消：运行已中止", { reason: "aborted" }));
    if (!canRender(peer.capabilities.interaction, input.item)) return Promise.resolve({ action: "unsupported" });
    const id = randomUUID();
    const request: AskRequest = { id, ...input };
    if (!Check(notifications["ask.request"], request)) return Promise.reject(new RepaFault("invalid_ask", "询问不符合交互词汇"));
    return new Promise<AskOutcome>((resolve, reject) => {
      const abort = () => pending.end({ error: new RepaFault("ask_cancelled", "询问已取消：运行已中止", { reason: "aborted" }) }, "aborted");
      const pending: PendingAsk = {
        peer,
        request,
        ...(options.evaluate === undefined ? {} : { evaluate: options.evaluate }),
        busy: false,
        end(result, reason) {
          if (asks.get(id) !== pending) return;
          asks.delete(id);
          peer.asks.delete(id);
          signal?.removeEventListener("abort", abort);
          if (reason !== undefined) send(peer, { jsonrpc: "2.0", method: "ask.closed", params: { id, reason } });
          if ("error" in result) reject(result.error);
          else resolve(result.outcome);
        },
      };
      asks.set(id, pending);
      peer.asks.add(id);
      signal?.addEventListener("abort", abort, { once: true });
      send(peer, { jsonrpc: "2.0", method: "ask.request", params: request });
    });
  };
  const replyAsk = async (peer: Peer, input: Params<"ask.reply">): Promise<SubmitResult | null> => {
    const pending = asks.get(input.id);
    if (!pending || pending.peer !== peer) throw new RepaFault("ask_not_found", "询问不存在、已经结束或不属于当前连接");
    const response = input.response;
    if ((response !== undefined) !== (input.action === "submit") || (input.message !== undefined && input.action !== "decline")) {
      throw new RepaFault("invalid_ask_reply", "response 只随 submit，message 只随 decline");
    }
    if (input.action === "decline") {
      pending.end({ outcome: { action: "decline", ...(input.message === undefined ? {} : { message: input.message }) } }, "answered");
      return null;
    }
    if (input.action === "cancel" || input.action === "unsupported") {
      pending.end({ outcome: { action: input.action } }, "cancelled");
      return null;
    }
    // 前面已确认 submit 带了作答；这里再查一次，类型上也就收窄了。
    if (response === undefined) throw new RepaFault("invalid_ask_reply", "提交需要带上作答");
    if (pending.busy) throw new RepaFault("ask_busy", "上一次提交还在判分，请稍后再交");
    const item = pending.request.item;
    const checked = checkResponse(item, response);
    if (!checked.ok) return { status: "rejected", problems: checked.problems };
    let result: SubmitResult = { status: "recorded" };
    if (pending.evaluate !== undefined) {
      pending.busy = true;
      try {
        result = await pending.evaluate(response);
      } catch {
        // 插件判分失败时询问保持打开，用户可以再交或不按卡片作答；不把插件内部错误交给前端。
        throw new RepaFault("ask_evaluation_failed", "这次作答没能判分，请再交一次或换一种方式回答");
      } finally {
        pending.busy = false;
      }
      const matches = (reference: { id: string; version: string }) => reference.id === item.id && reference.version === item.version;
      if (!Check(SubmitResultSchema, result) || (result.status === "recorded" && result.feedback !== undefined && !matches(result.feedback.item))) {
        throw new RepaFault("ask_evaluation_failed", "插件的判分结果不符合交互词汇");
      }
    }
    // 判分期间询问可能已经因为中止、断线或关空间结束；结果不再交回。
    if (asks.get(input.id) !== pending) throw new RepaFault("ask_not_found", "询问已经结束");
    if (result.status === "rejected") return result;
    pending.end({ outcome: { action: "submit", response, result } }, "answered");
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
    const params = { id: randomUUID(), service, input: JSON.parse(encoded) as unknown };
    const { id } = params;
    return new Promise<unknown>((resolve, reject) => {
      const abort = () => pending.end({ error: new RepaFault("service_cancelled", "服务请求已取消", { service, reason: "aborted" }) }, "aborted");
      const pending: PendingService = {
        peer: target,
        service,
        end(result, reason) {
          if (services.get(id) !== pending) return;
          services.delete(id);
          target.services.delete(id);
          signal?.removeEventListener("abort", abort);
          if (reason !== undefined) send(target, { jsonrpc: "2.0", method: "service.closed", params: { id, reason } });
          if ("error" in result) reject(result.error);
          else resolve(result.value);
        },
      };
      services.set(id, pending);
      target.services.add(id);
      signal?.addEventListener("abort", abort, { once: true });
      send(target, { jsonrpc: "2.0", method: "service.request", params });
    });
  };
  const requireActive = (): ActiveSpace => {
    if (!active) throw new RepaFault("space_not_open", "请先打开空间");
    return active;
  };
  const closeActive = async () => {
    const current = active;
    active = undefined;
    if (!current) return;
    for (const pending of confirmations.values()) {
      if (pending.request.kind === "command") {
        pending.finish(undefined, new RepaFault("confirmation_cancelled", "空间正在关闭"));
      }
    }
    // 询问和服务请求都出自这个空间的运行和插件；先结束它们，插件宿主关闭时才不会一直等前端。
    for (const pending of [...asks.values()]) {
      pending.end({ error: new RepaFault("ask_cancelled", "询问已取消：空间正在关闭", { reason: "closed" }) }, "closed");
    }
    for (const pending of [...services.values()]) {
      pending.end({ error: new RepaFault("service_cancelled", "服务请求已取消：空间正在关闭", { service: pending.service, reason: "closed" }) }, "closed");
    }
    const failures: unknown[] = [];
    // 先停止 Agent，再关插件；最后空间落盘并释放锁。每个 owner 都取得收尾机会。
    for (const close of [() => current.agent.close(), () => current.plugins.close(), () => current.space.close()]) {
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
    if (active?.space.root === resolved && !create) return { root: resolved };
    await closeActive();
    // 插件写入与 Agent 的写入工具共用同一文件的写入队列。
    const space = await (create ? createSpace : openSpace)(resolved, { fileQueue: withFileMutationQueue });
    let plugins: PluginHost | undefined;
    let agent: AgentSpace | undefined;
    try {
      plugins = await openPluginHost({
        space,
        plugins: options.plugins ?? [],
        ask: (request, askOptions) => askFor(owner.getStore())(request, askOptions),
        services: { call: (service, input, callOptions) => serviceFor(owner.getStore())(service, input, callOptions) },
        models: {
          complete: (request) => runtime.complete(request),
          completeStructured: (request, schema) => runtime.completeStructured(request, schema),
          runAgent: (task) => {
            if (!agent) return Promise.reject(new RepaFault("space_not_ready", "空间尚未完成打开"));
            return agent.runAgent(task);
          },
        },
        emit: (pluginId, event) => emit("plugin.event", { pluginId, event }),
        onError: () => emit("plugin.event", { pluginId: "host", event: { type: "error", code: "plugin_failed" } }),
      });
      const host = plugins;
      agent = await runtime.openSpace({
        root: space.root,
        sessionsDir: space.sessionsDir,
        instructions: () => host.instructions(),
        tools: () => host.tools(),
        views: () => host.views(),
        agents: () => host.agents(),
        generalAgent: options.generalAgent,
        directAgents: options.directAgents,
        overrides: () => settings.overrides(space.root),
        commandPolicy: () => settings.get().commandPolicy,
        record: async (runId, action) => (await space.record({ kind: "agent", runId }, action)).value,
        writes: space.writes,
        onEvent: (event) => emit("session.event", event),
        confirm: (request, signal) => confirmFor(owner.getStore())(request, signal),
      });
      await host.start();
      await settings.remember(space.root);
      active = { space, plugins, agent };
      return { root: space.root };
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
        const pending = confirmations.get(input.id);
        if (!pending || pending.peer !== peer) throw new RepaFault("confirmation_not_found", "确认不存在或不属于当前连接");
        const kind = pending.request.kind;
        if (
          (kind === "command" && typeof input.value !== "boolean" && input.value !== null) ||
          ((kind === "input" || kind === "select") && typeof input.value !== "string" && input.value !== null) ||
          (kind === "select" && typeof input.value === "string" && !pending.request.options?.includes(input.value))
        ) {
          throw new RepaFault("invalid_confirmation_reply", "确认回答不符合请求要求");
        }
        pending.finish(input.value);
        return null;
      }
      case "ask.reply":
        return replyAsk(peer, p<"ask.reply">());
      case "service.reply": {
        const input = p<"service.reply">();
        const pending = services.get(input.id);
        if (!pending || pending.peer !== peer) throw new RepaFault("service_request_not_found", "服务请求不存在、已经结束或不属于当前连接");
        if ("error" in input) {
          pending.end({ error: new RepaFault("service_failed", input.error.message, { service: pending.service, code: input.error.code }) });
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
        } catch {
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
      case "settings.get":
        return settings.get();
      case "settings.set":
        return settings.set(p<"settings.set">());
    }
  };

  const handle = async (peer: Peer, value: unknown): Promise<unknown | undefined> => {
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
      if (!Check(methods[method].result, result)) throw new RpcFault(-32603, "Internal error");
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      if (notification) return undefined;
      const fault = error instanceof RpcFault ? error : error instanceof RepaFault
        ? new RpcFault(-32000, error.message, { code: error.code, ...(error.details === undefined ? {} : { details: error.details }) })
        : new RpcFault(-32603, "Internal error");
      return errorResponse(id, fault);
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
      alive: true,
      capabilities: {},
      serial: 0,
      confirmations: new Set(),
      asks: new Set(),
      services: new Set(),
      logins: new Set(),
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
          if (replies.length) send(peer, replies);
        } else {
          const reply = await handle(peer, value);
          if (reply !== undefined) send(peer, reply);
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
