// 浏览器边界：@repa/base/client 及它经相对路径引入的全部模块必须能在浏览器里运行。
// 逐层沿相对导入走，报出引入 Node 内置模块、Pi 或后端存储依赖的文件和行号，并写明改法。
// 规则来由见 .agents/notes/proposed/process/2026-11-06-mechanical-checks.md。
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRIES = ["packages/base/src/client.ts"];
// 浏览器里可用的外部包；其余外部依赖要先核对能否在浏览器运行，再加到这里并写明理由。
const ALLOWED = new Set(["typebox", "typebox/value", "typebox/compile"]);
const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gu;

const REMEDY = "@repa/base/client 及其依赖要能在浏览器里运行：改用标准 WebSocket／Fetch 与 typebox，把 Node、Pi 或存储相关的代码留在后端模块里，不要经 client 的依赖链引入（.agents/skills/repa-code-style/SKILL.md 的“模块与副作用”）。";

async function main(): Promise<void> {
  const seen = new Set<string>();
  const problems: string[] = [];
  const queue = ENTRIES.map((entry) => path.join(ROOT, entry));
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(IMPORT)) {
      const target = match[1] ?? match[2] ?? match[3];
      // 整句 import type／export type 编译后会被擦掉，不进入浏览器。
      if (target === undefined || /^\s*(?:import|export)\s+type\b/u.test(match[0])) continue;
      if (target.startsWith(".")) {
        queue.push(path.resolve(path.dirname(file), target.replace(/\.js$/u, ".ts")));
      } else if (!ALLOWED.has(target)) {
        const line = text.slice(0, match.index + match[0].length).split("\n").length;
        problems.push(`${path.relative(ROOT, file)}:${line} imports ${target}`);
      }
    }
  }
  if (problems.length > 0) {
    console.error(REMEDY);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`浏览器边界检查通过：${seen.size} 个模块`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
