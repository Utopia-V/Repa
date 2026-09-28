import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Check } from "typebox/value";
import { RepaFault } from "../src/errors.js";
import { ConfigStore, DEFAULT_BASE_PROMPT } from "../src/configuration/store.js";
import {
  SettingsSetParamsSchema,
  SettingsViewSchema,
  type SettingScope,
  type SettingsEntry,
  type SettingsView,
} from "../src/configuration/schema.js";

const application: SettingScope = { kind: "application" };
const alpha: SettingScope = { kind: "space", spaceId: "alpha" };
const alphaOne: SettingScope = { kind: "session", spaceId: "alpha", sessionId: "one" };
const alphaTwo: SettingScope = { kind: "session", spaceId: "alpha", sessionId: "two" };
const betaOne: SettingScope = { kind: "session", spaceId: "beta", sessionId: "one" };

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "repa-configuration-"));
  const appDirectory = path.join(root, "application");
  const resolveSpace = (spaceId: string) => path.join(root, spaceId);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    appDirectory,
    appFile: path.join(appDirectory, "repa-settings.json"),
    spaceFile: (spaceId: string) => path.join(resolveSpace(spaceId), ".repa", "settings.json"),
    open: () => new ConfigStore({ appDirectory, resolveSpace }),
  };
}

function entry(view: SettingsView, key: string): SettingsEntry {
  const found = view.entries.find((candidate) => candidate.key === key);
  assert(found, `缺少设置项 ${key}`);
  return found;
}

async function save(store: ConfigStore, scope: SettingScope, key: string, value: unknown) {
  const previous = await store.get(scope, "prompts");
  return store.set({ scope, namespace: "prompts", key, value, base: entry(previous, key).revision });
}

const fault = (code: string) => (error: unknown) => error instanceof RepaFault && error.code === code;

test("默认学习组合可直接查询，读取和重复重置未设置项不创建配置", async (t) => {
  const f = fixture(t);
  const store = f.open();
  assert.deepEqual(await store.prompts(alphaOne), {
    base: DEFAULT_BASE_PROMPT,
    append: [],
    projectInstructions: false,
    skillCatalog: true,
    environment: true,
    learningContext: true,
    fileChanges: "on-demand",
  });
  const view = await store.get(alphaOne, "prompts");
  assert(Check(SettingsViewSchema, view));
  assert(view.entries.every((item) => item.source === "default" && !Object.hasOwn(item, "override")));
  assert.deepEqual(
    await store.reset({ scope: alphaOne, namespace: "prompts", key: "base", base: entry(view, "base").revision }),
    view,
  );
  assert(!existsSync(f.appDirectory));
  assert(!existsSync(path.join(f.root, "alpha")));
});

test("应用、空间、会话逐项继承，空文本、空列表和 false 保留覆盖与来源", async (t) => {
  const f = fixture(t);
  const store = f.open();
  const initial = await store.get(alphaOne, "prompts");
  await save(store, application, "base", "应用提示");
  await save(store, application, "append", ["应用补充", "第二段"]);
  await save(store, application, "projectInstructions", true);
  let view = await store.get(alphaOne, "prompts");
  assert.equal(entry(view, "base").effective, "应用提示");
  assert.deepEqual(entry(view, "base").source, application);
  assert.equal(entry(view, "base").revision, entry(initial, "base").revision);
  assert(!Object.hasOwn(entry(view, "base"), "override"));

  await save(store, alpha, "base", "空间提示");
  await save(store, alpha, "append", ["空间补充"]);
  await save(store, alphaOne, "base", "");
  await save(store, alphaOne, "append", []);
  await save(store, alphaOne, "projectInstructions", false);
  await save(store, alphaOne, "learningContext", false);
  view = await store.get(alphaOne, "prompts");
  assert.equal(entry(view, "base").override, "");
  assert.equal(entry(view, "base").effective, "");
  assert.deepEqual(entry(view, "append").effective, []);
  assert.equal(entry(view, "projectInstructions").effective, false);
  assert.equal(entry(view, "learningContext").effective, false);
  assert.deepEqual(entry(view, "base").source, alphaOne);
  assert.equal((await store.prompts(alphaTwo)).base, "空间提示");
  assert.deepEqual((await store.prompts(alphaTwo)).append, ["空间补充"]);
  assert.equal((await store.prompts(betaOne)).base, "应用提示");
  assert.deepEqual(entry(await store.get(alphaTwo, "prompts"), "base").source, alpha);

  const resetSession = await store.reset({
    scope: alphaOne, namespace: "prompts", key: "base", base: entry(view, "base").revision,
  });
  assert.equal(entry(resetSession, "base").effective, "空间提示");
  assert.deepEqual(entry(resetSession, "base").source, alpha);
  assert(!Object.hasOwn(entry(resetSession, "base"), "override"));
  assert.notEqual(entry(resetSession, "base").revision, entry(initial, "base").revision);
  const spaceView = await store.get(alpha, "prompts");
  await store.reset({ scope: alpha, namespace: "prompts", key: "base", base: entry(spaceView, "base").revision });
  assert.equal((await store.prompts(alphaOne)).base, "应用提示");
  assert.equal(entry(await store.get(alphaOne, "prompts"), "base").revision, entry(resetSession, "base").revision);
  assert.deepEqual(await f.open().get(alphaOne, "prompts"), await store.get(alphaOne, "prompts"));
});

test("同项过期基准不覆盖后续修改，同值重试保持修订，重置后仍识别旧基准", async (t) => {
  const f = fixture(t);
  const store = f.open();
  const base = entry(await store.get(alpha, "prompts"), "base").revision;
  const first = await store.set({ scope: alpha, namespace: "prompts", key: "base", value: "第一版", base });
  assert.deepEqual(
    await store.set({ scope: alpha, namespace: "prompts", key: "base", value: "第一版", base }),
    first,
  );
  const second = await save(store, alpha, "base", "第二版");
  await assert.rejects(
    store.set({ scope: alpha, namespace: "prompts", key: "base", value: "第一版", base }),
    fault("settings_conflict"),
  );
  await assert.rejects(
    store.reset({ scope: alpha, namespace: "prompts", key: "base", base: entry(first, "base").revision }),
    fault("settings_conflict"),
  );
  assert.equal((await store.prompts(alpha)).base, "第二版");
  const reset = await store.reset({
    scope: alpha, namespace: "prompts", key: "base", base: entry(second, "base").revision,
  });
  await assert.rejects(
    f.open().set({ scope: alpha, namespace: "prompts", key: "base", value: "旧编辑", base }),
    fault("settings_conflict"),
  );
  assert.deepEqual(
    await f.open().reset({ scope: alpha, namespace: "prompts", key: "base", base: entry(second, "base").revision }),
    reset,
  );
  const explicitDefault = await store.set({
    scope: alpha, namespace: "prompts", key: "base", value: DEFAULT_BASE_PROMPT,
    base: entry(reset, "base").revision,
  });
  assert.equal(entry(explicitDefault, "base").override, DEFAULT_BASE_PROMPT);
  assert.deepEqual(entry(explicitDefault, "base").source, alpha);
  assert.notEqual(entry(explicitDefault, "base").revision, entry(reset, "base").revision);
});

function configWorker(
  t: TestContext,
  f: ReturnType<typeof fixture>,
  changes: { scope: SettingScope; key: string; value: unknown }[],
) {
  const module = new URL("../src/configuration/store.ts", import.meta.url).href;
  const script = `
    import path from "node:path";
    import { ConfigStore } from ${JSON.stringify(module)};
    const store = new ConfigStore({ appDirectory: process.argv[1], resolveSpace: id => path.join(process.argv[2], id) });
    const changes = JSON.parse(process.argv[3]);
    const params = await Promise.all(changes.map(async change => {
      const view = await store.get(change.scope, "prompts");
      return { ...change, namespace: "prompts", base: view.entries.find(entry => entry.key === change.key).revision };
    }));
    process.once("message", async () => {
      try { await Promise.all(params.map(item => store.set(item))); }
      catch (error) { console.error(error); process.exitCode = 1; }
      finally { process.disconnect(); }
    });
    process.send("ready");
  `;
  const child = spawn(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval", script,
    f.appDirectory, f.root, JSON.stringify(changes),
  ], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr!.on("data", (bytes: Buffer) => { stderr += bytes.toString(); });
  const ready = new Promise<void>((resolve, reject) => {
    child.once("message", () => resolve());
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`配置进程提前退出：${stderr}`)));
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  return { ready, done, run: () => { child.send("start"); } };
}

test("多个后端并发修改不同项和同文件中的不同作用域，重开后保留全部修改", async (t) => {
  const f = fixture(t);
  const left = configWorker(t, f, [
    { scope: application, key: "base", value: "应用提示" },
    { scope: alpha, key: "learningContext", value: false },
    { scope: alphaOne, key: "append", value: ["会话一"] },
  ]);
  const right = configWorker(t, f, [
    { scope: application, key: "append", value: ["应用补充"] },
    { scope: alpha, key: "base", value: "空间提示" },
    { scope: alphaTwo, key: "fileChanges", value: "diff" },
  ]);
  await Promise.all([left.ready, right.ready]);
  left.run();
  right.run();
  await Promise.all([left.done, right.done]);
  const reopened = f.open();
  assert.equal((await reopened.prompts(application)).base, "应用提示");
  assert.deepEqual((await reopened.prompts(application)).append, ["应用补充"]);
  assert.equal((await reopened.prompts(alphaOne)).base, "空间提示");
  assert.equal((await reopened.prompts(alphaOne)).learningContext, false);
  assert.deepEqual((await reopened.prompts(alphaOne)).append, ["会话一"]);
  assert.deepEqual((await reopened.prompts(alphaTwo)).append, ["应用补充"]);
  assert.equal((await reopened.prompts(alphaTwo)).fileChanges, "diff");
  assert.equal((await reopened.prompts(betaOne)).learningContext, true);
  assert(!existsSync(path.join(f.root, "beta")));
});

test("未定义命名空间、未知项与无效值明确失败，null 不被解释为恢复继承", async (t) => {
  const f = fixture(t);
  const store = f.open();
  const base = entry(await store.get(application, "prompts"), "base").revision;
  for (const [key, value] of [["base", null], ["base", false], ["append", [1]], ["environment", null], ["fileChanges", "always"], ["other", true]]) {
    await assert.rejects(
      store.set({ scope: application, namespace: "prompts", key: key as string, value, base }),
      fault("configuration"),
    );
  }
  await assert.rejects(store.get(application, "models"), fault("unsupported_settings_namespace"));
  await assert.rejects(
    store.set({ scope: application, namespace: "models", key: "base", value: "", base }),
    fault("unsupported_settings_namespace"),
  );
  await assert.rejects(
    store.reset({ scope: application, namespace: "models", key: "base", base }),
    fault("unsupported_settings_namespace"),
  );
  assert(!Check(SettingsSetParamsSchema, { scope: application, namespace: "prompts", key: "base", base }));
  assert(!existsSync(f.appDirectory));
});

test("损坏或无效的持久设置阻止回退和写入，保留文件以供修复", async (t) => {
  const f = fixture(t);
  const store = f.open();
  await save(store, application, "base", "应用提示");
  await save(store, alpha, "base", "空间提示");
  const before = await store.get(alpha, "prompts");
  const file = f.spaceFile("alpha");
  const valid = readFileSync(file, "utf8");
  const invalidValue = JSON.parse(valid);
  invalidValue.prompts.base.value = null;
  const unknownKey = JSON.parse(valid);
  unknownKey.prompts.unknown = { revision: "r", value: true };
  for (const bytes of ["{broken json}\n", JSON.stringify(invalidValue), JSON.stringify(unknownKey)]) {
    writeFileSync(file, bytes);
    await assert.rejects(store.get(alphaOne, "prompts"), fault("configuration"));
    await assert.rejects(
      store.set({ scope: alpha, namespace: "prompts", key: "append", value: ["新的补充"], base: entry(before, "append").revision }),
      fault("configuration"),
    );
    assert.equal(readFileSync(file, "utf8"), bytes);
  }
  writeFileSync(file, valid);
  assert.equal((await f.open().prompts(alphaOne)).base, "空间提示");
});
