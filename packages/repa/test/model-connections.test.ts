import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createAssistantMessageEventStream, fauxAssistantMessage, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { credentialProvider } from "../src/models/credential-context.js";
import { RepaFault } from "../src/errors.js";
import { ModelConnections } from "../src/models/service.js";
import type { AuthQuery, ConnectionInput, ModelBinding } from "../src/models/schema.js";

const model = {
  id: "local-model", name: "本地测试模型", api: "openai-completions", reasoning: false,
  input: ["text" as const], contextWindow: 4096, maxTokens: 256,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-model-connections-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests: { url: string; authorization: string | undefined }[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* 读完请求后再返回本地流。 */ }
    requests.push({ url: request.url ?? "", authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, delta: { role: "assistant", content: "本地回复" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("本地 provider 未监听");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const service = new ModelConnections({ directory });
  const input = (name: string, route: string, authMode: ConnectionInput["authMode"] = "credentials"): ConnectionInput => ({
    name, provider: "openai", baseUrl: `${endpoint}/${route}/v1`, authMode, models: [model],
  });
  return { directory, service, requests, input };
}

async function until(service: ModelConnections, loginId: string, predicate: (query: AuthQuery) => boolean): Promise<AuthQuery> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const query = await service.authGet(loginId);
    if (predicate(query)) return query;
    await delay(10);
  }
  assert.fail(`登录状态未到达预期：${JSON.stringify(await service.authGet(loginId))}`);
}

async function login(service: ModelConnections, connectionId: string, key: string) {
  const start = await service.authStart(connectionId, "api_key");
  const pending = await until(service, start.loginId, (query) => query.challenge !== undefined || query.status !== "pending");
  assert.equal(pending.status, "pending");
  assert.equal(pending.challenge?.type, "secret");
  if (!pending.challenge) throw new Error("缺少 API key 登录步骤");
  await service.authReply(start.loginId, pending.challenge.id, key);
  const completed = await until(service, start.loginId, (query) => query.status !== "pending");
  assert.equal(completed.status, "completed");
  return service.get(connectionId);
}

async function complete(service: ModelConnections, binding: ModelBinding) {
  const { modelRuntime, model } = await service.open(binding);
  const message = await modelRuntime.completeSimple(model, { messages: [{ role: "user", content: "你好", timestamp: Date.now() }] });
  assert.equal(message.stopReason, "stop", message.errorMessage);
}

test("同 provider 的具名连接独立保存凭据，改名和 endpoint 更新不改变已绑定请求", async (t) => {
  const { service, input, requests, directory } = await fixture(t);
  const first = await service.create(input("甲连接", "one"));
  const second = await service.create(input("乙连接", "two"));
  assert.notEqual(first.id, second.id);
  const catalog = await service.models(first.id);
  assert.equal(catalog.connection.authentication.configured, false);
  assert.deepEqual(catalog.models[0]?.thinkingLevels, ["off"]);
  const { binding: unauthenticated } = await service.bind({ connectionId: first.id, id: model.id });
  await assert.rejects(service.open(unauthenticated), (error) => error instanceof RepaFault && error.code === "auth_required");
  const authenticatedFirst = await login(service, first.id, "first-secret");
  await login(service, second.id, "second-secret");
  const { binding: firstBinding } = await service.bind({ connectionId: first.id, id: model.id });
  const { binding: secondBinding } = await service.bind({ connectionId: second.id, id: model.id });
  const updated = await service.update(first.id, authenticatedFirst.revision, input("甲连接改名", "changed"));
  assert.equal(updated.id, first.id);
  await assert.rejects(service.update(first.id, updated.revision, { ...input("改变身份", "one"), provider: "anthropic" }), (error) => error instanceof RepaFault && error.code === "connection_invalid");
  assert.equal(firstBinding.connection.name, "甲连接");
  await assert.rejects(service.update(first.id, authenticatedFirst.revision, input("过期修改", "bad")), (error) => error instanceof RepaFault && error.code === "conflict");
  await complete(service, firstBinding);
  await complete(service, secondBinding);
  await complete(service, (await service.bind({ connectionId: first.id, id: model.id })).binding);
  assert.deepEqual(requests, [
    { url: "/one/v1/chat/completions", authorization: "Bearer first-secret" },
    { url: "/two/v1/chat/completions", authorization: "Bearer second-secret" },
    { url: "/changed/v1/chat/completions", authorization: "Bearer first-secret" },
  ]);
  const metadata = await readFile(path.join(directory, "connections.json"), "utf8");
  assert.equal(metadata.includes("first-secret"), false);
  assert.equal(metadata.includes("second-secret"), false);
  const auth: unknown = JSON.parse(await readFile(path.join(directory, "auth", `${firstBinding.connection.authId}.json`), "utf8"));
  assert.deepEqual(auth, { openai: { type: "api_key", key: "first-secret" } });
  const restored = new ModelConnections({ directory });
  assert.equal((await restored.get(first.id)).authentication.configured, true);
  await complete(restored, firstBinding);
});

test("重新登录建立新认证身份，旧绑定保留旧凭据，注销清理全部身份并等待登录取消", async (t) => {
  const { service, input, requests, directory } = await fixture(t);
  const created = await service.create(input("连接", "one"));
  await login(service, created.id, "old-secret");
  const { binding: oldBinding } = await service.bind({ connectionId: created.id, id: model.id });
  await login(service, created.id, "new-secret");
  const { binding: newBinding } = await service.bind({ connectionId: created.id, id: model.id });
  assert.notEqual(oldBinding.connection.authId, newBinding.connection.authId);
  await complete(service, oldBinding);
  await complete(service, newBinding);
  assert.deepEqual(requests.map((request) => request.authorization), ["Bearer old-secret", "Bearer new-secret"]);
  const pending = await service.authStart(created.id, "api_key");
  await until(service, pending.loginId, (query) => query.challenge !== undefined);
  const loggedOut = await service.authLogout(created.id);
  assert.equal((await service.authGet(pending.loginId)).status, "cancelled");
  assert.equal(loggedOut.authentication.configured, false);
  for (const binding of [oldBinding, newBinding]) {
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "auth", `${binding.connection.authId}.json`), "utf8")), {});
  }
  assert.equal(service.active, false);
  await service.settled();
  await assert.rejects(service.open(oldBinding), (error) => error instanceof RepaFault && error.code === "auth_required");
  await assert.rejects(service.open(newBinding), (error) => error instanceof RepaFault && error.code === "auth_required");
  const cancellable = await service.authStart(created.id, "api_key");
  const challenge = await until(service, cancellable.loginId, (query) => query.challenge !== undefined);
  assert.equal(service.active, true);
  await service.cancelAll();
  assert.equal((await service.authGet(cancellable.loginId)).status, "cancelled");
  assert.equal(service.active, false);
  if (!challenge.challenge) throw new Error("缺少取消前登录步骤");
  await assert.rejects(service.authReply(cancellable.loginId, challenge.challenge.id, "late-secret"), (error) => error instanceof RepaFault && error.code === "auth_challenge_expired");
});

test("显式无凭据连接可调用本地 provider，内置模型只覆盖 endpoint 时仍保留目录", async (t) => {
  const { service, input, requests } = await fixture(t);
  const local = await service.create(input("无密钥", "local", "none"));
  await complete(service, (await service.bind({ connectionId: local.id, id: model.id })).binding);
  assert.deepEqual(requests, [{ url: "/local/v1/chat/completions", authorization: undefined }]);
  const builtin = await service.create({ name: "内置目录", provider: "openai", baseUrl: input("", "builtin").baseUrl, authMode: "credentials" });
  assert.ok((await service.models(builtin.id)).models.length > 0);
  await assert.rejects(service.authStart(local.id, "api_key"), (error) => error instanceof RepaFault && error.code === "auth_not_supported");
  await service.remove(local.id, local.revision);
  await assert.rejects(service.get(local.id), (error) => error instanceof RepaFault && error.code === "connection_not_found");
});


async function loginSteps(service: ModelConnections, connectionId: string, steps: { type: string; answer: string; excluded?: string }[]) {
  const start = await service.authStart(connectionId, "api_key");
  for (const step of steps) {
    const pending = await until(service, start.loginId, (query) => query.challenge !== undefined || query.status !== "pending");
    assert.equal(pending.status, "pending");
    const challenge = pending.challenge;
    assert(challenge);
    assert.equal(challenge.type, step.type);
    if (step.excluded) {
      assert.equal(challenge.type, "select");
      if (challenge.type === "select") assert(!challenge.options.some((option) => option.id === step.excluded));
    }
    await service.authReply(start.loginId, challenge.id, step.answer);
  }
  const completed = await until(service, start.loginId, (query) => query.status !== "pending");
  assert.equal(completed.status, "completed", JSON.stringify(completed));
  return service.get(connectionId);
}

function environment(t: TestContext, values: Record<string, string | undefined>) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  const apply = (env: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  apply(values);
  t.after(() => apply(previous));
}

test("Vertex 的真实 service-account 登录读取显式凭据文件，未登录槽位不借用 ambient 身份", async (t) => {
  const f = await fixture(t);
  const credentialsPath = path.join(f.directory, "service-account.json");
  await writeFile(credentialsPath, JSON.stringify({ type: "service_account", project_id: "stored-project", client_email: "test@example.invalid" }));
  environment(t, {
    GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
    GOOGLE_CLOUD_PROJECT: "ambient-project",
    GOOGLE_CLOUD_LOCATION: "ambient-location",
    GOOGLE_CLOUD_API_KEY: "ambient-google-key",
  });
  const connection = await f.service.create({ name: "显式 Vertex", provider: "google-vertex", authMode: "credentials" });
  const catalog = await f.service.models(connection.id);
  const firstModel = catalog.models[0];
  assert(firstModel);
  const { binding: beforeLogin } = await f.service.bind({ connectionId: connection.id, id: firstModel.id });
  await assert.rejects(f.service.open(beforeLogin), (error) => error instanceof RepaFault && error.code === "auth_required");
  await loginSteps(f.service, connection.id, [
    { type: "select", answer: "service-account", excluded: "adc" },
    { type: "text", answer: "stored-project" },
    { type: "text", answer: "us-central1" },
    { type: "text", answer: credentialsPath },
  ]);
  const { binding } = await f.service.bind({ connectionId: connection.id, id: firstModel.id });
  const { modelRuntime } = await f.service.open(binding);
  assert.deepEqual(await modelRuntime.getAuth("google-vertex"), {
    auth: {}, source: "stored credential",
    env: { GOOGLE_CLOUD_PROJECT: "stored-project", GOOGLE_CLOUD_LOCATION: "us-central1", GOOGLE_APPLICATION_CREDENTIALS: credentialsPath },
  });
  assert.equal((await modelRuntime.checkAuth("google-vertex"))?.type, "api_key");
  await rm(credentialsPath);
  assert.equal(await modelRuntime.getAuth("google-vertex"), undefined);
  await assert.rejects(f.service.open(binding), (error) => error instanceof RepaFault && error.code === "auth_required");
});

test("Bedrock 的真实 profile 登录保留明确身份，scoped 环境关闭 skipAuth 并拒绝 ambient bearer 冲突", async (t) => {
  const f = await fixture(t);
  const credentialsPath = path.join(f.directory, "aws-credentials");
  await writeFile(credentialsPath, "[selected-profile]\naws_access_key_id = selected-key\naws_secret_access_key = selected-secret\n");
  environment(t, {
    AWS_SHARED_CREDENTIALS_FILE: credentialsPath,
    AWS_PROFILE: "ambient-profile",
    AWS_ACCESS_KEY_ID: "ambient-key",
    AWS_SECRET_ACCESS_KEY: "ambient-secret",
    AWS_BEARER_TOKEN_BEDROCK: undefined,
    AWS_BEDROCK_SKIP_AUTH: "1",
  });
  const connection = await f.service.create({ name: "显式 Bedrock", provider: "amazon-bedrock", authMode: "credentials" });
  await loginSteps(f.service, connection.id, [
    { type: "select", answer: "aws-profile", excluded: "credential-chain" },
    { type: "text", answer: "selected-profile" },
  ]);
  const firstModel = (await f.service.models(connection.id)).models[0];
  assert(firstModel);
  const { binding } = await f.service.bind({ connectionId: connection.id, id: firstModel.id });
  const { modelRuntime, model: selectedModel } = await f.service.open(binding);
  assert.deepEqual(await modelRuntime.getAuth("amazon-bedrock"), {
    auth: {}, source: "stored credential", env: { AWS_PROFILE: "selected-profile", AWS_BEDROCK_SKIP_AUTH: "0" },
  });
  const provider = modelRuntime.getProvider("amazon-bedrock");
  assert(provider);
  const dispatched: (SimpleStreamOptions | undefined)[] = [];
  modelRuntime.registerNativeProvider(credentialProvider({
    ...provider,
    streamSimple: (_model, _context, options) => {
      dispatched.push(options);
      const stream = createAssistantMessageEventStream();
      const message = fauxAssistantMessage("拦截的 SDK adapter 请求");
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    },
  }));
  const reply = await modelRuntime.completeSimple(selectedModel, {
    messages: [{ role: "user", content: "只观察 adapter options", timestamp: 1 }],
  }, { env: { AWS_BEDROCK_SKIP_AUTH: "1" } });
  assert.equal(reply.stopReason, "stop");
  assert.equal(dispatched[0]?.env?.AWS_PROFILE, "selected-profile");
  assert.equal(dispatched[0]?.env?.AWS_BEDROCK_SKIP_AUTH, "0");
  assert.equal(dispatched[0]?.apiKey, undefined);
  process.env.AWS_BEARER_TOKEN_BEDROCK = "ambient-bearer";
  await assert.rejects(f.service.open(binding), (error) => error instanceof RepaFault && error.code === "auth_environment_conflict");
  const failed = await modelRuntime.completeSimple(selectedModel, { messages: [{ role: "user", content: "不得借用 bearer", timestamp: 2 }] });
  assert.equal(failed.stopReason, "error");
  assert.match(failed.errorMessage ?? "", /AWS_BEARER_TOKEN_BEDROCK/u);
  assert.equal(dispatched.length, 1);
  await loginSteps(f.service, connection.id, [
    { type: "select", answer: "bearer-token", excluded: "credential-chain" },
    { type: "secret", answer: "stored-bearer" },
  ]);
  const { binding: bearerBinding } = await f.service.bind({ connectionId: connection.id, id: firstModel.id });
  const bearer = await f.service.open(bearerBinding);
  assert.equal((await bearer.modelRuntime.getAuth("amazon-bedrock"))?.auth.apiKey, "stored-bearer");
});

test("具名连接的 OAuth 仍由真实 SDK 解析已保存凭据，不读取 ambient API key", async (t) => {
  const f = await fixture(t);
  environment(t, { ANTHROPIC_API_KEY: "ambient-anthropic" });
  const connection = await f.service.create({ name: "OAuth", provider: "anthropic", authMode: "credentials" });
  const credential = { type: "oauth", access: "stored-access", refresh: "stored-refresh", expires: Date.now() + 60 * 60 * 1000 };
  await writeFile(path.join(f.directory, "auth", `${connection.authId}.json`), JSON.stringify({ anthropic: credential }));
  const firstModel = (await f.service.models(connection.id)).models[0];
  assert(firstModel);
  const { binding } = await f.service.bind({ connectionId: connection.id, id: firstModel.id });
  assert.deepEqual(binding.connection.authentication, { configured: true, type: "oauth" });
  const { modelRuntime } = await f.service.open(binding);
  assert.equal((await modelRuntime.getAuth("anthropic"))?.auth.apiKey, "stored-access");
  assert.deepEqual(JSON.parse(await readFile(path.join(f.directory, "auth", `${connection.authId}.json`), "utf8")), { anthropic: credential });
});

test("create、update、models 与 bind 在各自操作内只建立一次 runtime，不跨操作缓存", async (t) => {
  const f = await fixture(t);
  const create = ModelRuntime.create;
  let creations = 0;
  t.mock.method(ModelRuntime, "create", async (options: Parameters<typeof create>[0]) => {
    creations += 1;
    return create(options);
  });
  const connection = await f.service.create(f.input("连接", "one"));
  assert.equal(creations, 1);
  await f.service.models(connection.id);
  assert.equal(creations, 2);
  await f.service.bind({ connectionId: connection.id, id: model.id });
  assert.equal(creations, 3);
  await f.service.update(connection.id, connection.revision, f.input("改名", "two"));
  assert.equal(creations, 4);
  await f.service.models(connection.id);
  assert.equal(creations, 5);
});
