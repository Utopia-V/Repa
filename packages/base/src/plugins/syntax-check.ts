import { Worker } from "node:worker_threads";

import type { RepaFault } from "../schema.js";
import { importFault } from "./manifest.js";

// 在 worker 里运行的检查。从入口出发，逐个读文件夹里被静态导入的 .js、.mjs、.ts 模块：.ts 先用 Node 导入时同样的办法剥离类型，
// 再用 vm.SourceTextModule 按 ES 模块编译。只编译，不链接、不求值，插件的代码一行也不执行。
// 编译或剥离类型报出的 SyntaxError 带上文件名重新抛出，作为 worker 的未捕获错误交回：编译的错误这时由 Node 在 stack 开头写上文件、
// 行号与出错处，与导入时的错误一样；剥离类型的错误本来就写好了，再抛出时 Node 会在前面加上这里的抛出位置，所以先另存一份。其余任何问题（读不到文件、这个 Node 没有所需的接口）也以错误结束，但不带文件名，宿主据此跳过检查。
// 包名、Node 内置模块、文件夹之外的路径、找不到的文件和别的扩展名都不跟进，导入时照常报告。动态 import() 不在静态导入之列。
const CHECK = `
const { workerData } = require("node:worker_threads");
const { readFileSync, statSync } = require("node:fs");
const { stripTypeScriptTypes } = require("node:module");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { SourceTextModule } = require("node:vm");
const { root, entry } = workerData;
const queue = [entry];
const seen = new Set(queue);
while (queue.length > 0) {
  const file = queue.shift();
  const url = pathToFileURL(file).href;
  const text = readFileSync(file, "utf8");
  let module;
  try {
    const source = file.endsWith(".ts") ? stripTypeScriptTypes(text, { mode: "strip", sourceUrl: url }) : text;
    module = new SourceTextModule(source, { identifier: url });
  } catch (error) {
    if (error instanceof SyntaxError) {
      error.pluginFile = file;
      if (error.stack.startsWith(url)) error.located = error.stack;
    }
    throw error;
  }
  const specifiers = module.moduleRequests ? module.moduleRequests.map((request) => request.specifier) : module.dependencySpecifiers;
  for (const specifier of specifiers) {
    if (!/^(?:\\.{1,2}\\/|\\/|file:)/.test(specifier)) continue;
    let target;
    try {
      target = fileURLToPath(new URL(specifier, url));
    } catch {
      continue;
    }
    const inside = path.relative(root, target);
    if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) continue;
    if (![".js", ".mjs", ".ts"].includes(path.extname(target)) || seen.has(target)) continue;
    if (!statSync(target, { throwIfNoEntry: false })?.isFile()) continue;
    seen.add(target);
    queue.push(target);
  }
}
`;

/**
 * 不执行插件代码，查插件入口和它静态导入的文件夹内模块有没有语法错误，批准之前用。查到时返回与导入时相同的错误，写明文件、位置与原因；
 * 没有语法错误或检查本身没能做完时返回 undefined，照常请求批准，导入时 Node 仍会查一遍。root 与 entry 是真实路径。
 *
 * 检查放在 worker 里：vm.SourceTextModule 要 --experimental-vm-modules，这个选项只给 worker，不改宿主进程；
 * worker 的输出不转给宿主，Node 对实验性接口的提示不出现在宿主的日志里。
 */
export function checkSyntax(id: string, root: string, entry: string): Promise<RepaFault | undefined> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(CHECK, { eval: true, workerData: { root, entry }, execArgv: ["--experimental-vm-modules"], stdout: true, stderr: true });
    } catch {
      resolve(undefined);
      return;
    }
    worker.stdout.resume();
    worker.stderr.resume();
    let found: RepaFault | undefined;
    worker.on("error", (error: unknown) => {
      if (!(error instanceof Error) || !("pluginFile" in error) || typeof error.pluginFile !== "string") return;
      found = importFault(id, root, error, "located" in error && typeof error.located === "string" ? { stack: error.located } : {});
    });
    worker.on("exit", () => { resolve(found); });
  });
}
