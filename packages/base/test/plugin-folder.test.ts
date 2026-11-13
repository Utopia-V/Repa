import assert from "node:assert/strict";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { RepaClient, RpcError } from "../src/client.js";
import { startRepaProcess } from "../dist/process.js";

// 插件文件夹的真实路径是构建后的 CLI 在 Node 上导入：类型剥离、解析钩子与 tsx 无关。
// tsx 自己处理 .ts，在本进程里加载插件文件夹验证不了这条路径，所以这里都经子进程。

const MANIFEST = { id: "echo-folder", version: "0.1.0", baseVersion: "^0.1.0", entry: "index.ts" };

const INDEX = `import { Type } from "@repa/base/plugin";
import type { Plugin } from "@repa/base/plugin";
import { echo, fail } from "./tools.ts";

export default {
  id: "echo-folder",
  async open() {
    return {
      tools: () => [echo],
      methods: { fail: { parameters: Type.Object({}), async invoke(): Promise<unknown> { return fail(); } } },
    };
  },
} satisfies Plugin;
`;

const TOOLS = `import { Type, RepaFault } from "@repa/base/plugin";
import type { Tool } from "@repa/base/plugin";

export const echo: Tool = {
  name: "echo_text",
  description: "原样交回文字",
  parameters: Type.Object({ text: Type.String() }),
  async execute(input) {
    const { text } = input as { text: string };
    return { text: \`回声：\${text}\` };
  },
};

export function fail(): never {
  throw new RepaFault("folder_fault", "插件文件夹里抛出的错误", { from: "tools.ts" });
}
`;

async function fixture(t: TestContext) {
  // 临时目录在仓库之外，上面没有 node_modules，也没有 package.json。
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-plugin-folder-")));
  const closers: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    await rm(directory, { recursive: true, force: true });
  });
  const plugin = path.join(directory, "echo-folder");
  await mkdir(path.join(plugin, "page"), { recursive: true });
  await writeFile(path.join(plugin, "repa-plugin.json"), JSON.stringify({
    ...MANIFEST, title: "回声", pages: [{ id: "main", title: "回声", entry: "page/index.html" }],
  }));
  await writeFile(path.join(plugin, "index.ts"), INDEX);
  await writeFile(path.join(plugin, "tools.ts"), TOOLS);
  await writeFile(path.join(plugin, "page", "index.html"), "<!doctype html><title>回声</title>\n");
  /** 复制一份插件文件夹，按 change 改写其中的文件。 */
  const variant = async (name: string, change: Record<string, string>) => {
    const copy = path.join(directory, name);
    await cp(plugin, copy, { recursive: true });
    for (const [file, text] of Object.entries(change)) await writeFile(path.join(copy, file), text);
    return copy;
  };
  return { directory, plugin, variant, closers };
}

// 只回应 openai-completions 的流式请求：对话里还没有工具结果时让模型调用 echo_text，有了就回一句话结束。
function scriptedModel(request: IncomingMessage, response: ServerResponse, body: string): void {
  const messages = (JSON.parse(body) as { messages: { role: string }[] }).messages;
  const delta = messages.some((message) => message.role === "tool")
    ? { role: "assistant", content: "完成" }
    : { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "echo_text", arguments: JSON.stringify({ text: "你好" }) } }] };
  const finish = "content" in delta ? "stop" : "tool_calls";
  const chunk = (choice: object) => `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [choice] })}\n\n`;
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`${chunk({ index: 0, delta, finish_reason: null })}${chunk({ index: 0, delta: {}, finish_reason: finish })}data: [DONE]\n\n`);
  void request;
}

test("不经构建的 .ts 插件文件夹由构建后的 CLI 加载，工具经模型调用后交回结果，RepaFault 的错误码原样交回", async (t) => {
  const f = await fixture(t);
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => scriptedModel(request, response, body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  f.closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  const home = path.join(f.directory, "home");
  await mkdir(path.join(home, "agent"), { recursive: true });
  await writeFile(path.join(home, "agent", "models.json"), JSON.stringify({
    providers: { fake: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "fake", models: [{ id: "scripted" }] } },
  }));
  const backend = await startRepaProcess({ home, plugins: [f.plugin] });
  f.closers.push(() => backend.close());
  const client = await RepaClient.connect(backend.connection);
  f.closers.push(() => client.close());

  await client.call("space.create", { root: path.join(f.directory, "space") });
  assert.deepEqual(await client.call("plugin.list", {}), [{ id: "echo-folder", methods: ["fail"], tools: ["echo_text"] }]);
  await assert.rejects(client.call("plugin.call", { pluginId: "echo-folder", method: "fail", input: {} }), (error: unknown) => {
    assert(error instanceof RpcError);
    assert.deepEqual(error.data, { code: "folder_fault", details: { from: "tools.ts" } });
    return true;
  });
  const session = await client.call("session.create", { model: { provider: "fake", id: "scripted" } });
  await client.call("session.send", { sessionId: session.id, text: "调用回声工具" });
  const history = await client.call("session.history", { sessionId: session.id });
  assert.deepEqual(history.filter((entry) => entry.type === "tool").map((entry) => entry.text), ["回声：你好"]);
  assert.equal(history.at(-1)?.text, "完成");
});

test("插件文件夹导入文件夹之外的东西、用了类型剥离不支持的写法时，启动即报出原因", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "outside.ts"), "export const outside = 1;\n");
  const linked = await f.variant("linked", { "index.ts": `import "./link.ts";\n${INDEX}` });
  await symlink(path.join(f.directory, "outside.ts"), path.join(linked, "link.ts"));
  const cases: [string, Record<string, string>, RegExp][] = [
    ["outside", { "index.ts": `import "../outside.ts";\n${INDEX}` }, /index\.ts 导入了 \.\.\/outside\.ts/u],
    ["package", { "index.ts": `import "typebox";\n${INDEX}` }, /index\.ts 导入了 typebox/u],
    ["base-root", { "index.ts": `import "@repa/base";\n${INDEX}` }, /index\.ts 导入了 @repa\/base：/u],
    ["no-extension", { "index.ts": INDEX.replace("./tools.ts", "./tools") }, /index\.ts 找不到 \.\/tools。导入要写出文件真实的扩展名/u],
    ["js-extension", { "index.ts": INDEX.replace("./tools.ts", "./tools.js") }, /找不到 \.\/tools\.js/u],
    ["enum", { "tools.ts": `${TOOLS}export enum Kind { A }\n` }, /需要转换的 TypeScript 写法[^]*tools\.ts:\d+/u],
  ];
  for (const [name, change, expected] of cases) {
    const folder = await f.variant(name, change);
    await assert.rejects(startRepaProcess({ home: path.join(f.directory, "home"), plugins: [folder] }), expected, name);
  }
  await assert.rejects(startRepaProcess({ home: path.join(f.directory, "home"), plugins: [linked] }), /index\.ts 导入了 \.\/link\.ts/u);
  const installed = path.join(f.directory, "node_modules", "echo-folder");
  await cp(f.plugin, installed, { recursive: true });
  await assert.rejects(startRepaProcess({ home: path.join(f.directory, "home"), plugins: [installed] }), /node_modules 下的插件要以构建后的 JavaScript 为入口/u);
});

test("插件文件夹里的模块按 ES 模块解释，不受其中 package.json 的 type 影响；Node 内置模块可以导入", async (t) => {
  const f = await fixture(t);
  // 根目录有 package.json 的文件夹属于 npm 包，照常解析；子目录里的 package.json 只改变 Node 对那一层文件的解释。
  const folder = await f.variant("commonjs-inside", {
    "index.ts": `import { join } from "node:path";\nimport os from "os";\nimport { sum } from "./lib/sum.ts";\nvoid join(os.tmpdir(), String(sum(1, 2)));\n${INDEX}`,
  });
  await mkdir(path.join(folder, "lib"));
  await writeFile(path.join(folder, "lib", "package.json"), JSON.stringify({ type: "commonjs" }));
  await writeFile(path.join(folder, "lib", "sum.ts"), "export const sum = (a: number, b: number): number => a + b;\n");
  const backend = await startRepaProcess({ home: path.join(f.directory, "home"), plugins: [folder] });
  f.closers.push(() => backend.close());
  const client = await RepaClient.connect(backend.connection);
  f.closers.push(() => client.close());
  await client.call("space.create", { root: path.join(f.directory, "space") });
  assert.deepEqual((await client.call("plugin.list", {})).map((plugin) => plugin.id), ["echo-folder"]);
});
