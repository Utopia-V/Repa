import { Check, Clean } from "typebox/value";
import {
  lenientNotifications,
  lenientResults,
  methods,
  notifications,
  PROTOCOL_VERSION,
  type ClientCapabilities,
  type Method,
  type Notification,
  type NotificationParams,
  type Params,
  type ReadResult,
  type Result,
} from "./protocol.js";
import { record } from "./protocol/json-rpc.js";

/** 连接本机后端所需的 WebSocket 地址和私密令牌，由启动入口交给客户端。 */
export interface ClientConnection {
  url: string;
  token: string;
}

/** 客户端的请求等待与能力声明选项，连接初始化时使用。 */
export interface ClientOptions {
  requestTimeoutMs?: number;
  /**
   * 在 initialize 里声明的能力：能显示的作答位、内容块和特性，以及能提供的服务。
   * 不声明时后端不向这个连接发询问和服务请求。
   */
  capabilities?: ClientCapabilities;
}

/** 后端返回的 JSON-RPC 错误，调用方用 code 和 data 判断失败原因。 */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** 连接中断导致结果未知的错误；调用方应重新读取状态确认操作结果。 */
export class ConnectionError extends Error {
  readonly outcome = "unknown";
  constructor(message = "连接中断，请重新读取会话历史确认原操作的执行结果。") {
    super(message);
  }
}

interface Pending {
  method: Method;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

type Listener = (params: unknown) => void;

// 后端发来无效数据时主动断开。浏览器的 WebSocket 只允许客户端用 1000 或 3000–4999 关闭，
// 用 1002 会抛 InvalidAccessError，连接反而留着；所以用应用自定的 4002，与服务端的 4001 相邻。
const INVALID_DATA = 4002;

// 带 Item 或内容块的消息原样交给协议登记的读取函数，由它去掉信封里的未知字段，Item 和内容块按词汇的规则读取。
// 不先整体清理：Clean 遇到联合会换一个能通过校验的分支，删掉类型不对的已知字段，词汇本该拒绝的数据就混了过去。
// 其余消息在副本上去掉未知字段，再校验已声明字段。
function readNotification(method: Notification, params: unknown): ReadResult<unknown> {
  const read = lenientNotifications[method];
  if (read !== undefined) return read(params);
  const cleaned = Clean(notifications[method], structuredClone(params));
  return Check(notifications[method], cleaned) ? { ok: true, value: cleaned } : { ok: false, path: "" };
}

function readResult(method: Method, result: unknown): ReadResult<unknown> {
  const read = lenientResults[method];
  if (read !== undefined) return read(result);
  const cleaned = Clean(methods[method].result, structuredClone(result));
  return Check(methods[method].result, cleaned) ? { ok: true, value: cleaned } : { ok: false, path: "" };
}

/** 浏览器可用的 Repa 协议客户端，负责认证、请求与结果校验、通知订阅和连接状态报告。 */
export class RepaClient {
  readonly #pending = new Map<string, Pending>();
  readonly #listeners = new Map<Notification, Set<Listener>>();
  readonly #connectionListeners = new Set<(connected: boolean) => void>();
  readonly #socket: WebSocket;
  readonly #timeoutMs: number | undefined;
  #nextId = 0;
  #ready = false;
  #closed = false;
  #closing: Promise<void> | undefined;
  // connect 是唯一的创建入口，返回实例前已经填好。
  #handshake!: Result<"initialize">;

  private constructor(connection: ClientConnection, options: ClientOptions) {
    this.#timeoutMs = options.requestTimeoutMs;
    if (this.#timeoutMs !== undefined && (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0)) {
      throw new RangeError("requestTimeoutMs 必须是正数");
    }
    this.#socket = new WebSocket(connection.url);
    this.#socket.addEventListener("message", (event) => {
      let value: unknown;
      try {
        value = JSON.parse(String(event.data));
      } catch {
        this.#fail(new ConnectionError("后端返回了无效 JSON。"));
        this.#socket.close(INVALID_DATA, "invalid JSON");
        return;
      }
      for (const item of Array.isArray(value) ? value : [value]) {
        this.#receive(item);
      }
    });
    this.#socket.addEventListener("close", () => {
      this.#closed = true;
      this.#setReady(false);
      this.#fail(new ConnectionError());
    });
    this.#socket.addEventListener("error", () => {
      this.#setReady(false);
      this.#fail(new ConnectionError("无法连接后端。"));
    });
  }

  static async connect(connection: ClientConnection, options: ClientOptions = {}): Promise<RepaClient> {
    const client = new RepaClient(connection, options);
    try {
      await client.#open();
      client.#handshake = await client.#send("initialize", {
        token: connection.token,
        version: PROTOCOL_VERSION,
        ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
      });
      client.#setReady(true);
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  /** 连接时 initialize 的结果，其中的基线是开始接收通知那一刻的状态，之后的变化由通知送达。 */
  get handshake(): Result<"initialize"> {
    return this.#handshake;
  }

  get connected(): boolean {
    return this.#ready && !this.#closed;
  }

  onConnectionChange(listener: (connected: boolean) => void): () => void {
    this.#connectionListeners.add(listener);
    return () => this.#connectionListeners.delete(listener);
  }

  on<N extends Notification>(method: N, listener: (params: NotificationParams<N>) => void): () => void {
    const adapted: Listener = (params) => listener(params as NotificationParams<N>);
    let listeners = this.#listeners.get(method);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(method, listeners);
    }
    listeners.add(adapted);
    return () => listeners.delete(adapted);
  }

  async call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    if (!this.connected) throw new ConnectionError("客户端尚未连接或已经关闭。");
    return this.#send(method, params);
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#setReady(false);
    this.#fail(new ConnectionError("客户端已关闭。"));
    this.#listeners.clear();
    this.#connectionListeners.clear();
    if (this.#socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    this.#closing = new Promise<void>((resolve) => {
      this.#socket.addEventListener("close", () => resolve(), { once: true });
      this.#socket.close(1000, "client stopped");
    });
    return this.#closing;
  }

  async #open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new ConnectionError("连接后端超时。")), this.#timeoutMs ?? 15000);
      const opened = () => finish();
      const failed = () => finish(new ConnectionError("无法连接后端。"));
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.#socket.removeEventListener("open", opened);
        this.#socket.removeEventListener("error", failed);
        this.#socket.removeEventListener("close", failed);
        if (error) reject(error);
        else resolve();
      };
      this.#socket.addEventListener("open", opened);
      this.#socket.addEventListener("error", failed);
      this.#socket.addEventListener("close", failed);
    });
  }

  #send<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    if (!Check(methods[method].params, params)) {
      return Promise.reject(new RpcError(-32602, "Invalid params"));
    }
    if (this.#socket.readyState !== WebSocket.OPEN) return Promise.reject(new ConnectionError());
    const id = String(++this.#nextId);
    return new Promise<unknown>((resolve, reject) => {
      const timeout = this.#timeoutMs ?? (method === "initialize" ? 15000 : undefined);
      const timer = timeout === undefined ? undefined : setTimeout(() => {
        this.#pending.delete(id);
        reject(new ConnectionError("请求超时，操作可能仍在执行，请读取当前状态确认。"));
      }, timeout);
      this.#pending.set(id, { method, resolve, reject, timer });
      try {
        this.#socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new ConnectionError());
      }
    }) as Promise<Result<M>>;
  }

  #receive(value: unknown): void {
    const message = record(value);
    if (!message || message.jsonrpc !== "2.0") return this.#invalidResponse();
    if (typeof message.method === "string" && !Object.hasOwn(message, "id")) {
      if (!Object.hasOwn(notifications, message.method)) return;
      const method = message.method as Notification;
      const read = readNotification(method, message.params);
      if (!read.ok) return this.#invalidResponse();
      for (const listener of this.#listeners.get(method) ?? []) {
        listener(read.value);
      }
      return;
    }
    if (typeof message.id !== "string") return this.#invalidResponse();
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    const error = record(message.error);
    if (error && typeof error.code === "number" && typeof error.message === "string" && !Object.hasOwn(message, "result")) {
      pending.reject(new RpcError(error.code, error.message, error.data));
      return;
    }
    const read = Object.hasOwn(message, "error") ? undefined : readResult(pending.method, message.result);
    if (read?.ok === true) {
      pending.resolve(read.value);
      return;
    }
    pending.reject(new ConnectionError("后端返回了无效响应。"));
    this.#invalidResponse();
  }

  #invalidResponse(): void {
    this.#fail(new ConnectionError("后端返回了无效协议数据。"));
    this.#socket.close(INVALID_DATA, "invalid response");
  }

  #fail(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #setReady(ready: boolean): void {
    if (this.#ready === ready) return;
    this.#ready = ready;
    for (const listener of this.#connectionListeners) listener(ready);
  }
}
