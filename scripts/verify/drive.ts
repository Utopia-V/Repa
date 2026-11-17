/**
 * 给保持运行的走查发一条操作，打印结果：npm run verify:drive -- <操作> [参数…]。
 * 走查用 --until 或 --keep 启动后在 .scratch/verify/current.json 记下控制端口，这里读它。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { REPO } from "./app.js";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stdout.write("用法：npm run verify:drive -- <操作> [参数…]，操作见 .agents/skills/verify/SKILL.md。\n");
  process.exit(2);
}
let current: { port: number };
try {
  current = JSON.parse(await readFile(path.join(REPO, ".scratch", "verify", "current.json"), "utf8")) as { port: number };
} catch {
  process.stderr.write("没有保持运行的走查：先运行 npm run verify -- --until <步骤> 或 --keep。\n");
  process.exit(2);
}
let response: Response;
try {
  response = await fetch(`http://127.0.0.1:${current.port}/`, { method: "POST", body: JSON.stringify({ command, args }) });
} catch {
  process.stderr.write("连不上保持运行的走查，它可能已经结束了。\n");
  process.exit(2);
}
const text = await response.text();
(response.ok ? process.stdout : process.stderr).write(`${text}\n`);
process.exitCode = response.ok ? 0 : 1;
