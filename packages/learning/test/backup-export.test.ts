import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { crc32, inflateRawSync } from "node:zlib";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { startServer } from "@repa/base";
import { RepaClient, RpcError } from "@repa/base/client";
import { INTERACTION_CAPABILITIES, parse } from "@repa/base/protocol";
import { stringify } from "yaml";
import { createAgentRuntimeForTest } from "../../base/dist/agent/runtime.js";
import { exportReads } from "../../base/dist/feedback/export.js";
import { createLearningPlugin, LEARNING_FORMAT_VERSION } from "../src/plugin.js";
import { learningMethods, type LearningInput, type LearningMethod, type LearningResult } from "../src/protocol.js";
import { FactSchema } from "../src/records-schema.js";
import { TUTOR_AGENT } from "../src/tutor.js";
import { course, topic } from "./fixtures/learning-session.js";

// 只在测试里读包：按中央目录逐项解压并核对 CRC，不依赖生成包的同一份代码。条目按包内顺序排列。
function unzip(buffer: Buffer): Map<string, string> {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "找不到中央目录结尾");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = new Map<string, string>();
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const checksum = buffer.readUInt32LE(offset + 16);
    const compressed = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = inflateRawSync(buffer.subarray(start, start + compressed));
    assert.equal(crc32(data), checksum, `${name} 的 CRC 不符`);
    files.set(name, data.toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const lines = (text: string) => text.split("\n").length - 1;

function rejectsWith(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof RpcError);
    assert.ok(error.data !== null && typeof error.data === "object" && "code" in error.data);
    assert.equal(error.data.code, code);
    return true;
  };
}

/** 本次以来导出读取过的文件；每个只应读一次。 */
function readsSince(before: Map<string, number>): string[] {
  return [...exportReads()].filter(([file, count]) => count !== (before.get(file) ?? 0)).map(([file, count]) => {
    assert.equal(count - (before.get(file) ?? 0), 1, `${file} 只读一次`);
    return file;
  }).sort();
}

async function version(file: string): Promise<string> {
  const value: unknown = JSON.parse(await readFile(new URL(file, import.meta.url), "utf8"));
  assert.ok(value !== null && typeof value === "object" && "version" in value && typeof value.version === "string");
  return value.version;
}

/** 真实的协议后端与学习插件：临时的应用配置目录、空间与两个知识点的小课程；辅导用本地脚本化的模型。 */
async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-learning-data-")));
  const home = path.join(directory, "home");
  const agentDir = path.join(home, "agent");
  const courseDir = path.join(directory, "course");
  await mkdir(agentDir, { recursive: true });
  await mkdir(path.join(courseDir, "topics"), { recursive: true });
  const topics = [topic("t01", 2)];
  await writeFile(path.join(courseDir, "course.yaml"), stringify({ ...course, topics: topics.map((entry) => entry.id) }));
  for (const entry of topics) {
    await writeFile(path.join(courseDir, "topics", `${entry.id}.yaml`), stringify(entry, { aliasDuplicateObjects: false }));
  }
  const faux = fauxProvider({
    api: `learning-data-${randomUUID()}`, provider: `learning-data-${randomUUID()}`,
    models: [{ id: "test", contextWindow: 32768, maxTokens: 512 }], tokensPerSecond: 0,
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const now = Date.UTC(2026, 9, 31, 8);
  const runtime = await createAgentRuntimeForTest({
    agentDir, modelRuntime, defaultModel: { provider: faux.getModel().provider, id: "test" }, now: () => now,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
  });
  const server = await startServer({
    home, runtime, generalAgent: false, directAgents: [TUTOR_AGENT],
    plugins: [createLearningPlugin({ sources: [{ kind: "bundled", directory: courseDir }] })],
  });
  const client = await RepaClient.connect(server.connection, {
    capabilities: { interaction: { supports: [...INTERACTION_CAPABILITIES] }, services: [] },
  });
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const { root } = await client.call("space.create", { root: path.join(directory, "space") });
  async function call<M extends LearningMethod>(method: M, input: LearningInput<M>): Promise<LearningResult<M>> {
    return parse(learningMethods[method].result, await client.call("plugin.call", { pluginId: "learning", method, input })) as LearningResult<M>;
  }
  const state = () => call("state.get", {});
  async function startLesson() {
    const current = await state();
    const candidate = current.menu?.candidates.find((entry) => entry.kind === "lesson");
    assert.ok(current.menu && candidate, JSON.stringify(current.menu));
    await call("menu.select", { menuId: current.menu.menuId, candidateId: candidate.id });
  }
  /** 推进到下一道待答的题，用 text 作答；标准答案是 2。 */
  async function answer(text = "2") {
    for (let step = 0; step < 10; step++) {
      const current = await state();
      const task = current.task;
      assert.ok(task);
      if (task.phase.stage === "awaiting_answer") {
        const deliveryId = task.phase.deliveryId;
        const delivery = task.deliveries.find((entry) => entry.deliveryId === deliveryId);
        assert.ok(delivery);
        const receipt = await call("submission.submit", {
          taskId: task.taskId, deliveryId, submissionId: delivery.submissionId,
          response: { item: { id: delivery.item.id, version: delivery.item.version }, answers: { answer: { type: "text", text } } },
        });
        assert.equal(receipt.status, "recorded");
        return;
      }
      await call("task.advance", { taskId: task.taskId, expectedRevision: current.revision, expectedStage: task.phase.stage });
    }
    throw new Error("没有走到待答的题");
  }
  /** 与辅导说一句话；第一条消息出现时会话记录落盘。 */
  async function chat(text: string) {
    const session = await client.call("session.create", { agent: TUTOR_AGENT });
    faux.setResponses([fauxAssistantMessage("先回顾一下加法的讲解。")]);
    await client.call("session.send", { sessionId: session.id, text });
  }
  return {
    directory, home, root, client, call, state, startLesson, answer, chat,
    records: path.join(root, ".repa", "plugins", "learning", "records.jsonl"),
    sessions: path.join(root, ".repa", "sessions"),
  };
}

test("一键导出的 zip 只含白名单中的文件，没有选择包含会话时没有会话记录；代价关卡：导出只读取学习记录，选择包含会话时再读会话记录", async (t) => {
  const f = await fixture(t);
  await f.startLesson();
  await f.answer();
  // 空间里另有私人笔记、辅导对话和工具输出全文。
  await writeFile(path.join(f.root, "日记.md"), "不该导出的私人内容\n");
  await f.chat("这道题怎么想？");
  await mkdir(path.join(f.root, ".repa", "tool-output", "s1"), { recursive: true });
  await writeFile(path.join(f.root, ".repa", "tool-output", "s1", "call.txt"), "工具输出全文\n");
  const [sessionName, ...others] = (await readdir(f.sessions)).filter((name) => name.endsWith(".jsonl"));
  assert.ok(sessionName !== undefined);
  assert.deepEqual(others, []);
  const records = await readFile(f.records, "utf8");

  const before = exportReads();
  const preview = await f.call("export.prepare", { sessions: false });
  assert.deepEqual(readsSince(before), [f.records]);
  assert.deepEqual(preview.files.map((file) => file.name), ["records.jsonl", "learning.json", "manifest.json"]);
  assert.equal(preview.files[0]?.records, lines(records));
  const created = await f.call("export.create", { exportId: preview.exportId });
  assert.equal(path.dirname(created.path), path.join(f.home, "exports"));
  assert.match(path.basename(created.path), /^repa-learning-export-\d{8}-\d{6}\.zip$/u);
  const zip = unzip(await readFile(created.path));
  assert.deepEqual([...zip.keys()], ["records.jsonl", "learning.json", "manifest.json"]);
  assert.equal(zip.get("records.jsonl"), records);
  assert.deepEqual(JSON.parse(zip.get("learning.json") ?? ""), {
    pluginVersion: await version("../repa-plugin.json"),
    recordsFormat: LEARNING_FORMAT_VERSION,
    course: { id: course.id, version: course.version },
  });
  const manifest: unknown = JSON.parse(zip.get("manifest.json") ?? "");
  assert.ok(manifest !== null && typeof manifest === "object" && "repa" in manifest && "plugin" in manifest && "sessions" in manifest);
  assert.equal(manifest.repa, await version("../../base/package.json"));
  assert.equal(manifest.plugin, "learning");
  assert.equal(manifest.sessions, false);

  // 学习者选择包含会话：再收入空间的会话记录，其余文件仍不收；可以指定存放目录，例如“下载”。
  const downloads = path.join(f.directory, "下载");
  const withSessions = exportReads();
  const full = await f.call("export.prepare", { sessions: true });
  assert.deepEqual(readsSince(withSessions), [f.records, path.join(f.sessions, sessionName)].sort());
  const written = await f.call("export.create", { exportId: full.exportId, directory: downloads });
  assert.equal(path.dirname(written.path), downloads);
  const files = unzip(await readFile(written.path));
  assert.deepEqual([...files.keys()], ["records.jsonl", "learning.json", `sessions/${sessionName}`, "manifest.json"]);
  assert.deepEqual(full.files.map((file) => file.name), [...files.keys()]);
  assert.equal(files.get(`sessions/${sessionName}`), await readFile(path.join(f.sessions, sessionName), "utf8"));
  assert.ok(files.get(`sessions/${sessionName}`)?.includes("这道题怎么想？"));
});

test("作答里写有已保存的密钥时，导出内容中的密钥已被替换，每行仍是有效的学习事实", async (t) => {
  const f = await fixture(t);
  const credential = "repa-test-credential-5d1e7b92";
  await writeFile(path.join(f.home, "agent", "auth.json"), JSON.stringify({ example: { type: "api_key", key: credential } }));
  await f.startLesson();
  await f.answer(`我的密钥是 ${credential}`);
  await f.chat(`帮我看看这个密钥 ${credential}`);
  assert.ok((await readFile(f.records, "utf8")).includes(credential));

  const preview = await f.call("export.prepare", { sessions: true });
  const created = await f.call("export.create", { exportId: preview.exportId });
  const zip = unzip(await readFile(created.path));
  assert.ok([...zip.keys()].some((name) => name.startsWith("sessions/")));
  for (const [name, text] of zip) assert.ok(!text.includes(credential), `${name} 里还有保存的密钥`);
  const records = zip.get("records.jsonl") ?? "";
  assert.ok(records.includes("[已脱敏:credential]"));
  for (const line of records.split("\n").filter((entry) => entry.length > 0)) parse(FactSchema, JSON.parse(line));
  assert.ok((preview.files.find((file) => file.name === "records.jsonl")?.redactions ?? 0) >= 1);
  const manifest: unknown = JSON.parse(zip.get("manifest.json") ?? "");
  assert.ok(manifest !== null && typeof manifest === "object" && "redactions" in manifest && typeof manifest.redactions === "number");
  assert.ok(manifest.redactions >= 2);
});

test("预览与 zip 一致：预览以后新增的记录不进入这次导出，日志末尾的半行不收；写出以后或再次预览以后，旧的预览失效", async (t) => {
  const f = await fixture(t);
  await f.startLesson();
  await f.answer();
  const complete = await readFile(f.records, "utf8");
  // 学习插件正在追加下一条事实时预览：测试替它写下半行。预览以后去掉这半行，插件接着追加。
  await appendFile(f.records, '{"seq":');
  const preview = await f.call("export.prepare", { sessions: false });
  await truncate(f.records, Buffer.byteLength(complete));
  await f.answer();
  assert.ok((await readFile(f.records, "utf8")).length > complete.length);

  const created = await f.call("export.create", { exportId: preview.exportId });
  const zip = unzip(await readFile(created.path));
  assert.equal(zip.get("records.jsonl"), complete);
  assert.equal(preview.files[0]?.records, lines(complete));
  assert.deepEqual(
    [...zip].map(([name, text]) => ({ name, bytes: Buffer.byteLength(text) })),
    preview.files.map(({ name, bytes }) => ({ name, bytes })),
  );
  const manifest: unknown = JSON.parse(zip.get("manifest.json") ?? "");
  assert.ok(manifest !== null && typeof manifest === "object" && "files" in manifest);
  assert.deepEqual(manifest.files, preview.files.filter((file) => file.name !== "manifest.json"));

  await assert.rejects(f.call("export.create", { exportId: preview.exportId }), rejectsWith("export_expired"));
  const first = await f.call("export.prepare", { sessions: false });
  const second = await f.call("export.prepare", { sessions: false });
  await assert.rejects(f.call("export.create", { exportId: first.exportId }), rejectsWith("export_expired"));
  // 存放目录无效时这份预览仍然有效，换一个目录可以再写。
  await assert.rejects(f.call("export.create", { exportId: second.exportId, directory: "下载" }), rejectsWith("invalid_path"));
  const retried = await f.call("export.create", { exportId: second.exportId });
  assert.equal(unzip(await readFile(retried.path)).get("records.jsonl"), await readFile(f.records, "utf8"));
});

test("学习进行中备份，日志末尾的半行不收；接着学，恢复到原位置以后学习插件正常打开，可以继续作答", async (t) => {
  const f = await fixture(t);
  // 打开时的检查在后台进行；立即备份排在它后面，等它做完。
  await f.client.call("backup.create", {});
  await f.startLesson();
  await f.answer();
  const backedUp = await readFile(f.records, "utf8");
  // 学习插件正在追加下一条事实时备份：测试替它写下半行。备份以后去掉这半行，盘上与插件的状态一致，接着学。
  await appendFile(f.records, '{"seq":99,"at":');
  const during = await f.client.call("backup.create", {});
  assert.equal(during.created, true);
  await truncate(f.records, Buffer.byteLength(backedUp));
  await f.answer();
  await f.answer();
  assert.ok((await readFile(f.records, "utf8")).length > backedUp.length);

  await f.client.call("space.close", {});
  const saved = await f.client.call("backup.restore", { root: f.root, id: during.backup.id });
  assert.equal(saved.kind, "beforeRestore");
  assert.equal(await readFile(f.records, "utf8"), backedUp);
  const reopened = await f.client.call("space.open", { root: f.root });
  assert.deepEqual(reopened.disabledPlugins, []);
  const restored = await f.state();
  assert.equal(restored.revision, lines(backedUp));
  assert.equal(restored.task?.submissions.length, 1);
  await f.answer();
  const after = await readFile(f.records, "utf8");
  assert.ok(after.startsWith(backedUp) && after.length > backedUp.length);
  const facts = after.split("\n").filter((line) => line.length > 0).map((line) => parse(FactSchema, JSON.parse(line)));
  assert.deepEqual(facts.map((fact) => fact.seq), facts.map((_, index) => index + 1));
});
