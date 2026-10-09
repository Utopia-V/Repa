import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Check } from "typebox/value";
import { callLearning, startLearningServer } from "@repa/learning";
import { RepaClient, startRepaServer, type RepaServer } from "repa";
import { CatalogSchema } from "../src/content/catalog.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-format-boundary-"));
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [], extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"],
  }));
  const options = { agentDir, appDirectory: path.join(root, "app") };
  const opened: Array<{ server: RepaServer; client: RepaClient }> = [];
  t.after(async () => {
    for (const { server, client } of opened) { await server.close("cancel"); await client.close(); }
    await rm(root, { recursive: true, force: true });
  });
  async function open(learning: boolean, directory = path.join(root, "space")) {
    const server = await (learning ? startLearningServer : startRepaServer)(options);
    const client = await RepaClient.connect(server.connection);
    opened.push({ server, client });
    const space = await client.call("space.open", { path: directory });
    return { server, client, space, async close() { await server.close("cancel"); await client.close(); } };
  }
  const learning = await open(true);
  async function document(file: string, text: string) {
    const location = { kind: "relative" as const, path: file };
    await learning.client.call("content.write", { target: { kind: "file", spaceId: learning.space.id, location },
      base: { kind: "absent" }, operationId: randomUUID(), value: { kind: "text", text } });
    const associated = await learning.client.call("content.associate", { spaceId: learning.space.id, location, role: "document", operationId: randomUUID() });
    const ref = associated.contents[0]?.ref;
    assert(ref);
    return ref;
  }
  const note = await document("goal.md", "长期领域内容");
  const composition = await document("context.json", JSON.stringify({ items: [{ ref: note, mode: "expand" }] }));
  const state = await callLearning(learning.client, "context.get", { spaceId: learning.space.id });
  const bindingOperation = randomUUID();
  await callLearning(learning.client, "context.set", { spaceId: learning.space.id, base: state.revision,
    operationId: bindingOperation, binding: { kind: "composition", ref: composition } });
  return { root, learning, open, note, composition, bindingOperation };
}

async function unchangedFiles(directory: string) {
  const files = ["catalog.json", ...((await readdir(path.join(directory, "operations"))).map(name => path.join("operations", name)))];
  return Promise.all(files.map(async file => ({ file, bytes: await readFile(path.join(directory, file)) })));
}

test("学习空间由通用底座打开后拒绝无格式owner的独立复制，同身份备份再由产品恢复仍可用", async t => {
  const f = await fixture(t);
  const before = await unchangedFiles(path.join(f.learning.space.path, ".repa/content"));
  await f.learning.close();
  const core = await f.open(false);
  const rootEntries = (await readdir(f.root)).sort();
  const copyPath = path.join(f.root, "copy");
  const copy = await core.client.call("space.copy", { spaceId: core.space.id, destination: copyPath, operationId: randomUUID() });
  assert.equal(copy.status, "failed");
  assert.equal(copy.error?.code, "content_format_unavailable");
  await assert.rejects(access(copyPath), { code: "ENOENT" });
  assert.deepEqual((await readdir(f.root)).sort(), rootEntries);
  const backup = await core.client.call("space.backup", { spaceId: core.space.id, destination: path.join(f.root, "backup"), operationId: randomUUID() });
  assert.equal(backup.status, "completed", backup.error?.message);
  assert.deepEqual(await unchangedFiles(path.join(core.space.path, ".repa/content")), before);
  await core.close();
  const restoring = await f.open(true, path.join(f.root, "restoring-host"));
  const restoredPath = path.join(f.root, "restored");
  const restored = await restoring.client.call("space.restore", { source: backup.destination, destination: restoredPath, operationId: randomUUID() });
  assert.equal(restored.status, "completed", restored.error?.message);
  const restoredSpace = await restoring.client.call("space.open", { path: restoredPath });
  assert.equal(restoredSpace.id, f.learning.space.id);
  assert.equal((await callLearning(restoring.client, "context.preview", { spaceId: restoredSpace.id })).text,
    `## ${f.note.id}\n长期领域内容`);
});

test("当前清单已无扩展字段时，历史撤回清单仍要求格式owner，失败复制不发布目标", async t => {
  const f = await fixture(t);
  const bound = await callLearning(f.learning.client, "context.get", { spaceId: f.learning.space.id });
  await callLearning(f.learning.client, "context.set", { spaceId: f.learning.space.id, base: bound.revision, operationId: randomUUID(), binding: null });
  await f.learning.close();
  const catalogPath = path.join(f.learning.space.path, ".repa/content/catalog.json");
  const raw: unknown = JSON.parse(await readFile(catalogPath, "utf8"));
  assert(Check(CatalogSchema, raw));
  // 夹具模拟当前关系已被外部整理移除；历史操作的原始清单和字节保持不变。
  delete raw.context;
  await writeFile(catalogPath, `${JSON.stringify(raw, null, 2)}\n`);
  const before = await unchangedFiles(path.join(f.learning.space.path, ".repa/content"));
  const core = await f.open(false);
  const destination = path.join(f.root, "history-copy");
  const copy = await core.client.call("space.copy", { spaceId: core.space.id, destination, operationId: randomUUID() });
  assert.equal(copy.status, "failed");
  assert.equal(copy.error?.code, "content_format_unavailable");
  await assert.rejects(access(destination), { code: "ENOENT" });
  assert.deepEqual(await unchangedFiles(path.join(core.space.path, ".repa/content")), before);
});

test("产品禁用学习运行时仍保留安装格式，独立复制的当前与历史组成可重映射并撤回", async t => {
  const f = await fixture(t);
  const bound = await callLearning(f.learning.client, "context.get", { spaceId: f.learning.space.id });
  const clearOperation = randomUUID();
  await callLearning(f.learning.client, "context.set", { spaceId: f.learning.space.id, base: bound.revision,
    operationId: clearOperation, binding: null });
  const scope = { kind: "space" as const, spaceId: f.learning.space.id };
  const settings = await f.learning.client.call("settings.get", { scope, namespace: "plugins" });
  const disabled = settings.entries.find(entry => entry.key === "disabled");
  assert(disabled);
  await f.learning.client.call("settings.set", { scope, namespace: "plugins", key: "disabled", base: disabled.revision, value: ["repa-learning"] });
  const copy = await f.learning.client.call("space.copy", { spaceId: scope.spaceId, destination: path.join(f.root, "disabled-copy"), operationId: randomUUID() });
  assert.equal(copy.status, "completed", copy.error?.message);
  const space = await f.learning.client.call("space.open", { path: copy.destination });
  const copySettings = await f.learning.client.call("settings.get", { scope: { kind: "space", spaceId: space.id }, namespace: "plugins" });
  const copyDisabled = copySettings.entries.find(entry => entry.key === "disabled");
  assert(copyDisabled);
  await f.learning.client.call("settings.set", { scope: { kind: "space", spaceId: space.id }, namespace: "plugins", key: "disabled", base: copyDisabled.revision, value: [] });
  assert.equal((await callLearning(f.learning.client, "context.get", { spaceId: space.id })).binding, null);
  await f.learning.client.call("operation.undo", { spaceId: space.id, operationId: clearOperation, undoOperationId: randomUUID() });
  const current = await callLearning(f.learning.client, "context.get", { spaceId: space.id });
  assert.deepEqual(current.binding, { kind: "composition", ref: { spaceId: space.id, id: f.composition.id } });
  assert.equal((await callLearning(f.learning.client, "context.preview", { spaceId: space.id })).text, `## ${f.note.id}\n长期领域内容`);
  const composition = JSON.parse(await readFile(path.join(space.path, "context.json"), "utf8"));
  assert.deepEqual(composition.items[0].ref, { spaceId: space.id, id: f.note.id });
});
