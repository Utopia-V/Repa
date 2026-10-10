import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Check } from "typebox/value";
import { WebSocket, WebSocketServer } from "ws";
import { createAgentRuntime, type AgentRuntime, type AgentSpace } from "../agent.js";
import type { Plugin } from "../plugin.js";
import { openPluginHost, type PluginHost } from "../plugins.js";
import {
  methods,
  notifications,
  PROTOCOL_VERSION,
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
  confirmations: Set<string>;
  logins: Set<AbortController>;
}

interface PendingConfirmation {
  peer: Peer;
  request: Confirmation;
  finish(value?: string | boolean | null, error?: Error): void;
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
    const space = await (create ? createSpace(resolved) : openSpace(resolved));
    let plugins: PluginHost | undefined;
    let agent: AgentSpace | undefined;
    try {
      plugins = await openPluginHost({
        space,
        plugins: options.plugins ?? [],
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
        overrides: () => settings.overrides(space.root),
        commandPolicy: () => settings.get().commandPolicy,
        record: async (runId, action) => (await space.record({ kind: "agent", runId }, action)).value,
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
      case "session.list":
        return requireActive().agent.list();
      case "session.create":
        return (await requireActive().agent.create(p<"session.create">().model)).info();
      case "session.history":
        return (await requireActive().agent.get(p<"session.history">().sessionId)).history();
      case "session.send": {
        const input = p<"session.send">();
        await (await requireActive().agent.get(input.sessionId)).send(input.text);
        return null;
      }
      case "session.steer": {
        const input = p<"session.steer">();
        await (await requireActive().agent.get(input.sessionId)).steer(input.text);
        return null;
      }
      case "session.followUp": {
        const input = p<"session.followUp">();
        await (await requireActive().agent.get(input.sessionId)).followUp(input.text);
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
        return (await (await requireActive().agent.get(input.sessionId)).fork(input.entryId)).info();
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
      case "history.list":
        return requireActive().space.history.list(p<"history.list">().limit);
      case "history.changes":
        return requireActive().space.history.changes(p<"history.changes">().since);
      case "history.undo":
        return requireActive().space.history.undo(p<"history.undo">().revision);
      case "plugin.list":
        return requireActive().plugins.list();
      case "plugin.call": {
        const input = p<"plugin.call">();
        return requireActive().plugins.call(input.pluginId, input.method, input.input);
      }
      case "prompt.list":
        return (await requireActive().agent.preview()).sections;
      case "prompt.preview":
        return requireActive().agent.preview();
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
      confirmations: new Set(),
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
