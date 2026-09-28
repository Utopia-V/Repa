import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { Check } from "typebox/value";
import { RepaApplication, type ApplicationOptions } from "./application.js";
import { contentMethods, type ContentMethod } from "./content/protocol.js";
import { spaceMethods, type SpaceMethod } from "./spaces/schema.js";
import {
  methods,
  PROTOCOL_VERSION,
  protocolSchema,
  RepaFault,
  type Method,
  type Params,
} from "./protocol.js";

export interface Connection {
  url: string;
  token: string;
}
export interface ServerOptions extends ApplicationOptions {
  port?: number;
  token?: string;
  disconnectGraceMs?: number;
}
export interface RepaServer {
  connection: Connection;
  application: RepaApplication;
  closed: Promise<void>;
  close(mode?: "drain" | "cancel"): Promise<void>;
}
interface Peer {
  id: string;
  authenticated: boolean;
  attached: boolean;
  subscriptions: Map<string, () => void>;
  host?: FrontendHost;
}
interface FrontendHost {
  id: string;
  key: string;
  peers: Map<string, { peer: Peer; socket: WebSocket }>;
  timer?: ReturnType<typeof setTimeout>;
  closed: boolean;
}
class RpcFault extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export async function startRepaServer(
  options: ServerOptions = {},
): Promise<RepaServer> {
  const application = new RepaApplication(options);
  const token = options.token ?? randomBytes(32).toString("hex");
  const hosts = new Map<string, FrontendHost>();
  const hostId = (key: string) => createHash("sha256").update(key).digest("hex");
  if (token.length < 32) throw new Error("连接令牌至少需要 32 个字符。");
  const authorized = (candidate: unknown): boolean =>
    typeof candidate === "string" &&
    Buffer.byteLength(candidate) === Buffer.byteLength(token) &&
    timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
  const http = createServer((request, response) => { void (async () => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, Range, X-Repa-Host-Key",
    );
    response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
    response.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    const bearer = request.headers.authorization;
    if (
      !authorized(bearer?.startsWith("Bearer ") ? bearer.slice(7) : undefined)
    ) {
      response.writeHead(401).end();
      return;
    }
    const uploadSpace = /^\/spaces\/([a-zA-Z0-9_-]+)\/resources$/.exec(request.url ?? "")?.[1];
    if (request.method === "POST" && uploadSpace) {
      const key = request.headers["x-repa-host-key"];
      const host = typeof key === "string" ? hosts.get(hostId(key)) : undefined;
      if (!host || host.closed || host.key !== key) { response.writeHead(401).end(); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) { response.writeHead(413).end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      if (host.closed) { response.writeHead(409).end(); return; }
      const resource = await application.uploadResource(uploadSpace, Buffer.concat(chunks), request.headers["content-type"] ?? "application/octet-stream", host.id);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(resource));
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    if (request.url === "/protocol.json") {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(
        request.method === "HEAD" ? undefined : JSON.stringify(protocolSchema),
      );
      return;
    }
    const contentResource = /^\/spaces\/([a-zA-Z0-9_-]+)\/resources\/([a-f0-9]{64})$/.exec(request.url ?? "");
    if (contentResource) {
      const bytes = await application.contentResource(contentResource[1]!, contentResource[2]!);
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Content-Disposition", "attachment");
      response.setHeader("Accept-Ranges", "bytes");
      let start = 0, end = bytes.length - 1;
      if (request.headers.range) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        if (!range || (!range[1] && !range[2])) { response.writeHead(416, { "Content-Range": `bytes */${bytes.length}` }).end(); return; }
        if (range[1]) {
          start = Number(range[1]);
          if (range[2]) end = Math.min(end, Number(range[2]));
        } else start = Math.max(0, bytes.length - Number(range[2]));
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes.length) {
          response.writeHead(416, { "Content-Range": `bytes */${bytes.length}` }).end(); return;
        }
        response.statusCode = 206;
        response.setHeader("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
      }
      response.setHeader("Content-Length", Math.max(0, end - start + 1));
      response.end(request.method === "HEAD" ? undefined : bytes.subarray(start, end + 1));
      return;
    }
    response.writeHead(404).end();
  })().catch((error: unknown) => {
    if (response.headersSent) { response.destroy(); return; }
    response.writeHead(error instanceof RepaFault ? 400 : 500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ code: error instanceof RepaFault ? error.code : "storage", message: error instanceof Error ? error.message : String(error) }));
  }); });
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
    perMessageDeflate: false,
  });
  http.on("upgrade", (request, socket, head) => {
    if (request.url !== "/rpc") {
      socket.destroy();
      return;
    }
    websocket.handleUpgrade(request, socket, head, (peer) =>
      websocket.emit("connection", peer),
    );
  });
  const detachTimers = new Set<ReturnType<typeof setTimeout>>();
  const responsive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    application.checkpointResources();
    for (const peer of websocket.clients) {
      if (!responsive.has(peer)) {
        peer.terminate();
        continue;
      }
      responsive.delete(peer);
      peer.ping();
    }
  }, 30000);
  heartbeat.unref();

  websocket.on("connection", (socket) => {
    responsive.add(socket);
    socket.on("pong", () => responsive.add(socket));
    const peer: Peer = {
      id: randomUUID(),
      authenticated: false,
      attached: false,
      subscriptions: new Map(),
    };
    const timeout = setTimeout(
      () => socket.close(4001, "authentication required"),
      5000,
    );
    const send = (value: unknown) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 8 * 1024 * 1024) {
        socket.close(1013, "resynchronize");
        return;
      }
      socket.send(JSON.stringify(value));
    };
    const detach = (confirmed = false) => {
      const host = peer.host;
      if (!peer.attached || !host) return;
      peer.attached = false;
      host.peers.delete(peer.id);
      if (confirmed) {
        host.closed = true;
        clearTimeout(host.timer);
        if (host.timer) detachTimers.delete(host.timer);
        for (const item of host.peers.values()) { item.peer.attached = false; item.socket.close(1000, "detached"); }
        host.peers.clear(); hosts.delete(host.id);
        application.detach(host.id, true);
      } else if (!host.peers.size) {
        const timer = setTimeout(() => {
          detachTimers.delete(timer);
          if (!host.peers.size) { hosts.delete(host.id); application.detach(host.id); }
        }, options.disconnectGraceMs ?? 3000);
        timer.unref(); host.timer = timer; detachTimers.add(timer);
      }
    };
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      clearTimeout(timeout);
      for (const unsubscribe of peer.subscriptions.values()) unsubscribe();
      peer.subscriptions.clear();
      detach();
    });
    const dispatch = async (
      method: Method,
      params: unknown,
    ): Promise<unknown> => {
      const p = <M extends Method>() => params as Params<M>;
      if (Object.hasOwn(spaceMethods, method)) return application.spaceCall(method as SpaceMethod, p<SpaceMethod>());
      if (Object.hasOwn(contentMethods, method)) return application.contentCall(method as ContentMethod, p<ContentMethod>(), peer.host!.id);
      switch (method) {
        case "settings.get":
        case "settings.set":
        case "settings.reset": return application.settingsCall(method, p<typeof method>());
        case "initialize": {
          const input = p<"initialize">();
          if (!authorized(input.token))
            throw new RpcFault(-32001, "连接令牌无效。");
          if (!input.versions.includes(PROTOCOL_VERSION))
            throw new RpcFault(-32002, "没有共同支持的协议版本。", {
              supported: [PROTOCOL_VERSION],
            });
          if (!peer.authenticated) {
            // 恢复凭据证明宿主身份；客户端不能仅声明另一个宿主的 ID。
            const key = input.hostKey ?? randomBytes(32).toString("hex"), id = hostId(key);
            const host: FrontendHost = hosts.get(id) ?? { id, key, peers: new Map(), closed: false };
            clearTimeout(host.timer);
            if (host.timer) detachTimers.delete(host.timer);
            application.attach(id);
            host.peers.set(peer.id, { peer, socket });
            hosts.set(id, host); peer.host = host;
            peer.authenticated = true;
            peer.attached = true;
            clearTimeout(timeout);
          }
          if (input.hostKey && input.hostKey !== peer.host!.key) throw new RepaFault("permission_required", "连接不能切换成另一个前端宿主。");
          return {
            version: PROTOCOL_VERSION,
            serverId: application.id,
            hostKey: peer.host!.key,
            capabilities: [
              "sessions",
              "runs",
              "subscriptions",
              "resources",
              "interactions",
              "shutdown",
              "content",
              "learning-context",
              "prompt-settings",
              "resource-holds",
              "space-snapshots",
            ],
          };
        }
        case "space.open":
          return application.openSpace(p<"space.open">().path);
        case "space.list":
          return application.listSpaces();
        case "session.create":
          return application.createSession(p<"session.create">().spaceId);
        case "session.list":
          return application.listSessions(p<"session.list">().spaceId);
        case "session.get":
          return application.getSession(p<"session.get">());
        case "session.branch":
          return application.branchSession(p<"session.branch">());
        case "session.close":
          await application.closeSession(p<"session.close">());
          return null;
        case "session.remove":
          await application.removeSession(p<"session.remove">());
          return null;
        case "run.submit":
          return application.submit(p<"run.submit">());
        case "run.get": {
          const input = p<"run.get">();
          return application.getRun(input.spaceId, input.requestId);
        }
        case "run.cancel": {
          const input = p<"run.cancel">();
          return application.cancelRun(input.spaceId, input.requestId);
        }
        case "interaction.reply":
          application.reply(p<"interaction.reply">());
          return null;
        case "state.get":
          return application.snapshot(p<"state.get">().scope);
        case "subscription.start": {
          const input = p<"subscription.start">();
          peer.subscriptions.get(input.id)?.();
          peer.subscriptions.set(
            input.id,
            application.watch(input.scope, input.cursor, (delivery) =>
              send({
                jsonrpc: "2.0",
                method: "subscription.update",
                params: { id: input.id, delivery },
              }),
            ),
          );
          return null;
        }
        case "subscription.stop": {
          const input = p<"subscription.stop">();
          peer.subscriptions.get(input.id)?.();
          peer.subscriptions.delete(input.id);
          return null;
        }
        case "client.detach":
          setImmediate(() => {
            detach(true);
            socket.close(1000, "detached");
          });
          return null;
        case "shutdown": {
          const input = p<"shutdown">();
          setImmediate(() => application.shutdown(input.mode));
          return null;
        }
      }
    };
    const handle = async (value: unknown): Promise<unknown | undefined> => {
      let id: string | number | null = null;
      let notification = false;
      try {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new RpcFault(-32600, "Invalid Request");
        const request = value as Record<string, unknown>;
        if (
          request.jsonrpc !== "2.0" ||
          typeof request.method !== "string" ||
          ("id" in request &&
            request.id !== null &&
            typeof request.id !== "string" &&
            typeof request.id !== "number")
        )
          throw new RpcFault(-32600, "Invalid Request");
        notification = !("id" in request);
        id = notification ? null : (request.id as string | number | null);
        // Repa commands require acknowledgement. Client notifications do not initiate operations.
        if (notification) return undefined;
        if (!peer.authenticated && request.method !== "initialize")
          throw new RpcFault(-32001, "请先完成连接授权与版本协商。");
        if (peer.authenticated && !peer.attached)
          throw new RepaFault("closed", "该前端连接的使用已经结束。");
        if (!Object.hasOwn(methods, request.method))
          throw new RpcFault(-32601, "Method not found");
        const name = request.method as Method;
        const params = request.params ?? {};
        if (!Check(methods[name].params, params))
          throw new RpcFault(-32602, "Invalid params");
        const result = await dispatch(name, params);
        if (!Check(methods[name].result, result))
          throw new Error(`接口 ${name} 返回了无效数据。`);
        return { jsonrpc: "2.0", id, result };
      } catch (error) {
        if (notification) return undefined;
        const fault =
          error instanceof RpcFault
            ? error
            : error instanceof RepaFault
              ? new RpcFault(-32000, error.message, { code: error.code, ...(error.details === undefined ? {} : { details: error.details }) })
              : new RpcFault(
                  -32603,
                  error instanceof Error ? error.message : "Internal error",
                );
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: fault.code,
            message: fault.message,
            ...(fault.data === undefined ? {} : { data: fault.data }),
          },
        };
      }
    };
    socket.on("message", (data) => {
      void (async () => {
        let value: unknown;
        try {
          value = JSON.parse(data.toString());
        } catch {
          send({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          });
          return;
        }
        if (Array.isArray(value)) {
          if (!value.length) {
            send({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32600, message: "Invalid Request" },
            });
            return;
          }
          const replies = (await Promise.all(value.map(handle))).filter(
            (x) => x !== undefined,
          );
          if (replies.length) send(replies);
        } else {
          const reply = await handle(value);
          if (reply !== undefined) send(reply);
        }
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? 0, "127.0.0.1", () => {
      http.removeListener("error", reject);
      resolve();
    });
  });
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("后端未取得本地监听端口。");
  const closed = application.closed.finally(
    () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        for (const timer of detachTimers) clearTimeout(timer);
        for (const peer of websocket.clients)
          peer.close(1000, "server stopped");
        const terminate = setTimeout(() => {
          for (const peer of websocket.clients) peer.terminate();
        }, 1000);
        terminate.unref();
        websocket.close(() => clearTimeout(terminate));
        http.close(() => resolve());
      }),
  );
  return {
    connection: { url: `ws://127.0.0.1:${address.port}/rpc`, token },
    application,
    closed,
    async close(mode = "cancel") {
      application.shutdown(mode);
      await closed;
    },
  };
}
