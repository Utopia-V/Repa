// 浏览器边界：@repa/base/client 与页面引用的各包入口，以及它们引入的全部模块，必须能在浏览器里运行。
// 入口取 apps/web/src 实际引用的 @repa/* 子路径；沿相对导入和这些包之间的引用逐层走，
// 报出引入 Node 内置模块、Pi 或后端存储依赖的文件和行号，并写明改法。
// 规则来由见 .agents/notes/proposed/process/2026-11-06-mechanical-checks.md。
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WEB = path.join(ROOT, "apps/web/src");
const ENTRIES = ["@repa/base/client"];
// 浏览器里可用的外部包；其余外部依赖要先核对能否在浏览器运行，再加到这里并写明理由。
const ALLOWED = new Set(["typebox", "typebox/value", "typebox/compile"]);
const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gu;

const REMEDY = "@repa/base/client 与页面引用的包入口（如 @repa/learning/protocol、@repa/python-runner/browser）及其依赖要能在浏览器里运行：改用标准 WebSocket／Fetch 与 typebox，把 Node、Pi 或存储相关的代码留在后端模块里，不要经这些入口的依赖链引入；页面只引用各包给浏览器的入口（.agents/skills/repa-code-style/SKILL.md 的“模块与副作用”）。";

interface Found { target: string; line: number }

function imports(text: string): Found[] {
  const found: Found[] = [];
  for (const match of text.matchAll(IMPORT)) {
    const target = match[1] ?? match[2] ?? match[3];
    // 整句 import type／export type 编译后会被擦掉，不进入浏览器。
    if (target === undefined || /^\s*(?:import|export)\s+type\b/u.test(match[0])) continue;
    found.push({ target, line: text.slice(0, match.index + match[0].length).split("\n").length });
  }
  return found;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

// 工作区包的子路径按 package.json 的 exports 找到源码：dist/X.js 对应 src/X.ts。
// 不是脚本的导出（如作为文本引入的 runner.py）记为 null，不往下走。
async function workspaceExports(): Promise<Map<string, string | null>> {
  const resolved = new Map<string, string | null>();
  for (const entry of await readdir(path.join(ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(ROOT, "packages", entry.name);
    const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as {
      name: string;
      exports?: Record<string, string | { import?: string }>;
    };
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      const specifier = subpath === "." ? manifest.name : `${manifest.name}${subpath.slice(1)}`;
      const file = typeof target === "string" ? target : target.import;
      const source = file?.match(/^\.\/dist\/(.+)\.js$/u)?.[1];
      resolved.set(specifier, source === undefined ? null : path.join(directory, "src", `${source}.ts`));
    }
  }
  return resolved;
}

async function main(): Promise<void> {
  const exports = await workspaceExports();
  const entries = new Set(ENTRIES);
  for (const file of await sourceFiles(WEB)) {
    for (const { target } of imports(await readFile(file, "utf8"))) {
      // Vite 的 ?raw 等查询把文件当文本引入，按去掉查询后的导出判断。
      if (target.startsWith("@repa/")) entries.add(target.replace(/\?.*$/u, ""));
    }
  }
  const seen = new Set<string>();
  const problems: string[] = [];
  const queue: string[] = [];
  for (const entry of entries) {
    const source = exports.get(entry);
    if (source === undefined) problems.push(`apps/web/src imports ${entry}, which no workspace package exports`);
    else if (source !== null) queue.push(source);
  }
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    for (const { target, line } of imports(await readFile(file, "utf8"))) {
      if (target.startsWith(".")) {
        queue.push(path.resolve(path.dirname(file), target.replace(/\.js$/u, ".ts")));
        continue;
      }
      // 工作区包之间的引用顺着走下去：引的若是后端入口，它里面的 Node 依赖会在那个文件处报出。
      const source = exports.get(target);
      if (typeof source === "string") queue.push(source);
      else if (source === undefined && !ALLOWED.has(target)) problems.push(`${path.relative(ROOT, file)}:${line} imports ${target}`);
    }
  }
  if (problems.length > 0) {
    console.error(REMEDY);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`浏览器边界检查通过：${entries.size} 个入口，${seen.size} 个模块`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
