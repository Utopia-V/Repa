import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RepaClient } from "repa/client";
import type { BackendPluginRegistration, PluginSettings } from "repa/plugin";
import { RepaFault } from "repa/protocol";
import { callLearning } from "../src/client.js";
import { learningPluginRegistration } from "../src/contributions.js";
import { DEFAULT_LEARNING_PROMPT } from "../src/default-prompt.js";
import { learningApplicationOptions, startLearningServer } from "../src/product.js";

const configuration = (disabled: string[] = []): PluginSettings => ({
  disabled, backends: [], trusted: [], implementations: {},
});

test("产品组合追加官方注册与包，保留宿主选项、自定义包和明确的空提示默认", () => {
  const plugin: BackendPluginRegistration = { id: "custom", enabled: true, factory: () => ({ capabilities: [] }) };
  const bundle = { id: "custom-package", directory: "/custom/package", enabled: true };
  const original = {
    plugins: [plugin], bundledPackages: [bundle], eventBufferSize: 23,
    promptDefaults: () => ({ base: "", append: [] }),
  };
  const options = learningApplicationOptions(original);
  assert.deepEqual(options.plugins, [learningPluginRegistration, plugin]);
  assert.deepEqual(original.plugins, [plugin]);
  assert.equal(options.eventBufferSize, 23);
  assert.equal(typeof options.bundledPackages, "function");
  if (typeof options.bundledPackages !== "function") assert.fail("产品包应随配置装配");
  assert.deepEqual(options.bundledPackages(configuration()).map(item => item.id), [
    "repa-teaching", "repa-materials", "repa-planning", "repa-review", "repa-organization", bundle.id,
  ]);
  assert.equal(options.bundledPackages(configuration()).at(-1), bundle);
  assert.deepEqual(options.promptDefaults?.(configuration()), { base: "", append: [] });
  const disabled = options.bundledPackages(configuration(["repa-learning"]));
  assert(disabled.slice(0, 5).every(item => !item.enabled));
  assert.equal(disabled.at(-1)?.enabled, true);
});

test("产品组合按配置调用宿主包函数，组合开关只改变自身默认值", () => {
  const configurations: PluginSettings[] = [];
  const options = learningApplicationOptions({ bundledPackages: current => {
    configurations.push(current);
    return [];
  } });
  assert.equal(typeof options.bundledPackages, "function");
  if (typeof options.bundledPackages !== "function") assert.fail("产品包应随配置装配");
  const disabled = configuration(["repa-learning"]);
  assert.equal(options.bundledPackages(disabled).length, 5);
  assert.deepEqual(configurations, [disabled]);
  assert.deepEqual(options.promptDefaults?.(configuration()), { base: DEFAULT_LEARNING_PROMPT });
  assert.deepEqual(options.promptDefaults?.(disabled), { base: "" });
});

test("产品服务器通过能力调用保存与重传语境绑定，关闭组合后保留数据和明确空覆盖", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-learning-product-"));
  const server = await startLearningServer({ appDirectory: path.join(root, "app"), agentDir: path.join(root, "agent") });
  let client: RepaClient | undefined;
  t.after(async () => {
    try {
      await server.close("cancel");
      await client?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  client = await RepaClient.connect(server.connection);
  const space = await client.call("space.open", { path: path.join(root, "space") });
  const scope = { kind: "space" as const, spaceId: space.id };
  const target = { kind: "file" as const, spaceId: space.id, location: { kind: "relative" as const, path: "notes.md" } };
  await client.call("content.write", { target, operationId: randomUUID(), base: { kind: "absent" }, value: { kind: "text", text: "学习者的原始尝试\n" } });
  await client.call("content.associate", { spaceId: space.id, location: target.location, role: "document", operationId: randomUUID() });
  const { ref } = await client.call("content.get", { target });
  assert(ref);
  const current = await callLearning(client, "context.get", { spaceId: space.id });
  const params = {
    spaceId: space.id, operationId: randomUUID(), base: current.revision,
    binding: { kind: "document" as const, ref },
  };
  const saved = await callLearning(client, "context.set", params);
  assert.deepEqual(await callLearning(client, "context.set", params), saved);
  assert.equal((await callLearning(client, "context.preview", { spaceId: space.id })).text, "学习者的原始尝试\n");
  const invalid = Object.assign({ spaceId: space.id }, { unexpected: true });
  await assert.rejects(callLearning(client, "context.get", invalid), error => error instanceof RepaFault && error.code === "invalid_input");
  const prompts = await client.call("settings.get", { scope, namespace: "prompts" });
  const base = prompts.entries.find(item => item.key === "base");
  assert(base);
  await client.call("settings.set", { scope, namespace: "prompts", key: "base", value: "", base: base.revision });
  const plugins = await client.call("settings.get", { scope, namespace: "plugins" });
  const disabled = plugins.entries.find(item => item.key === "disabled");
  assert(disabled);
  await client.call("settings.set", { scope, namespace: "plugins", key: "disabled", value: ["repa-learning"], base: disabled.revision });
  const off = await client.call("settings.get", { scope, namespace: "prompts" });
  assert.equal(off.entries.find(item => item.key === "base")?.effective, "");
  assert.equal((await client.readText(target)).text, "学习者的原始尝试\n");
});
