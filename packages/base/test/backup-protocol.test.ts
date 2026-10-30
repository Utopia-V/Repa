import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import { RepaClient, RpcError } from "../src/client.js";
import type { Plugin } from "../src/plugin.js";
import type { BackupStatus } from "../src/protocol.js";
import { startServer } from "../src/protocol/server.js";
import { object, parse, RepaFault } from "../src/schema.js";

const AnswerSchema = object({ text: Type.String() });
const NoteSchema = object({ file: Type.String(), text: Type.String() });

/**
 * 按学习插件的写法记事实：以追加方式打开 records.jsonl，一次写入完整的行。打开时若日志末尾是半行就不再追加，
 * 与学习记录的规则相同（学习插件此时报 learning_log_blocked）。
 */
const recordsPlugin: Plugin = {
  id: "records",
  async open(host) {
    const file = path.join(host.space.dataDir, "records.jsonl");
    let text = "";
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const blocked = text !== "" && !text.endsWith("\n");
    let count = text.split("\n").length - 1;
    return {
      methods: {
        answer: {
          parameters: AnswerSchema,
          async invoke(input) {
            if (blocked) throw new RepaFault("log_blocked", "日志尾部残缺，不能继续追加");
            const handle = await open(file, "a", 0o600);
            try {
              await handle.writeFile(`${JSON.stringify({ seq: ++count, text: parse(AnswerSchema, input).text })}\n`);
              await handle.sync();
            } finally {
              await handle.close();
            }
            return count;
          },
        },
        note: {
          parameters: NoteSchema,
          async invoke(input) {
            const { file: name, text: content } = parse(NoteSchema, input);
            await host.files.write(name, content);
            return null;
          },
        },
      },
    };
  },
};

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-backup-protocol-")));
  const root = path.join(directory, "space");
  const home = path.join(directory, "home");
  await mkdir(root);
  await mkdir(path.join(home, "agent"), { recursive: true });
  const faux = fauxProvider({ api: `backup-${randomUUID()}`, provider: `backup-${randomUUID()}`, models: [{ id: "scripted", contextWindow: 16384, maxTokens: 256 }], tokensPerSecond: 0 });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(home, "agent", "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const runtime = await createAgentRuntimeForTest({
    agentDir: path.join(home, "agent"),
    modelRuntime,
    defaultModel: { provider: faux.getModel().provider, id: "scripted" },
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
  });
  const server = await startServer({ home, runtime, plugins: [recordsPlugin] });
  const client = await RepaClient.connect(server.connection);
  const updates: BackupStatus[] = [];
  client.on("backup.updated", (status) => { updates.push(status); });
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const answer = (text: string) => client.call("plugin.call", { pluginId: "records", method: "answer", input: { text } });
  const records = () => readFile(path.join(root, ".repa", "plugins", "records", "records.jsonl"), "utf8");
  return { directory, root, home, client, updates, answer, records };
}

function rejectsWith(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof RpcError);
    assert.ok(error.data !== null && typeof error.data === "object" && "code" in error.data);
    assert.equal(error.data.code, code);
    return true;
  };
}

const fact = (seq: number, text: string) => `${JSON.stringify({ seq, text })}\n`;

test("打开空间以后备份一次，没有变化时立即备份也不复制；关闭空间之前再备份一次；设置页的间隔与份数可以修改", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.client.call("backup.status", {}), null);
  assert.deepEqual((await f.client.call("settings.get", {})).backup, { intervalMinutes: 30, keep: 5 });
  const settings = await f.client.call("settings.set", { backup: { intervalMinutes: 10, keep: 3 } });
  assert.deepEqual(settings.backup, { intervalMinutes: 10, keep: 3 });
  await assert.rejects(f.client.call("settings.set", { backup: { intervalMinutes: 1, keep: 3 } }), (error: unknown) => error instanceof RpcError && error.code === -32602);
  const { root } = await f.client.call("space.open", { root: f.root });
  // 打开时的检查在后台进行；立即备份排在它后面，返回时它已经备份过，这次没有变化。
  const unchanged = await f.client.call("backup.create", {});
  assert.equal(unchanged.created, false);
  assert.deepEqual(f.updates.map((status) => status.lastSuccess), [unchanged.backup.createdAt]);
  await f.answer("第一题");
  const created = await f.client.call("backup.create", {});
  assert.equal(created.created, true);
  assert.deepEqual(await f.client.call("backup.status", {}), { root, lastSuccess: created.backup.createdAt, failure: null });
  await f.answer("第二题");
  await f.client.call("space.close", {});
  assert.equal(await f.client.call("backup.status", {}), null);
  const [listed] = await f.client.call("backup.list", {});
  assert.equal(listed?.root, root);
  assert.equal(listed?.exists, true);
  assert.equal(listed?.backups.length, 3);
  assert.equal(f.updates.at(-1)?.lastSuccess, listed?.backups[0]?.createdAt);
  await assert.rejects(f.client.call("backup.create", {}), rejectsWith("space_not_open"));
});

test("学习进行中备份，恢复到原位置以后学习记录没有半行，可以继续作答；恢复前的备份可以删除", async (t) => {
  const f = await fixture(t);
  const { root } = await f.client.call("space.open", { root: f.root });
  await f.answer("第一题");
  await f.answer("第二题");
  // 学习插件正在追加第三条时备份。
  const file = path.join(root, ".repa", "plugins", "records", "records.jsonl");
  const third = fact(3, "第三题");
  const handle = await open(file, "a");
  try {
    await handle.writeFile(third.slice(0, 12));
    const during = await f.client.call("backup.create", {});
    assert.equal(during.created, true);
    await handle.writeFile(third.slice(12));
    await f.answer("第四题");
    await assert.rejects(f.client.call("backup.restore", { root, id: during.backup.id }), rejectsWith("space_locked"));
    await f.client.call("space.close", {});
    const before = await f.client.call("backup.restore", { root, id: during.backup.id });
    assert.equal(before.kind, "beforeRestore");
  } finally {
    await handle.close();
  }
  assert.equal(await f.records(), fact(1, "第一题") + fact(2, "第二题"));
  await f.client.call("space.open", { root });
  assert.equal(await f.answer("恢复后作答"), 3);
  assert.equal(await f.records(), fact(1, "第一题") + fact(2, "第二题") + fact(3, "恢复后作答"));
  await f.client.call("space.close", {});
  const [listed] = await f.client.call("backup.list", {});
  const before = listed?.backups.find((backup) => backup.kind === "beforeRestore");
  assert.ok(before);
  await f.client.call("backup.delete", { root, id: before.id });
  assert.ok(!(await f.client.call("backup.list", {}))[0]?.backups.some((backup) => backup.id === before.id));
  assert.equal(f.updates.at(-1)?.root, root);
  await assert.rejects(f.client.call("backup.delete", { root, id: before.id }), rejectsWith("backup_not_found"));
});

test("删除空间文件夹以后，用最近一份备份恢复到新文件夹：学习进度与备份时一致，空间文件为备份时历史中的最近一次修订", async (t) => {
  const f = await fixture(t);
  const { root } = await f.client.call("space.open", { root: f.root });
  await f.answer("第一题");
  await f.client.call("plugin.call", { pluginId: "records", method: "note", input: { file: "notes/a.md", text: "备份时的笔记\n" } });
  const { backup } = await f.client.call("backup.create", {});
  await f.client.call("space.close", {});
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  const [listed] = await f.client.call("backup.list", {});
  assert.equal(listed?.exists, false);
  await assert.rejects(f.client.call("backup.restore", { root, id: backup.id }), rejectsWith("space_not_found"));
  const target = path.join(f.directory, "恢复的空间");
  assert.deepEqual(await f.client.call("backup.restoreTo", { root, id: backup.id, target }), { root: target });
  await assert.rejects(f.client.call("backup.restoreTo", { root, id: backup.id, target }), rejectsWith("restore_target_exists"));
  await f.client.call("space.open", { root: target });
  assert.equal(await readFile(path.join(target, "notes", "a.md"), "utf8"), "备份时的笔记\n");
  assert.equal(await f.answer("恢复后作答"), 2);
  assert.equal(await readFile(path.join(target, ".repa", "plugins", "records", "records.jsonl"), "utf8"), fact(1, "第一题") + fact(2, "恢复后作答"));
});
