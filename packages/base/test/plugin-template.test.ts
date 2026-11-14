import assert from "node:assert/strict";
import { once } from "node:events";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { RepaClient } from "../src/client.js";
import { startRepaProcess } from "../dist/process.js";

// 随底座附带的写插件 Skill 和它的模板。模板要经真实的加载路径装上：构建后的 CLI 在 Node 上导入快照里的 .ts，
// 类型剥离与解析钩子都与 tsx 无关，所以经子进程。底座的接口一变，模板装不上或调用失败，这里就报出来。
const SKILL = fileURLToPath(new URL("../skills/plugin-authoring/", import.meta.url));

interface ChatMessage { role: string; content?: unknown }

/** 按对话里已有的工具结果数走一步：先加载模板插件，再调用它的工具，最后结束。记下每次请求的系统提示与工具名。 */
function scriptedModel(seen: { system: string; tools: string[] }[]) {
  return (request: IncomingMessage, response: ServerResponse, body: string): void => {
    const parsed = JSON.parse(body) as { messages: ChatMessage[]; tools?: { function: { name: string } }[] };
    const system = parsed.messages.find((message) => message.role === "system")?.content;
    seen.push({ system: typeof system === "string" ? system : JSON.stringify(system), tools: (parsed.tools ?? []).map((tool) => tool.function.name) });
    const done = parsed.messages.filter((message) => message.role === "tool").length;
    const call = (name: string, input: object) => ({ role: "assistant", tool_calls: [{ index: 0, id: `call_${done}`, type: "function", function: { name, arguments: JSON.stringify(input) } }] });
    const delta = done === 0 ? call("plugin", { action: "load", id: "example" })
      : done === 1 ? call("example_add", { text: "第一行" })
        : { role: "assistant", content: "完成" };
    const finish = "content" in delta ? "stop" : "tool_calls";
    const chunk = (choice: object) => `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [choice] })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`${chunk({ index: 0, delta, finish_reason: null })}${chunk({ index: 0, delta: {}, finish_reason: finish })}data: [DONE]\n\n`);
    void request;
  };
}

test("写插件 Skill 列在通用 Agent 的系统提示里；它的模板复制进空间以后，经 plugin 工具加载、批准，下一次回复调用模板的工具成功", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-plugin-template-")));
  const closers: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    await rm(directory, { recursive: true, force: true });
  });
  const seen: { system: string; tools: string[] }[] = [];
  const answer = scriptedModel(seen);
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => answer(request, response, body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  const home = path.join(directory, "home");
  await mkdir(path.join(home, "agent"), { recursive: true });
  await writeFile(path.join(home, "agent", "models.json"), JSON.stringify({
    providers: { fake: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "fake", models: [{ id: "scripted" }] } },
  }));
  const backend = await startRepaProcess({ home });
  closers.push(() => backend.close());
  const client = await RepaClient.connect(backend.connection);
  closers.push(() => client.close());
  const approvals: unknown[] = [];
  client.on("confirm.request", ({ id, request }) => {
    approvals.push(request.plugin?.id);
    void client.call("confirm.reply", { id, value: true }).catch(() => undefined);
  });

  const root = path.join(directory, "space");
  await client.call("space.create", { root });
  // Agent 照 Skill 做的第一步：把模板复制进 .agents/plugins/<id>/。模板的 id 原样用。
  await cp(path.join(SKILL, "template"), path.join(root, ".agents", "plugins", "example"), { recursive: true });
  const session = await client.call("session.create", { model: { provider: "fake", id: "scripted" } });
  await client.call("session.send", { sessionId: session.id, text: "做一个记事插件" });

  const history = await client.call("session.history", { sessionId: session.id });
  const results = history.filter((entry) => entry.type === "tool").map((entry) => entry.text);
  assert.equal(results.length, 2);
  assert.match(results[0] ?? "", /插件 example 已生效[^]*example_add/u);
  assert.equal(results[1], "已记下，共 1 条。");
  assert.equal(history.at(-1)?.text, "完成");
  assert.deepEqual(approvals, ["example"]);
  // 加载之前的那次请求没有模板的工具，之后的有。
  assert.equal(seen[0]?.tools.includes("example_add"), false);
  assert.equal(seen[1]?.tools.includes("example_add"), true);
  // 系统提示的 Skill 目录列出它，路径就是包里的 SKILL.md，通用 Agent 能用 read 读到。
  const skillFile = path.join(SKILL, "SKILL.md");
  await access(skillFile);
  assert.ok(seen[0]?.system.includes("<name>plugin-authoring</name>"));
  assert.ok(seen[0]?.system.includes(`<location>${skillFile}</location>`));
  assert.match(await readFile(skillFile, "utf8"), /^---\r?\nname: plugin-authoring\r?\n/u);
});
