import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ModelRuntime, CredentialSynchronizationError } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Api, type AuthPrompt, type AuthType, type Model, type ProviderAuth } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { RepaFault } from "../errors.js";
import { IdSchema, RevisionSchema, object } from "../schema.js";
import { SerialQueue, writeJson } from "../storage/atomic.js";
import { assertCredentialEnvironment, credentialProvider } from "./credential-context.js";
import {
  ConnectionInputSchema, ModelBindingSchema, ModelFallbackSchema,
  type AuthQuery, type ModelConnection, type ConnectionInput, type ModelBinding,
  type ModelCatalog, type ModelSelection, type ModelFallback, type BoundModelFallback,
} from "./schema.js";

const StoredConnectionSchema = object({
  ...ConnectionInputSchema.properties,
  id: IdSchema,
  revision: RevisionSchema,
  authId: IdSchema,
  authIds: Type.Array(IdSchema),
});
const StoreSchema = object({ version: Type.Literal(1), connections: Type.Array(StoredConnectionSchema) });
type StoredConnection = Static<typeof StoredConnectionSchema>;
type Store = Static<typeof StoreSchema>;
export type ConnectionChange = { connectionId: string; kind: "created" | "updated" | "removed" | "authentication" };
type Login = {
  query: AuthQuery;
  controller: AbortController;
  done: Promise<void>;
  reply?: { id: string; resolve(value: string): void; reject(error: Error): void };
};

export class ModelConnections {
  readonly #directory: string;
  readonly #onChange?: (change: ConnectionChange) => void | Promise<void>;
  readonly #queue = new SerialQueue();
  readonly #authQueue = new SerialQueue();
  readonly #logins = new Map<string, Login>();

  constructor(options: { directory: string; onChange?: (change: ConnectionChange) => void | Promise<void> }) {
    this.#directory = options.directory;
    this.#onChange = options.onChange;
  }

  get active(): boolean {
    return [...this.#logins.values()].some((login) => login.query.status === "pending");
  }

  async settled(): Promise<void> {
    await this.#authQueue.settled();
    await Promise.all([...this.#logins.values()].map((login) => login.done));
    await this.#queue.settled();
  }

  async cancelAll(): Promise<void> {
    await this.#authQueue.settled();
    for (const login of this.#logins.values()) {
      if (login.query.status === "pending") login.controller.abort();
    }
    await this.settled();
  }

  async #read(): Promise<Store> {
    let bytes: string;
    try {
      bytes = await readFile(path.join(this.#directory, "connections.json"), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { version: 1, connections: [] };
      throw error;
    }
    const value: unknown = JSON.parse(bytes);
    if (!Check(StoreSchema, value)) throw new RepaFault("connection_storage", "模型连接文件格式无效。");
    return value;
  }

  async #mutate<T>(work: (store: Store) => Promise<T>): Promise<T> {
    return this.#queue.run(async () => {
      await mkdir(this.#directory, { recursive: true });
      const release = await lockfile.lock(this.#directory, { realpath: false, retries: { retries: 10, minTimeout: 10, maxTimeout: 100 } });
      try {
        return await work(await this.#read());
      } finally {
        await release();
      }
    });
  }

  async #save(store: Store): Promise<void> {
    await writeJson(path.join(this.#directory, "connections.json"), store);
  }

  #find(store: Store, id: string): StoredConnection {
    const connection = store.connections.find((item) => item.id === id);
    if (!connection) throw new RepaFault("connection_not_found", "模型连接不存在。", { connectionId: id });
    return connection;
  }

  #base(connection: StoredConnection, base: string): void {
    if (connection.revision !== base) throw new RepaFault("conflict", "模型连接已修改，请重新读取。", { revision: connection.revision });
  }

  #input(input: ConnectionInput): void {
    if (!Check(ConnectionInputSchema, input)) throw new RepaFault("connection_invalid", "模型连接定义无效。");
    if (input.models && new Set(input.models.map((model) => model.id)).size !== input.models.length)
      throw new RepaFault("connection_invalid", "模型 ID 不能重复。");
    if (input.baseUrl) {
      let url: URL;
      try { url = new URL(input.baseUrl); } catch { throw new RepaFault("connection_invalid", "模型 endpoint 必须是完整 HTTP URL。"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new RepaFault("connection_invalid", "模型 endpoint 不能包含凭据，且必须使用 HTTP 或 HTTPS。");
    }
  }

  async #runtime(connection: ConnectionInput, authId: string): Promise<ModelRuntime> {
    if (!Check(IdSchema, authId)) throw new RepaFault("connection_invalid", "认证槽位无效。");
    const runtime = await ModelRuntime.create({
      authPath: path.join(this.#directory, "auth", `${authId}.json`),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    // 未提供模型时保留 Pi 的内置目录，不能用空数组替换它。
    if (connection.baseUrl || connection.models) runtime.registerProvider(connection.provider, {
      ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
      ...(connection.models ? { models: structuredClone(connection.models) } : {}),
    });
    const provider = runtime.getProvider(connection.provider);
    if (!provider) throw new RepaFault("provider_not_found", "Pi 不支持该 provider；自定义 provider 需要声明模型。");
    const scoped = credentialProvider(provider);
    let auth: ProviderAuth;
    // 具名连接只使用本槽位的认证；本地无密钥模式也不访问环境凭据。
    if (connection.authMode === "none") {
      auth = {
        apiKey: {
          name: "无需凭据",
          check: async () => ({ type: "api_key" }),
          // 部分 HTTP SDK 要求非空 key；哨兵不是凭据，空 header 阻止发送认证。
          resolve: async () => ({ auth: {
            apiKey: "repa-keyless",
            headers: { authorization: null, "x-api-key": null },
          } }),
        },
      };
    } else {
      auth = scoped.auth;
    }
    runtime.registerNativeProvider({ ...scoped, auth });
    await runtime.refresh({ allowNetwork: false, providers: [connection.provider] });
    return runtime;
  }

  async #view(connection: StoredConnection, existingRuntime?: ModelRuntime): Promise<ModelConnection> {
    const { authIds: _authIds, ...definition } = connection;
    if (connection.authMode === "none") return { ...definition, authentication: { configured: true } };
    const runtime = existingRuntime ?? await this.#runtime(connection, connection.authId);
    const credential = (await runtime.listCredentials()).find((item) => item.providerId === connection.provider);
    return { ...definition, authentication: credential ? { configured: true, type: credential.type } : { configured: false } };
  }

  async list(): Promise<ModelConnection[]> {
    return Promise.all((await this.#read()).connections.map((connection) => this.#view(connection)));
  }

  async get(connectionId: string): Promise<ModelConnection> {
    return this.#view(this.#find(await this.#read(), connectionId));
  }

  async create(input: ConnectionInput): Promise<ModelConnection> {
    this.#input(input);
    const connection = await this.#mutate(async (store) => {
      const authId = randomUUID();
      const created = { ...structuredClone(input), id: randomUUID(), revision: randomUUID(), authId, authIds: [authId] };
      const runtime = await this.#runtime(created, authId);
      store.connections.push(created);
      await this.#save(store);
      return this.#view(created, runtime);
    });
    await this.#onChange?.({ connectionId: connection.id, kind: "created" });
    return connection;
  }

  async update(connectionId: string, base: string, input: ConnectionInput): Promise<ModelConnection> {
    this.#input(input);
    const connection = await this.#mutate(async (store) => {
      const previous = this.#find(store, connectionId);
      this.#base(previous, base);
      if (previous.provider !== input.provider || previous.authMode !== input.authMode)
        throw new RepaFault("connection_invalid", "provider 和认证模式不能变更，请创建新连接。");
      const updated = { ...structuredClone(input), id: previous.id, revision: randomUUID(), authId: previous.authId, authIds: previous.authIds };
      const runtime = await this.#runtime(updated, updated.authId);
      store.connections[store.connections.indexOf(previous)] = updated;
      await this.#save(store);
      return this.#view(updated, runtime);
    });
    await this.#onChange?.({ connectionId, kind: "updated" });
    return connection;
  }

  async models(connectionId: string): Promise<ModelCatalog> {
    const stored = this.#find(await this.#read(), connectionId);
    const runtime = await this.#runtime(stored, stored.authId);
    const connection = await this.#view(stored, runtime);
    return { connection, models: runtime.getModels(connection.provider).map((model) => ({
      id: model.id, name: model.name, api: model.api, reasoning: model.reasoning,
      input: [...model.input], thinkingLevels: getSupportedThinkingLevels(model), contextWindow: model.contextWindow, maxTokens: model.maxTokens, cost: { ...model.cost },
    })) };
  }

  async bind(selection: ModelSelection, fallback?: ModelFallback): Promise<{
    binding: ModelBinding; model: Model<Api>; fallback?: BoundModelFallback;
  }> {
    if (fallback && !Check(ModelFallbackSchema, fallback))
      throw new RepaFault("configuration", "模型回退策略无效。");
    const primarySelection = structuredClone(selection);
    const policy = fallback ? structuredClone(fallback) : undefined;
    const selections = [primarySelection, ...policy?.models ?? []];
    const keys = selections.map(value => `${value.connectionId}\0${value.id}`);
    if (new Set(keys).size !== keys.length)
      throw new RepaFault("configuration", "模型回退候选不能重复或包含主选择。");
    // 所有候选从同一次连接清单读取绑定；执行时不再用当前配置重解账号或端点。
    const store = await this.#read();
    const bind = async (chosen: ModelSelection) => {
      const stored = this.#find(store, chosen.connectionId);
      const runtime = await this.#runtime(stored, stored.authId);
      const model = runtime.getModel(stored.provider, chosen.id);
      if (!model) throw new RepaFault("model_not_found", "连接中不存在该模型。");
      return { binding: { connection: await this.#view(stored, runtime), modelId: model.id }, model };
    };
    const primary = await bind(primarySelection);
    const candidates = await Promise.all(selections.slice(1).map(bind));
    return { ...primary, ...(policy ? { fallback: {
      on: policy.on, models: candidates.map(candidate => candidate.binding),
    } } : {}) };
  }

  async assertBinding(binding: ModelBinding): Promise<void> {
    if (!Check(ModelBindingSchema, binding)) throw new RepaFault("connection_invalid", "模型绑定格式无效。");
    const current = this.#find(await this.#read(), binding.connection.id);
    if (current.provider !== binding.connection.provider || current.authMode !== binding.connection.authMode)
      throw new RepaFault("connection_invalid", "模型绑定与连接的固定身份不一致。");
    if (!current.authIds.includes(binding.connection.authId)) throw new RepaFault("auth_required", "该请求使用的认证身份已注销。", { connectionId: current.id });
  }

  async open(binding: ModelBinding): Promise<{ modelRuntime: ModelRuntime; model: Model<Api> }> {
    await this.assertBinding(binding);
    const modelRuntime = await this.#runtime(binding.connection, binding.connection.authId);
    if (binding.connection.authMode !== "none") {
      const credential = (await modelRuntime.listCredentials()).find((item) => item.providerId === binding.connection.provider);
      if (!credential) throw new RepaFault("auth_required", "模型连接尚未配置凭据。", { connectionId: binding.connection.id });
      if (credential.type === "oauth" && binding.connection.baseUrl)
        throw new RepaFault("oauth_endpoint_conflict", "OAuth 账户可能指定专属 endpoint，请使用未覆盖 endpoint 的连接。");
      const resolved = await modelRuntime.getAuth(binding.connection.provider);
      if (!resolved) throw new RepaFault("auth_required", "模型连接的显式凭据尚不可用。", { connectionId: binding.connection.id });
      assertCredentialEnvironment(binding.connection.provider, resolved);
    }
    const model = modelRuntime.getModel(binding.connection.provider, binding.modelId);
    if (!model) throw new RepaFault("model_not_found", "绑定的连接定义中不存在该模型。");
    return { modelRuntime, model };
  }

  #login(loginId: string): Login {
    const login = this.#logins.get(loginId);
    if (!login) throw new RepaFault("auth_not_found", "登录操作不存在。");
    return login;
  }

  async authGet(loginId: string): Promise<AuthQuery> {
    return structuredClone(this.#login(loginId).query);
  }

  #prompt(login: Login, prompt: AuthPrompt): Promise<string> {
    if (login.controller.signal.aborted || prompt.signal?.aborted) return Promise.reject(new Error("登录已取消"));
    const challengeId = randomUUID();
    const challenge = { id: challengeId, message: prompt.message };
    if (prompt.type === "select") {
      login.query.challenge = { ...challenge, type: "select", options: prompt.options.map((option) => ({ ...option })) };
    } else {
      login.query.challenge = { ...challenge, type: prompt.type, ...(prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}) };
    }
    return new Promise<string>((resolve, reject) => {
      const clear = () => {
        login.controller.signal.removeEventListener("abort", abort);
        prompt.signal?.removeEventListener("abort", abort);
        if (login.reply?.id === challengeId) {
          delete login.reply;
          delete login.query.challenge;
        }
      };
      const abort = () => { clear(); reject(new Error("登录已取消")); };
      login.reply = { id: challengeId, resolve: (value) => { clear(); resolve(value); }, reject: (error) => { clear(); reject(error); } };
      login.controller.signal.addEventListener("abort", abort, { once: true });
      prompt.signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async authStart(connectionId: string, type: AuthType): Promise<AuthQuery> {
    return this.#authQueue.run(() => this.#start(connectionId, type));
  }

  async #start(connectionId: string, type: AuthType): Promise<AuthQuery> {
    if (!["api_key", "oauth"].includes(type)) throw new RepaFault("auth_invalid", "认证类型无效。");
    // 同一连接只持有一个可交互的登录；取消完成后才开始新流程。
    for (const [id, login] of this.#logins) {
      if (login.query.connectionId === connectionId && login.query.status === "pending") await this.authCancel(id);
    }
    const { connection, authId, runtime } = await this.#mutate(async (store) => {
      const connection = this.#find(store, connectionId);
      if (connection.authMode === "none") throw new RepaFault("auth_not_supported", "无需凭据的连接不能登录。");
      if (type === "oauth" && connection.baseUrl)
        throw new RepaFault("oauth_endpoint_conflict", "OAuth 账户可能指定专属 endpoint，请使用未覆盖 endpoint 的连接。");
      const authId = randomUUID();
      const runtime = await this.#runtime(connection, authId);
      const auth = runtime.getProvider(connection.provider)?.auth;
      if (!(type === "oauth" ? auth?.oauth?.login : auth?.apiKey?.login))
        throw new RepaFault("auth_not_supported", "该 provider 不支持所选登录方式。");
      connection.authIds.push(authId);
      await this.#save(store);
      return { connection: structuredClone(connection), authId, runtime };
    });
    const loginId = randomUUID();
    const login: Login = { query: { loginId, connectionId, status: "pending", notifications: [] }, controller: new AbortController(), done: Promise.resolve() };
    this.#logins.set(loginId, login);
    login.done = this.#performLogin(login, connection, authId, runtime, type);
    return this.authGet(loginId);
  }

  async #performLogin(login: Login, connection: StoredConnection, authId: string, runtime: ModelRuntime, type: AuthType): Promise<void> {
    try {
      try {
        await runtime.login(connection.provider, type, {
          signal: login.controller.signal,
          prompt: (prompt) => this.#prompt(login, prompt),
          notify: (event) => {
            login.query.notifications.push(event.type === "info" ? { type: "info", message: event.message, ...(event.links ? { links: event.links.map((link) => ({ ...link })) } : {}) } : { ...event });
            if (login.query.notifications.length > 64) login.query.notifications.shift();
          },
        });
      } catch (error) {
        if (!(error instanceof CredentialSynchronizationError) || error.operation !== "login") throw error;
        // Pi 已写入凭据，不能把同步失败描述为未登录或暴露 error.credential。
        login.query.synchronizationRequired = true;
      }
      login.controller.signal.throwIfAborted();
      await this.#mutate(async (store) => {
        login.controller.signal.throwIfAborted();
        const current = this.#find(store, connection.id);
        if (!current.authIds.includes(authId)) throw new RepaFault("auth_required", "登录身份已注销。");
        current.authId = authId;
        current.revision = randomUUID();
        await this.#save(store);
      });
      login.query.status = "completed";
      try {
        await this.#onChange?.({ connectionId: connection.id, kind: "authentication" });
      } catch {
        login.query.synchronizationRequired = true;
      }
    } catch {
      login.query.status = "failed";
      if (login.controller.signal.aborted) {
        try {
          await runtime.logout(connection.provider);
          login.query.status = "cancelled";
        } catch (error) {
          if (error instanceof CredentialSynchronizationError && error.operation === "logout") {
            login.query.status = "cancelled";
            login.query.synchronizationRequired = true;
          } else {
            login.query.error = { code: "auth_cleanup_failed", message: "取消登录时未能清理认证，请注销该连接后再试。" };
          }
        }
      } else {
        login.query.error = { code: "auth_failed", message: "登录未完成，请检查认证方式与登录步骤。" };
      }
    } finally {
      login.reply?.reject(new Error("登录操作已结束"));
      delete login.query.challenge;
    }
  }

  async authReply(loginId: string, challengeId: string, value: string): Promise<AuthQuery> {
    const login = this.#login(loginId);
    if (login.query.status !== "pending" || login.reply?.id !== challengeId)
      throw new RepaFault("auth_challenge_expired", "登录步骤已结束或被替换。");
    if (login.query.challenge?.type === "select" && !login.query.challenge.options?.some((option) => option.id === value))
      throw new RepaFault("auth_invalid", "登录选择无效。");
    login.reply.resolve(value);
    return this.authGet(loginId);
  }

  async authCancel(loginId: string): Promise<AuthQuery> {
    const login = this.#login(loginId);
    if (login.query.status === "pending") {
      login.controller.abort();
      await login.done;
    }
    return this.authGet(loginId);
  }

  async authLogout(connectionId: string): Promise<ModelConnection> {
    return this.#authQueue.run(() => this.#logout(connectionId));
  }

  async #logout(connectionId: string): Promise<ModelConnection> {
    for (const [id, login] of this.#logins) {
      if (login.query.connectionId === connectionId && login.query.status === "pending") await this.authCancel(id);
    }
    const connection = await this.#mutate(async (store) => {
      const current = this.#find(store, connectionId);
      for (const authId of current.authIds) {
        const runtime = await this.#runtime(current, authId);
        try { await runtime.logout(current.provider); } catch (error) {
          if (!(error instanceof CredentialSynchronizationError) || error.operation !== "logout") throw error;
        }
      }
      current.authId = randomUUID();
      current.authIds = [current.authId];
      current.revision = randomUUID();
      await this.#save(store);
      return this.#view(current);
    });
    await this.#onChange?.({ connectionId, kind: "authentication" });
    return connection;
  }

  async remove(connectionId: string, base: string): Promise<{ removed: boolean }> {
    return this.#authQueue.run(() => this.#remove(connectionId, base));
  }

  async #remove(connectionId: string, base: string): Promise<{ removed: boolean }> {
    this.#base(this.#find(await this.#read(), connectionId), base);
    for (const [id, login] of this.#logins) {
      if (login.query.connectionId === connectionId && login.query.status === "pending") await this.authCancel(id);
    }
    await this.#mutate(async (store) => {
      const current = this.#find(store, connectionId);
      this.#base(current, base);
      for (const authId of current.authIds) {
        const runtime = await this.#runtime(current, authId);
        try { await runtime.logout(current.provider); } catch (error) {
          if (!(error instanceof CredentialSynchronizationError) || error.operation !== "logout") throw error;
        }
      }
      store.connections = store.connections.filter((item) => item.id !== connectionId);
      await this.#save(store);
    });
    await this.#onChange?.({ connectionId, kind: "removed" });
    return { removed: true };
  }
}
