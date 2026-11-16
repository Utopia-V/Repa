// 测试用的 stdio MCP 服务器：逐行 JSON-RPC，不依赖任何包。
// 每收到一个请求或通知，向 MCP_LOG 追加一行，测试据此数进程和请求。环境变量控制故障：
// MCP_HANG_INIT=1 不回答 initialize；MCP_IGNORE_EOF=1 stdin 结束后不退出；
// MCP_GRANDCHILD=1 再起一个孙进程（模拟 npx 之类的包装）；MCP_EXTRA_TOOLS=n 再声明 n 个工具；
// MCP_LONG_DESCRIPTION=n 让 echo 的说明长 n 个字符。MCP_SECRET 模拟配置里交给服务器的令牌。
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const log = (line) => {
  if (process.env.MCP_LOG) appendFileSync(process.env.MCP_LOG, `${line}\n`);
};
log(`start ${process.pid}`);
if (process.env.MCP_GRANDCHILD === "1") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  log(`grandchild ${child.pid}`);
}

const echo = {
  name: "echo",
  description: process.env.MCP_LONG_DESCRIPTION ? "e".repeat(Number(process.env.MCP_LONG_DESCRIPTION)) : "Return the text unchanged.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  annotations: { readOnlyHint: true },
};
const tools = [
  echo,
  { name: "slow", description: "Answer after ms milliseconds.", inputSchema: { type: "object", properties: { ms: { type: "number" } } } },
  { name: "add_tool", description: "Declare one more tool and tell the client.", inputSchema: { type: "object", properties: {} } },
  { name: "crash", description: "Exit the server process.", inputSchema: { type: "object", properties: {} } },
  { name: "big", description: "Return bytes bytes of text.", inputSchema: { type: "object", properties: { bytes: { type: "number" } } } },
  { name: "secret", description: "Return the value of MCP_SECRET.", inputSchema: { type: "object", properties: {} } },
];
for (let index = 0; index < Number(process.env.MCP_EXTRA_TOOLS ?? 0); index += 1) {
  tools.push({ name: `extra_${index}`, description: "Extra tool.", inputSchema: { type: "object", properties: {} } });
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
const text = (id, value) => result(id, { content: [{ type: "text", text: value }] });
const slowCalls = new Map();

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const { id, method, params } = JSON.parse(line);
  log(`${method}${method === "tools/call" ? ` ${params.name} ${JSON.stringify(params.arguments ?? {})}` : ""}`);
  if (method === "initialize") {
    if (process.env.MCP_HANG_INIT === "1") return;
    result(id, {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "test", version: "0.0.1" },
    });
    return;
  }
  if (method === "notifications/cancelled") {
    clearTimeout(slowCalls.get(params.requestId));
    return;
  }
  if (method === "tools/list") return result(id, { tools });
  if (method === "ping") return result(id, {});
  if (method !== "tools/call") {
    if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
    return;
  }
  const args = params.arguments ?? {};
  if (params.name === "echo") return text(id, `echo: ${args.text}`);
  if (params.name === "slow") {
    slowCalls.set(id, setTimeout(() => text(id, "slow done"), args.ms ?? 60_000));
    return;
  }
  if (params.name === "add_tool") {
    tools.push({ name: `added_${tools.length}`, description: "Added later.", inputSchema: { type: "object", properties: {} } });
    text(id, "added");
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    return;
  }
  if (params.name === "crash") {
    process.stderr.write(`fatal: lost ${process.env.MCP_SECRET ?? ""}\n`);
    process.exit(3);
  }
  if (params.name === "secret") return text(id, `secret: ${process.env.MCP_SECRET ?? ""}`);
  if (params.name === "big") return text(id, "x".repeat(args.bytes ?? 100_000));
  send({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown tool" } });
});
lines.on("close", () => {
  log(`stdin-eof ${process.pid}`);
  if (process.env.MCP_IGNORE_EOF !== "1") process.exit(0);
});
