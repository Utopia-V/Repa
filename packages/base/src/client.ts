import { Check } from "typebox/value";
import {
  methods,
  notifications,
  PROTOCOL_VERSION,
  type Method,
  type Notification,
  type NotificationParams,
  type Params,
  type Result,
} from "./protocol.js";
import { record } from "./protocol/json-rpc.js";

export interface ClientConnection {
  url: string;
  token: string;
}

export interface ClientOptions {
  requestTimeoutMs?: number;
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

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
        this.#socket.close(1002, "invalid JSON");
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
      await client.#send("initialize", { token: connection.token, version: PROTOCOL_VERSION });
      client.#setReady(true);
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
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
      if (!Check(notifications[method], message.params)) return this.#invalidResponse();
      for (const listener of this.#listeners.get(method) ?? []) {
        listener(message.params);
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
    } else if (!Object.hasOwn(message, "error") && Check(methods[pending.method].result, message.result)) {
      pending.resolve(message.result);
    } else {
      pending.reject(new ConnectionError("后端返回了无效响应。"));
      this.#invalidResponse();
    }
  }

  #invalidResponse(): void {
    this.#fail(new ConnectionError("后端返回了无效协议数据。"));
    this.#socket.close(1002, "invalid response");
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
