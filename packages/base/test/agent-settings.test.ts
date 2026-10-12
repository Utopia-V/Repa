import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  fauxProvider,
  type LoginOptions,
  type OAuthCredential,
  type ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-agent-settings-"));
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  const faux = fauxProvider({ api: `settings-api-${randomUUID()}`, provider: `settings-provider-${randomUUID()}`, models: [{ id: "test" }], tokensPerSecond: 0 });
  const createModels = () => ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const models = await createModels();
  models.registerNativeProvider(faux.provider);
  const runtimes: Awaited<ReturnType<typeof createAgentRuntimeForTest>>[] = [];
  const createRuntime = async (options: { modelRuntime?: ModelRuntime; settingsManager?: SettingsManager } = {}) => {
    const runtime = await createAgentRuntimeForTest({ agentDir, modelRuntime: options.modelRuntime ?? models, ...options });
    runtimes.push(runtime);
    return runtime;
  };
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, agentDir, faux, models, createModels, createRuntime };
}

function credential(): OAuthCredential {
  return { type: "oauth", access: "local-test-access", refresh: "local-test-refresh", expires: Date.now() + 3600_000 };
}

function registerOAuth(
  f: Awaited<ReturnType<typeof fixture>>,
  login: (interaction: ProviderAuthInteraction, options?: LoginOptions) => Promise<OAuthCredential>,
  models = f.models,
) {
  const provider = {
    ...f.faux.provider,
    auth: {
      oauth: {
        name: "本地脚本 OAuth",
        login,
        async refresh(value: OAuthCredential) { return value; },
        async toAuth(value: OAuthCredential) { return { apiKey: value.access }; },
      },
    },
  };
  models.registerNativeProvider(provider);
  return provider.id;
}

function fault(code: string) {
  return (error: unknown) => error !== null && typeof error === "object" && "code" in error && error.code === code;
}

test("首次启动持久化 idle 默认值，重建运行时沿用该设置", async (t) => {
  const f = await fixture(t);
  const runtime = await f.createRuntime();
  await runtime.close();
  const saved: unknown = JSON.parse(await readFile(path.join(f.agentDir, "settings.json"), "utf8"));
  assert(saved !== null && typeof saved === "object" && "cacheWarming" in saved);
  assert.equal(saved.cacheWarming, "idle");
  const settings = SettingsManager.create(f.agentDir, f.agentDir, { projectTrusted: false });
  assert.equal(settings.getCacheWarmingMode(), "idle");
  await f.createRuntime({ settingsManager: settings });
});

for (const mode of ["off", "streaming", "idle"] as const) {
  test(`已有 ${mode} 保温设置不被 Repa 默认值覆盖`, async (t) => {
    const f = await fixture(t);
    await writeFile(path.join(f.agentDir, "settings.json"), JSON.stringify({ cacheWarming: mode }));
    const runtime = await f.createRuntime();
    await runtime.close();
    const settings = SettingsManager.create(f.agentDir, f.agentDir, { projectTrusted: false });
    assert.equal(settings.getCacheWarmingMode(), mode);
  });
}

test("底座不信任项目 Pi 设置，登录只使用全局安装标识", async (t) => {
  const f = await fixture(t);
  const projectId = randomUUID();
  const globalId = randomUUID();
  await mkdir(path.join(f.agentDir, ".pi"));
  await writeFile(path.join(f.agentDir, ".pi", "settings.json"), JSON.stringify({ deviceId: projectId, defaultProvider: "project-provider" }));
  await writeFile(path.join(f.agentDir, "settings.json"), JSON.stringify({ cacheWarming: "idle", deviceId: globalId }));
  const provider = registerOAuth(f, async (_interaction, options) => {
    assert.equal(options?.getDeviceId?.(), globalId);
    return credential();
  });
  const runtime = await f.createRuntime();
  await runtime.login(provider, "oauth", async () => "local-code");
  const saved: unknown = JSON.parse(await readFile(path.join(f.agentDir, "settings.json"), "utf8"));
  assert(saved !== null && typeof saved === "object" && "deviceId" in saved);
  assert.equal(saved.deviceId, globalId);
});

test("损坏的全局设置通过 agent_settings 报错并保持原文件", async (t) => {
  const f = await fixture(t);
  const original = "{这不是 JSON\n";
  await writeFile(path.join(f.agentDir, "settings.json"), original);
  await assert.rejects(f.createRuntime(), fault("agent_settings"));
  assert.equal(await readFile(path.join(f.agentDir, "settings.json"), "utf8"), original);
});

test("OAuth 通过真实 ModelRuntime 收到 Repa 应用名与持久 UUID，重建后保持不变", async (t) => {
  const f = await fixture(t);
  const ids: string[] = [];
  const login = async (interaction: ProviderAuthInteraction, options?: LoginOptions) => {
    assert.equal(options?.agentName, "Repa");
    assert(options?.getDeviceId);
    const id = options.getDeviceId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    assert.equal(options.getDeviceId(), id);
    ids.push(id);
    assert.equal(await interaction.prompt({ type: "text", message: "输入本地验证码" }), "local-code");
    return credential();
  };
  const provider = registerOAuth(f, login);
  const runtime = await f.createRuntime();
  await runtime.login(provider, "oauth", async () => "local-code");
  // login 完成即持久化，核对发生在 runtime.close 之前。
  const settings: unknown = JSON.parse(await readFile(path.join(f.agentDir, "settings.json"), "utf8"));
  assert(settings !== null && typeof settings === "object" && "deviceId" in settings);
  assert.equal(settings.deviceId, ids[0]);
  await runtime.close();
  const models = await f.createModels();
  registerOAuth(f, login, models);
  assert.equal((await models.getAuth(provider))?.auth.apiKey, "local-test-access");
  const rebuilt = await f.createRuntime({ modelRuntime: models });
  await rebuilt.login(provider, "oauth", async () => "local-code");
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
});

test("取消 OAuth 提示后不保存半成品凭据", async (t) => {
  const f = await fixture(t);
  const provider = registerOAuth(f, async (interaction, options) => {
    options?.getDeviceId?.();
    await interaction.prompt({ type: "text", message: "等待取消" });
    return credential();
  });
  const runtime = await f.createRuntime();
  await assert.rejects(runtime.login(provider, "oauth", async () => null), fault("auth_cancelled"));
  assert.equal((await f.models.listCredentials()).some(item => item.providerId === provider), false);
  const models = await f.createModels();
  registerOAuth(f, async () => credential(), models);
  assert.equal((await models.listCredentials()).some(item => item.providerId === provider), false);
});

test("OAuth 成功但设备 ID 保存失败时不能报告登录成功", async (t) => {
  const f = await fixture(t);
  let failWrites = false;
  let stored: string | undefined;
  const storage: Parameters<typeof SettingsManager.fromStorage>[0] = {
    withLock(scope, action) {
      if (scope === "project") return;
      if (failWrites) throw new Error("本地设置保存失败");
      stored = action(stored);
    },
  };
  const settings = SettingsManager.fromStorage(storage, { projectTrusted: false });
  const runtime = await f.createRuntime({ settingsManager: settings });
  const provider = registerOAuth(f, async (_interaction, options) => {
    failWrites = true;
    options?.getDeviceId?.();
    return credential();
  });
  await assert.rejects(runtime.login(provider, "oauth", async () => "local-code"), fault("agent_settings"));
});

test("外部中止正在等待的 OAuth 提示后不保存凭据", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const reason = new Error("测试取消登录");
  const provider = registerOAuth(f, async (interaction) => {
    await interaction.prompt({ type: "text", message: "等待验证码" });
    return credential();
  });
  const runtime = await f.createRuntime();
  await assert.rejects(runtime.login(provider, "oauth", async (_request, signal) => {
    assert(signal);
    controller.abort(reason);
    signal.throwIfAborted();
    return "不应提交";
  }, controller.signal), (error: unknown) => error === reason);
  assert.equal((await f.models.listCredentials()).some(item => item.providerId === provider), false);
});

test("全局设置路径读取失败通过 agent_settings 报错", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.agentDir, "settings.json"));
  await assert.rejects(f.createRuntime(), fault("agent_settings"));
});
