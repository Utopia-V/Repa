import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { crc32, inflateRawSync } from "node:zlib";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import { RepaClient, RpcError } from "../src/client.js";
import { Redactor } from "../src/feedback/redact.js";
import { startServer } from "../src/protocol/server.js";

// 只在测试里读包：按中央目录逐项解压并核对 CRC，不依赖生成包的同一份代码。
function unzip(buffer: Buffer): Map<string, { text: string; utf8: boolean }> {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "找不到中央目录结尾");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = new Map<string, { text: string; utf8: boolean }>();
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const flags = buffer.readUInt16LE(offset + 8);
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
    files.set(name, { text: data.toString("utf8"), utf8: (flags & 0x0800) !== 0 });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-feedback-"));
  const root = path.join(directory, "space");
  const home = path.join(directory, "home");
  const output = path.join(directory, "out");
  await mkdir(root);
  await mkdir(path.join(home, "agent"), { recursive: true });
  const faux = fauxProvider({ api: `feedback-${randomUUID()}`, provider: `feedback-${randomUUID()}`, models: [{ id: "scripted", contextWindow: 16384, maxTokens: 256 }], tokensPerSecond: 0 });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(home, "agent", "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const runtime = await createAgentRuntimeForTest({
    agentDir: path.join(home, "agent"),
    modelRuntime,
    defaultModel: { provider: faux.getModel().provider, id: "scripted" },
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
  });
  const server = await startServer({ home, runtime });
  const client = await RepaClient.connect(server.connection);
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  await client.call("space.open", { root });
  const session = await client.call("session.create", {});
  return { client, faux, root, home, output, session };
}

test("反馈包收齐会话、历史、错误和环境，保存的凭据、环境变量里的密钥和贴进对话的令牌都被替换，自述请求不带工具", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const credential = "repa-test-credential-7f3a9c41";
  const environmentToken = "repa-env-secret-0b8e41d2";
  const bearer = "Bearer abcdefghijklmnopqrstuvwx";
  process.env.REPA_FEEDBACK_TEST_TOKEN = environmentToken;
  t.after(() => {
    delete process.env.REPA_FEEDBACK_TEST_TOKEN;
  });
  await writeFile(path.join(f.home, "agent", "auth.json"), JSON.stringify({ example: { type: "api_key", key: credential } }));
  // 密钥分别出现在用户消息、工具结果和 Agent 回复里。
  await writeFile(path.join(f.root, "notes.txt"), `配置里的 key 是 ${credential}\n`);
  f.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" })]),
    fauxAssistantMessage(`已经保存好了，令牌 ${environmentToken}`),
  ]);
  await f.client.call("session.send", { sessionId: f.session.id, text: `帮我保存到 导出/草稿.md，请求头是 Authorization: ${bearer}` });
  let describeContext: TranscriptContext | undefined;
  f.faux.setResponses([(context) => {
    describeContext = context;
    return fauxAssistantMessage(`Agent 说已经保存，但记录里没有 write 调用。密钥 ${credential}`);
  }]);

  const result = await f.client.call("feedback.create", {
    sessionId: f.session.id,
    describe: true,
    note: `文件夹是空的，我的 key 是 ${credential}`,
    clientErrors: [{ time: "2026-10-21T08:25:53.000Z", message: `连接失败 ${credential}`, source: "web" }],
    directory: f.output,
  });

  assert.equal(path.dirname(result.path), f.output);
  assert.match(path.basename(result.path), /^repa-feedback-\d{8}-\d{6}\.zip$/u);
  assert.ok(describeContext !== undefined);
  assert.deepEqual(getCurrentTools(describeContext.messages), []);
  const files = unzip(await readFile(result.path));
  const sessionFile = `sessions/${f.session.id}.jsonl`;
  assert.deepEqual([...files.keys()].sort(), ["description.md", "environment.json", "errors.json", "history.json", "manifest.json", sessionFile].sort());
  assert.deepEqual(result.files.sort(), [...files.keys()].sort());
  for (const [name, file] of files) {
    assert.ok(file.utf8, `${name} 没有标记 UTF-8 文件名`);
    assert.ok(!file.text.includes(credential), `${name} 里还有保存的凭据`);
    assert.ok(!file.text.includes(environmentToken), `${name} 里还有环境变量里的密钥`);
    assert.ok(!file.text.includes(bearer), `${name} 里还有 Bearer 令牌`);
  }
  const record = files.get(sessionFile)?.text ?? "";
  for (const line of record.split("\n").filter(item => item.length > 0)) JSON.parse(line);
  assert.ok(record.includes("[已脱敏:credential]"));
  assert.ok(record.includes("Bearer [已脱敏:bearer-token]"));
  assert.ok(record.includes("导出/草稿.md"));
  const description = files.get("description.md")?.text ?? "";
  assert.ok(description.includes("记录里没有 write 调用"));
  assert.ok(description.includes("文件夹是空的"));
  const errors: unknown = JSON.parse(files.get("errors.json")?.text ?? "");
  assert.deepEqual(errors, { backend: [], client: [{ time: "2026-10-21T08:25:53.000Z", message: "连接失败 [已脱敏:credential]", source: "web" }] });
  const environment: unknown = JSON.parse(files.get("environment.json")?.text ?? "");
  assert.ok(environment !== null && typeof environment === "object" && "space" in environment && "platform" in environment);
  // 空间以解析符号链接后的路径打开，macOS 的临时目录在 /private 下。
  assert.equal(environment.space, await realpath(f.root));
  assert.equal(environment.platform, process.platform);
  const manifest: unknown = JSON.parse(files.get("manifest.json")?.text ?? "");
  assert.ok(manifest !== null && typeof manifest === "object" && "redactions" in manifest && typeof manifest.redactions === "number");
  assert.ok(manifest.redactions >= 5);
});

test("凭据文件读不了时不生成反馈包，也不写出任何文件", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.home, "agent", "auth.json"), "{ 损坏");
  await assert.rejects(f.client.call("feedback.create", { sessionId: f.session.id, describe: false, directory: f.output }), (error: unknown) => {
    assert.ok(error instanceof RpcError);
    assert.ok(error.data !== null && typeof error.data === "object" && "code" in error.data);
    assert.equal(error.data.code, "feedback_redaction_failed");
    return true;
  });
  await assert.rejects(readdir(f.output), { code: "ENOENT" });
});

test("自述请求失败时照样生成反馈包，description.md 写明失败原因", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("好的")]);
  await f.client.call("session.send", { sessionId: f.session.id, text: "你好" });
  f.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "模型暂时不可用" })]);
  const result = await f.client.call("feedback.create", { sessionId: f.session.id, describe: true, directory: f.output });
  const description = unzip(await readFile(result.path)).get("description.md")?.text ?? "";
  assert.ok(description.includes("Agent 自述没有生成"));
  assert.ok(description.includes("模型暂时不可用"));
});

test("JSONL 里转义过的密钥也被替换，每行仍是有效 JSON；末尾没写完的一行丢掉", () => {
  const secret = "line\"with\\quote-secret";
  const redactor = new Redactor([secret]);
  const complete = JSON.stringify({ text: `值是 ${secret}`, nested: [{ key: secret }] });
  const output = redactor.jsonl(`${complete}\n{"text":"写到一半`);
  assert.equal(output, `${JSON.stringify({ text: "值是 [已脱敏:credential]", nested: [{ key: "[已脱敏:credential]" }] })}`);
  assert.equal(redactor.count, 2);
});
