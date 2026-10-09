import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { RepaClient, RpcError } from "../src/client.js";
import { methods, type SettingScope } from "../src/protocol.js";
import { startRepaServer, type ServerOptions } from "../src/server.js";

async function fixture(t: TestContext, options: ServerOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-product-injection-"));
  const server = await startRepaServer({ appDirectory: path.join(root, "app"), agentDir: path.join(root, "agent"), ...options });
  const client = await RepaClient.connect(server.connection);
  t.after(async () => { await server.close("cancel"); await client.close(); await rm(root, { recursive: true, force: true }); });
  const space = await client.call("space.open", { path: path.join(root, "space") });
  const scope = { kind: "space" as const, spaceId: space.id };
  async function set(namespace: string, key: string, value: unknown, target: SettingScope = scope) {
    const view = await client.call("settings.get", { scope: target, namespace });
    const entry = view.entries.find(item => item.key === key);
    assert(entry);
    return client.call("settings.set", { scope: target, namespace, key, value, base: entry.revision });
  }
  return { root, server, client, space, scope, set };
}
const fault = (code: string) => (error: unknown) => error instanceof RpcError && error.data !== null &&
  typeof error.data === "object" && "code" in error.data && error.data.code === code;

test("通用应用无学习默认装配，内容与设置可独立使用且协议仅保留通用能力入口", async t => {
  const f = await fixture(t);
  assert.equal(Object.hasOwn(methods, "context.get"), false);
  assert.equal(Object.hasOwn(methods, "context.set"), false);
  assert.equal(Object.hasOwn(methods, "context.preview"), false);
  const settings = await f.client.call("settings.get", { scope: f.scope, namespace: "prompts" });
  assert.equal(settings.entries.find(entry => entry.key === "base")?.effective, "");
  const capabilities = await f.client.call("capability.describe", { scope: f.scope });
  assert(!capabilities.capabilities.some(item => item.pluginId === "repa-learning"));
  const packages = await f.client.call("package.list", { scope: f.scope });
  assert(!packages.some(item => item.scope === "bundled"));
  const written = await f.client.call("content.write", { target: { kind: "file", spaceId: f.space.id, location: { kind: "relative", path: "novel.md" } },
    base: { kind: "absent" }, operationId: randomUUID(), value: { kind: "text", text: "普通领域内容" } });
  assert.equal(written.changes.length, 1);
});

test("产品默认随插件配置变化，仅替换default来源，显式空值与继承覆盖保持原样", async t => {
  const f = await fixture(t, { promptDefaults: configuration => ({
    base: configuration.disabled.includes("product") ? "关闭后的产品默认" : "产品默认",
    append: ["产品追加默认"],
  }) });
  const initial = await f.client.call("settings.get", { scope: f.scope, namespace: "prompts" });
  assert.equal(initial.entries.find(entry => entry.key === "base")?.effective, "产品默认");
  assert.equal(initial.definitions.find(entry => entry.key === "base")?.default, "产品默认");
  await f.set("prompts", "base", "");
  await f.set("prompts", "append", []);
  await f.set("plugins", "disabled", ["product"]);
  const empty = await f.client.call("settings.get", { scope: f.scope, namespace: "prompts" });
  assert.equal(empty.entries.find(entry => entry.key === "base")?.effective, "");
  assert.deepEqual(empty.entries.find(entry => entry.key === "append")?.effective, []);
  assert.equal(empty.definitions.find(entry => entry.key === "base")?.default, "关闭后的产品默认");
  const base = empty.entries.find(entry => entry.key === "base");
  assert(base);
  const reset = await f.client.call("settings.reset", { scope: f.scope, namespace: "prompts", key: "base", base: base.revision });
  assert.equal(reset.entries.find(entry => entry.key === "base")?.effective, "关闭后的产品默认");
  await f.set("prompts", "base", "应用覆盖", { kind: "application" });
  const inherited = await f.client.call("settings.get", { scope: f.scope, namespace: "prompts" });
  assert.equal(inherited.entries.find(entry => entry.key === "base")?.effective, "应用覆盖");
  assert.deepEqual(inherited.entries.find(entry => entry.key === "base")?.source, { kind: "application" });
});

test("产品提示默认值在设置入口校验，未知字段不能进入有效提示", async t => {
  const f = await fixture(t, { promptDefaults: () => Object.assign({ base: "产品提示" }, { unknown: "意外字段" }) });
  await assert.rejects(f.client.call("settings.get", { scope: f.scope, namespace: "prompts" }), fault("invalid_prompt_defaults"));
});

test("产品包列表可由同步配置函数装配，关闭组合后不再贡献资源且数组入口继续可用", async t => {
  const bundled = { id: "product-fixture", enabled: true, directory: fileURLToPath(new URL("./fixtures/repa-test-package", import.meta.url)) };
  const configured: string[][] = [];
  const f = await fixture(t, { bundledPackages: configuration => {
    configured.push([...configuration.disabled]);
    return configuration.disabled.includes("product") ? [] : [bundled];
  } });
  const first = await f.client.call("package.list", { scope: f.scope });
  assert(first.some(item => item.registrationId === bundled.id && item.scope === "bundled"));
  await f.set("plugins", "disabled", ["product"]);
  const disabled = await f.client.call("package.list", { scope: f.scope });
  assert(!disabled.some(item => item.registrationId === bundled.id));
  assert(configured.some(ids => ids.includes("product")));
  const plain = await fixture(t, { bundledPackages: [bundled] });
  const staticPackages = await plain.client.call("package.list", { scope: plain.scope });
  assert(staticPackages.some(item => item.registrationId === bundled.id));
});
