import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { fauxProvider, type CredentialStore, type OAuthCredential } from "@earendil-works/pi-ai";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function fixture(t: TestContext, pauseAt: "provider" | "persistence") {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-real-model-oauth-"));
  const authPath = path.join(root, "auth.json");
  const providerId = `repa-oauth-${randomUUID()}`;
  const before: OAuthCredential = { type: "oauth", access: "local-access-before", refresh: "local-refresh-before", expires: Date.now() - 1000 };
  const after: OAuthCredential = { type: "oauth", access: "local-access-after", refresh: "local-refresh-after", expires: Date.now() + 3_600_000 };
  const started = deferred();
  const release = deferred();
  let refreshSignal: AbortSignal | undefined;
  let refreshCalls = 0;
  let writes = 0;
  let pending: Promise<unknown> = Promise.resolve();
  t.after(async () => {
    release.resolve();
    await pending.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(authPath, JSON.stringify({ [providerId]: before }), { mode: 0o600 });

  async function read() {
    const data: unknown = JSON.parse(await readFile(authPath, "utf8"));
    assert(data !== null && typeof data === "object" && providerId in data);
    const credential: unknown = Object.entries(data).find(([id]) => id === providerId)?.[1];
    assert(credential !== null && typeof credential === "object");
    assert("type" in credential && credential.type === "oauth");
    assert("access" in credential && typeof credential.access === "string");
    assert("refresh" in credential && typeof credential.refresh === "string");
    assert("expires" in credential && typeof credential.expires === "number");
    return { type: "oauth", access: credential.access, refresh: credential.refresh, expires: credential.expires } satisfies OAuthCredential;
  }

  // 替身只承担本地凭据存储边界，保留串行修改和落盘前取消检查。
  // Pi 必须传入与 caller 取消脱钩的 signal，才能通过第二个屏障后的保存。
  const credentials: CredentialStore = {
    async read(id, options) {
      options?.signal?.throwIfAborted();
      return id === providerId ? read() : undefined;
    },
    async list() {
      return [{ providerId, type: "oauth" }];
    },
    modify(id, change, options) {
      const previous = pending;
      const operation = (async () => {
        await previous.catch(() => undefined);
        options?.signal?.throwIfAborted();
        assert.equal(id, providerId);
        const next = await change(await read());
        if (pauseAt === "persistence" && next !== undefined) {
          started.resolve();
          await release.promise;
        }
        options?.signal?.throwIfAborted();
        if (next !== undefined) {
          await writeFile(authPath, JSON.stringify({ [providerId]: next }), { mode: 0o600 });
          writes++;
        }
        return read();
      })();
      pending = operation;
      return operation;
    },
    async delete() {
      throw new Error("本地刷新夹具不执行注销");
    },
  };
  const faux = fauxProvider({ api: `repa-oauth-api-${randomUUID()}`, provider: providerId, models: [{ id: "test" }], tokensPerSecond: 0 });
  const models = await ModelRuntime.create({ credentials, authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  models.registerNativeProvider({
    ...faux.provider,
    auth: {
      oauth: {
        name: "本地 OAuth 刷新夹具",
        async login() {
          throw new Error("本地刷新夹具不执行登录");
        },
        async refresh(current, signal) {
          assert.deepEqual(current, before);
          refreshCalls++;
          refreshSignal = signal;
          if (pauseAt === "provider") {
            started.resolve();
            await release.promise;
          }
          signal.throwIfAborted();
          return after;
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
  });
  return { authPath, providerId, before, after, models, started, release, settled: () => pending, state: () => ({ refreshSignal, refreshCalls, writes }) };
}

for (const pauseAt of ["provider", "persistence"] as const) {
  const stage = pauseAt === "provider" ? "刷新已开始、服务返回前" : "刷新已返回、凭据落盘前";
  test(`${stage}取消 caller，Pi 仍保存旋转后的凭据供下一次认证使用`, { timeout: 5000 }, async t => {
    const f = await fixture(t, pauseAt);
    const controller = new AbortController();
    const cancelled = new Error("本地 caller 取消");
    const operation = f.models.getAuth(f.providerId, { signal: controller.signal });
    const rejected = assert.rejects(operation, error => error === cancelled);
    await f.started.promise;
    assert.deepEqual(readStoredCredential(f.providerId, f.authPath), f.before);
    controller.abort(cancelled);
    await rejected;
    assert.equal(f.state().refreshSignal?.aborted, false);
    assert.equal(f.state().writes, 0);

    f.release.resolve();
    await f.settled();
    assert.deepEqual(readStoredCredential(f.providerId, f.authPath), f.after);
    assert.equal(f.state().writes, 1);
    assert.deepEqual(await f.models.getAuth(f.providerId), { auth: { apiKey: f.after.access }, source: "OAuth" });
    assert.equal(f.state().refreshCalls, 1);
  });
}
