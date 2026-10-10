import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getInitialSystemMessage, resolveTranscriptTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import { RepaClient } from "../src/client.js";
import type { ChangeFeed, Plugin } from "../src/plugin.js";
import { startServer } from "../src/protocol/server.js";
import { object, parse } from "../src/schema.js";

function viewTexts(context: TranscriptContext): string[] {
  return context.messages.flatMap((message) => {
    const text = typeof message.content === "string" ? message.content : message.content?.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") ?? "";
    return text.includes("<repa-view") ? [text] : [];
  });
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-base-e2e-"));
  const root = path.join(directory, "space");
  const home = path.join(directory, "home");
  const agentDir = path.join(home, "agent");
  await mkdir(root);
  await mkdir(agentDir, { recursive: true });
  const faux = fauxProvider({
    api: `e2e-${randomUUID()}`, provider: `e2e-${randomUUID()}`,
    tokensPerSecond: 0,
    models: [{ id: "scripted", reasoning: false, input: ["text"], contextWindow: 16384, maxTokens: 256 }],
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false,
  });
  const loginAnswers: string[] = [];
  modelRuntime.registerNativeProvider({
    ...faux.provider,
    auth: {
      ...faux.provider.auth,
      oauth: {
        name: "脚本化登录",
        async login(interaction) {
          interaction.notify({ type: "auth_url", url: "https://example.invalid/login", instructions: "打开登录页" });
          loginAnswers.push(await interaction.prompt({ type: "select", message: "选择账号", options: [{ id: "local", label: "本地测试" }] }));
          loginAnswers.push(await interaction.prompt({ type: "manual_code", message: "输入授权码" }));
          loginAnswers.push(await interaction.prompt({ type: "secret", message: "输入密钥" }));
          return { type: "oauth", refresh: "fixture-refresh", access: "fixture-access", expires: Date.now() + 3600000 };
        },
        async refresh(credential) { return credential; },
        async toAuth(credential) { return { apiKey: credential.access }; },
      },
    },
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const source = faux.provider.streamSimple(model, context, options);
      void (async () => {
        for await (const event of source) {
          if (event.type === "done") {
            event.message.usage.cacheRead = 120;
            event.message.usage.cacheWrite = 30;
          }
          stream.push(event);
        }
      })().catch((error: unknown) => {
        const response = fauxAssistantMessage("", { stopReason: "error", errorMessage: String(error) });
        stream.push({ type: "error", reason: "error", error: response });
      });
      return stream;
    },
  });
  let now = Date.now();
  const runtime = await createAgentRuntimeForTest({
    agentDir, modelRuntime, defaultModel: { provider: faux.getModel().provider, id: faux.getModel().id },
    now: () => now, viewBatchSize: 2, cacheTtlMs: 1000,
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false, reserveTokens: 400, keepRecentTokens: 16 },
      cacheWarming: "off",
    }),
  });
  const captures: TranscriptContext[] = [];
  const feeds: ChangeFeed[] = [];
  let view = "课程状态甲";
  const SetViewSchema = object({ text: Type.String() });
  const plugin: Plugin = {
    id: "probe",
    async open(host) {
      let cursor: string | undefined;
      return {
        instructions: () => "插件原说明",
        tools: () => [{
          name: "probe_write", description: "写入空间笔记", parameters: object({}),
          async execute() {
            await host.files.write("note.txt", "中文标点，（：\r\n");
            return { text: "笔记已写入" };
          },
        }],
        view: async () => view,
        async onChange() {
          const feed = await host.history.changes(cursor);
          feeds.push(feed);
          cursor = feed.revision;
        },
        methods: {
          setView: {
            parameters: SetViewSchema,
            async invoke(input) {
              view = parse(SetViewSchema, input).text;
              return null;
            },
          },
        },
      };
    },
  };
  const server = await startServer({ home, plugins: [plugin], runtime });
  const client = await RepaClient.connect(server.connection);
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  await client.call("space.open", { root });
  const session = await client.call("session.create", {});
  const respond = (text = "回答") => {
    faux.setResponses([(context) => {
      captures.push(structuredClone(context));
      return fauxAssistantMessage(text);
    }]);
  };
  const send = () => client.call("session.send", { sessionId: session.id, text: "继续" });
  const history = () => client.call("session.history", { sessionId: session.id });
  return { root, home, client, session, faux, captures, feeds, loginAnswers, respond, send, history, advance: () => { now += 2000; } };
}

test("通过浏览器客户端打开空间、调用插件工具、记录整次运行并撤回", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const before = await f.client.call("history.list", {});
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("probe_write", {})),
    fauxAssistantMessage("笔记完成"),
  ]);
  await f.send();
  assert.equal(await readFile(path.join(f.root, "note.txt"), "utf8"), "中文标点，（：\r\n");
  const after = await f.client.call("history.list", {});
  assert.equal(after.length, before.length + 1);
  const revision = after[0];
  assert(revision);
  assert.equal(revision.source.kind, "agent");
  assert(revision.source.kind === "agent");
  const recordedRunId = revision.source.runId;
  assert((await f.history()).some(entry => entry.type === "run" && entry.data !== null && typeof entry.data === "object" && "runId" in entry.data && entry.data.runId === recordedRunId));
  const wake = f.feeds.find(feed => feed.revisions.some(item => item.id === revision.id));
  assert(wake);
  assert(wake.revisions.some(item => item.changes.some(change => change.path === "note.txt" && change.kind === "added")));
  const result = await f.client.call("history.undo", { revision: revision.id });
  assert.deepEqual(result.restored, ["note.txt"]);
  assert.deepEqual(result.conflicts, []);
  await assert.rejects(readFile(path.join(f.root, "note.txt")), { code: "ENOENT" });
  assert((await f.history()).some(entry => entry.type === "tool"));
  await f.client.call("space.close", {});
  await f.client.call("space.open", { root: f.root });
  assert((await f.history()).some(entry => entry.type === "run" && entry.data !== null && typeof entry.data === "object" && "runId" in entry.data && entry.data.runId === recordedRunId));
});

test("view 按变化追加、批量清理和过期清理，提示覆盖仅追加一段", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  f.respond();
  await f.send();
  const first = f.captures[0];
  assert(first);
  const initial = getInitialSystemMessage(first.messages);
  assert(initial);
  assert.equal(first.messages[0]?.role, "system");
  assert(initial.toolsAdded?.some(tool => tool.name === "probe_write"));
  f.respond();
  await f.send();
  assert.equal((await f.history()).filter(entry => entry.type === "view").length, 1);
  const setView = (text: string) => f.client.call("plugin.call", { pluginId: "probe", method: "setView", input: { text } });
  await setView("课程状态乙");
  f.respond();
  await f.send();
  assert.equal((await f.history()).filter(entry => entry.type === "view").length, 2);
  await setView("课程状态丙");
  f.respond();
  await f.send();
  assert.equal((await f.history()).filter(entry => entry.type === "contextEdit").length, 2);
  f.respond();
  await f.send();
  assert.equal(viewTexts(f.captures.at(-1) as TranscriptContext).length, 1);
  assert.match(viewTexts(f.captures.at(-1) as TranscriptContext)[0] ?? "", /课程状态丙/u);
  await setView("课程状态丁");
  f.respond();
  await f.send();
  f.advance();
  await f.client.call("prompt.set", { scope: "space", id: "plugin:probe", override: { text: "插件覆盖说明" } });
  const promptsBefore = (await f.history()).filter(entry => entry.type === "prompt").length;
  f.respond();
  await f.send();
  const current = f.captures.at(-1);
  assert(current);
  assert.equal(viewTexts(current).length, 1);
  assert.match(viewTexts(current)[0] ?? "", /课程状态丁/u);
  assert.match(getCurrentSystemPrompt(current.messages), /插件覆盖说明/u);
  const promptEntries = (await f.history()).filter(entry => entry.type === "prompt");
  assert.equal(promptEntries.length, promptsBefore + 1);
  const systemPatches = current.messages.filter(message => message.role === "system");
  assert.equal(Object.keys(systemPatches.at(-1)?.sections ?? {}).length, 1);
  assert((await f.history()).some(entry => entry.usage?.cacheRead === 120 && entry.usage.cacheWrite === 30));
  // 过期同时改变 view 时，新版排队也必须使这次请求只保留一份当前状态。
  await setView("课程状态戊");
  f.advance();
  f.respond();
  await f.send();
  const changedAfterExpiry = f.captures.at(-1);
  assert(changedAfterExpiry);
  assert.equal(viewTexts(changedAfterExpiry).length, 1);
  assert.match(viewTexts(changedAfterExpiry)[0] ?? "", /课程状态戊/u);
  for (const capture of f.captures) {
    assert.equal(capture.messages[0]?.role, "system");
    assert.deepEqual(getInitialSystemMessage(capture.messages), initial);
    assert.deepEqual(resolveTranscriptTools(capture.messages, true), { requestTools: initial.toolsAdded, anchorsAdditions: true });
  }
});

test("命令确认经协议答复后执行，拒绝时不落文件", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const decisions: string[] = [];
  let accept = false;
  let reply = Promise.resolve();
  const off = f.client.on("confirm.request", ({ id, request }) => {
    assert.equal(request.kind, "command");
    decisions.push(request.title);
    reply = f.client.call("confirm.reply", { id, value: accept }).then(() => undefined);
  });
  t.after(off);
  for (const permitted of [false, true]) {
    accept = permitted;
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "printf confirmed > command.txt" })),
      fauxAssistantMessage("命令处理结束"),
    ]);
    await f.send();
    await reply;
    if (!permitted) await assert.rejects(readFile(path.join(f.root, "command.txt")), { code: "ENOENT" });
  }
  assert.equal(decisions.length, 2);
  assert.equal(await readFile(path.join(f.root, "command.txt"), "utf8"), "confirmed");
});

test("SDK 默认压缩后下一次请求只获得最新 view", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  f.respond("原始回答".repeat(300));
  await f.send();
  await f.client.call("plugin.call", { pluginId: "probe", method: "setView", input: { text: "压缩前最新状态" } });
  f.respond("后续回答".repeat(300));
  await f.send();
  const summaryInputs: TranscriptContext[] = [];
  f.faux.setResponses([
    (context) => {
      summaryInputs.push(structuredClone(context));
      return fauxAssistantMessage("会话摘要：已完成两轮工作。");
    },
    (context) => {
      summaryInputs.push(structuredClone(context));
      return fauxAssistantMessage("当前回合摘要：继续工作。");
    },
  ]);
  await f.client.call("session.compact", { sessionId: f.session.id });
  assert((await f.history()).some(entry => entry.type === "compaction"));
  assert(summaryInputs.length > 0);
  assert(!JSON.stringify(summaryInputs).includes("<repa-view"));
  f.respond();
  await f.send();
  const current = f.captures.at(-1);
  assert(current);
  assert.equal(viewTexts(current).length, 1);
  assert.match(viewTexts(current)[0] ?? "", /压缩前最新状态/u);
});


test("真实登录运行时把 OAuth 交互映射为前端问答并保存凭据", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const kinds: string[] = [];
  const replies: Promise<unknown>[] = [];
  const stop = f.client.on("confirm.request", ({ id, request }) => {
    kinds.push(request.kind);
    let value: string | boolean = true;
    if (request.kind === "select") value = "local";
    if (request.kind === "input") value = request.secret ? "test-secret" : "test-code";
    if (request.kind === "display") assert.equal(request.url, "https://example.invalid/login");
    replies.push(f.client.call("confirm.reply", { id, value }));
  });
  t.after(stop);
  await f.client.call("auth.login", { provider: f.faux.getModel().provider, type: "oauth" });
  await Promise.all(replies);
  assert.deepEqual(kinds, ["display", "select", "input", "input"]);
  assert.deepEqual(f.loginAnswers, ["local", "test-code", "test-secret"]);
  const credentials: unknown = JSON.parse(await readFile(path.join(f.home, "agent", "auth.json"), "utf8"));
  assert(credentials && typeof credentials === "object" && Object.hasOwn(credentials, f.faux.getModel().provider));
  await f.client.call("auth.logout", { provider: f.faux.getModel().provider });
  const remaining: unknown = JSON.parse(await readFile(path.join(f.home, "agent", "auth.json"), "utf8"));
  assert(remaining && typeof remaining === "object" && !Object.hasOwn(remaining, f.faux.getModel().provider));
});
