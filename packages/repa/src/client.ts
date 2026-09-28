import { Check } from "typebox/value";
import {
  DeliverySchema,
  methods,
  PROTOCOL_VERSION,
  type Delivery,
  type Method,
  type Params,
  type Result,
  type Scope,
  type Snapshot,
  type ContentTarget,
  type ContentInfo,
  type ResourceRef,
  ResourcePreparationSchema,
  type ResourcePreparation,
} from "./protocol.js";
import { applyChange } from "./state.js";

export interface ClientConnection {
  url: string;
  token: string;
}
export interface ClientOptions {
  reconnectDelayMs?: number;
  requestTimeoutMs?: number;
  hostKey?: string;
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
  constructor(message = "连接中断，原操作的执行结果需要查询确认。") {
    super(message);
  }
}
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: Method;
  timer: ReturnType<typeof setTimeout>;
}
export interface Watch {
  readonly snapshot: Snapshot | undefined;
  readonly cursor: string | undefined;
  stop(): Promise<void>;
}
interface Subscription {
  id: string;
  scope: Scope;
  snapshot?: Snapshot;
  cursor?: string;
  update: (snapshot: Snapshot, delivery: Delivery) => void;
}

/** Browser-compatible client: owns connection recovery and state projections, with no UI or Pi dependency. */
export class RepaClient {
  readonly #connection: ClientConnection;
  readonly #options: ClientOptions;
  readonly #pending = new Map<string, Pending>();
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #connectionListeners = new Set<(connected: boolean) => void>();
  #socket: WebSocket | undefined;
  #ready = false;
  #closed = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #connecting: Promise<void> | undefined;
  #hostKey: string | undefined;

  private constructor(connection: ClientConnection, options: ClientOptions) {
    this.#connection = connection;
    this.#options = options;
    this.#hostKey = options.hostKey;
  }
  static async connect(
    connection: ClientConnection,
    options: ClientOptions = {},
  ): Promise<RepaClient> {
    const client = new RepaClient(connection, options);
    try {
      await client.#open();
      return client;
    } catch (error) {
      client.#closed = true;
      client.#socket?.close();
      clearTimeout(client.#reconnectTimer);
      throw error;
    }
  }
  get connected(): boolean {
    return this.#ready;
  }
  get closed(): boolean {
    return this.#closed;
  }
  /** 宿主恢复凭据由可信前端保存，不交给生成内容。 */
  get hostKey(): string | undefined { return this.#hostKey; }
  onConnectionChange(listener: (connected: boolean) => void): () => void {
    this.#connectionListeners.add(listener);
    return () => {
      this.#connectionListeners.delete(listener);
    };
  }
  #setReady(value: boolean): void {
    if (this.#ready === value) return;
    this.#ready = value;
    for (const listener of this.#connectionListeners) listener(value);
  }
  async #open(): Promise<void> {
    if (this.#closed) throw new ConnectionError("客户端已关闭。");
    if (this.#connecting) return this.#connecting;
    const promise = this.#openSocket();
    this.#connecting = promise;
    try {
      await promise;
    } catch (error) {
      this.#socket?.close();
      throw error;
    } finally {
      this.#connecting = undefined;
    }
  }
  async #openSocket(): Promise<void> {
    const socket = new WebSocket(this.#connection.url);
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      let data: unknown;
      try {
        data = JSON.parse(String(event.data));
      } catch {
        socket.close(1002, "invalid JSON");
        return;
      }
      for (const message of Array.isArray(data) ? data : [data])
        this.#receive(message);
    });
    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket) return;
      if (event.code === 1000) this.#closed = true;
      this.#setReady(false);
      for (const item of this.#pending.values()) {
        clearTimeout(item.timer);
        item.reject(new ConnectionError());
      }
      this.#pending.clear();
      this.#scheduleReconnect();
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new ConnectionError("连接后端超时。"));
      }, this.#options.requestTimeoutMs ?? 15000);
      const cleanup = () => clearTimeout(timer);
      socket.addEventListener(
        "open",
        () => {
          cleanup();
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          cleanup();
          reject(new ConnectionError("无法连接后端。"));
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        () => {
          cleanup();
          reject(new ConnectionError());
        },
        { once: true },
      );
    });
    const initialized = await this.#send("initialize", {
      versions: [PROTOCOL_VERSION],
      token: this.#connection.token,
      ...(this.#hostKey ? { hostKey: this.#hostKey } : {}),
    });
    this.#hostKey = initialized.hostKey;
    for (const watch of this.#subscriptions.values()) {
      await this.#send("subscription.start", {
        id: watch.id,
        scope: watch.scope,
        ...(watch.cursor ? { cursor: watch.cursor } : {}),
      });
    }
    if (this.#closed) throw new ConnectionError("客户端已关闭。");
    this.#setReady(true);
  }
  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnectTimer) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#open().catch((error) => {
        if (
          error instanceof RpcError &&
          (error.code === -32001 || error.code === -32002)
        ) {
          this.#closed = true;
          this.#socket?.close();
        } else this.#scheduleReconnect();
      });
    }, this.#options.reconnectDelayMs ?? 250);
  }
  #receive(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const message = raw as Record<string, any>;
    if (message.jsonrpc !== "2.0") return;
    if (message.method === "subscription.update") {
      const watch = this.#subscriptions.get(message.params?.id);
      const delivery: unknown = message.params?.delivery;
      if (!watch || !Check(DeliverySchema, delivery)) return;
      if (delivery.type === "snapshot") watch.snapshot = delivery.snapshot;
      else if (watch.snapshot)
        for (const change of delivery.changes)
          applyChange(watch.snapshot, change);
      watch.cursor = delivery.cursor;
      if (watch.snapshot) {
        watch.update(watch.snapshot, delivery);
        if (watch.snapshot.lifecycle === "stopped") {
          this.#closed = true;
          clearTimeout(this.#reconnectTimer);
        }
      }
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.id);
    if (message.error)
      pending.reject(
        new RpcError(
          message.error.code,
          message.error.message,
          message.error.data,
        ),
      );
    else if (Check(methods[pending.method].result, message.result))
      pending.resolve(message.result);
    else pending.reject(new RpcError(-32603, "后端返回的数据不符合协议。"));
  }
  #send<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new ConnectionError());
    if (!Check(methods[method].params, params))
      return Promise.reject(new RpcError(-32602, "Invalid params"));
    const id = globalThis.crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new ConnectionError("应答超时，原操作的结果需要查询确认。"));
      }, this.#options.requestTimeoutMs ?? 15000);
      this.#pending.set(id, {
        method,
        resolve: (value) => resolve(value as Result<M>),
        reject,
        timer,
      });
      try {
        this.#socket!.send(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        );
      } catch {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new ConnectionError());
      }
    });
  }
  call<
    M extends Exclude<
      Method,
      | "initialize"
      | "subscription.start"
      | "subscription.stop"
      | "client.detach"
    >,
  >(method: M, params: Params<M>): Promise<Result<M>> {
    if (!this.#ready || this.#closed)
      return Promise.reject(new ConnectionError());
    return this.#send(method, params);
  }
  async watch(
    scope: Scope,
    update: (snapshot: Snapshot, delivery: Delivery) => void,
  ): Promise<Watch> {
    if (!this.#ready || this.#closed) throw new ConnectionError();
    const watch: Subscription = {
      id: globalThis.crypto.randomUUID(),
      scope,
      update,
    };
    this.#subscriptions.set(watch.id, watch);
    try {
      await this.#send("subscription.start", { id: watch.id, scope });
    } catch (error) {
      this.#subscriptions.delete(watch.id);
      throw error;
    }
    return {
      get snapshot() {
        return watch.snapshot;
      },
      get cursor() {
        return watch.cursor;
      },
      stop: async () => {
        this.#subscriptions.delete(watch.id);
        if (this.#ready && !this.#closed)
          await this.#send("subscription.stop", { id: watch.id });
      },
    };
  }
  async resource(ref: ResourceRef, range?: string): Promise<Response> {
    const url = new URL(
      `/spaces/${encodeURIComponent(ref.spaceId)}/resources/${encodeURIComponent(ref.id)}`,
      this.#connection.url.replace(/^ws/, "http"),
    );
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.#connection.token}`, ...(range ? { Range: range } : {}) },
    });
    if (!response.ok) throw await this.#httpError(response, "无法读取资源。");
    return response;
  }
  /** 编辑器取得同一不可变修订的完整正文，避免把截断预览当作保存基准。 */
  async readText(target: ContentTarget): Promise<{ content: ContentInfo; text: string }> {
    const read = await this.call("content.read", { target });
    if (read.text !== undefined && !read.truncated) return { content: read.content, text: read.text };
    if (read.text === undefined && !read.truncated)
      throw new RpcError(-32000, "该内容需要相应的二进制处理器。", { code: "unsupported_format" });
    if (!read.resource) throw new RpcError(-32603, "缺少完整内容资源。");
    const bytes = await (await this.resource(read.resource)).arrayBuffer();
    return { content: read.content, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  }
  async uploadResource(spaceId: string, bytes: Uint8Array, mediaType: string): Promise<ResourcePreparation> {
    if (!this.#ready || !this.#hostKey || this.#closed) throw new ConnectionError();
    const url = new URL(`/spaces/${encodeURIComponent(spaceId)}/resources`, this.#connection.url.replace(/^ws/, "http"));
    const response = await fetch(url, {
      method: "POST", body: bytes as Uint8Array<ArrayBuffer>,
      headers: { Authorization: `Bearer ${this.#connection.token}`, "Content-Type": mediaType, "X-Repa-Host-Key": this.#hostKey },
    });
    if (!response.ok) throw await this.#httpError(response, "资源上传失败。");
    const value: unknown = await response.json();
    if (!Check(ResourcePreparationSchema, value)) throw new RpcError(-32603, "后端返回的资源准备结果不符合协议。");
    return value;
  }
  async #httpError(response: Response, fallback: string): Promise<RpcError> {
    let data: unknown;
    try { data = await response.json(); } catch { /* 无 JSON 的 HTTP 拒绝仍保留状态码。 */ }
    const message = data && typeof data === "object" && "message" in data && typeof data.message === "string" ? data.message : fallback;
    return new RpcError(response.status, message, data);
  }
  async reconnect(): Promise<void> {
    if (this.#closed) throw new ConnectionError("客户端已关闭。");
    if (this.#connecting) return this.#connecting;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    const old = this.#socket;
    this.#socket = undefined;
    this.#setReady(false);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ConnectionError());
    }
    this.#pending.clear();
    old?.close();
    await this.#open();
  }
  async close(): Promise<void> {
    if (this.#closed) {
      this.#socket?.close();
      return;
    }
    this.#closed = true;
    clearTimeout(this.#reconnectTimer);
    try {
      if (this.#ready) await this.#send("client.detach", {});
    } catch {
      /* The server also detaches lost connections after its reconnect grace period. */
    } finally {
      this.#socket?.close();
      this.#setReady(false);
      this.#subscriptions.clear();
    }
  }
}
