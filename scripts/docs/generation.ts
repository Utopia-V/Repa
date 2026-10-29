import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Issue } from "./context.js";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export interface GeneratedFile {
  file: string;
  text: string;
  count: number;
}
export function document(name: string, file: string, title: string, body: string, count: number): GeneratedFile {
  return { file, text: `<!-- 由 scripts/docs/gen-${name}.ts 生成，不要手改。 -->\n\n# ${title}\n\n${body.trim()}\n`, count };
}
export function cell(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\|/g, "&#124;").replace(/\r?\n/g, "<br>");
}
// 目录要能被编码 Agent 整篇读完，按 UTF-8 字节计上限。
const MAX_BYTES = 40 * 1024;
function oversize(output: GeneratedFile): string | undefined {
  const bytes = Buffer.byteLength(output.text);
  if (bytes <= MAX_BYTES) return undefined;
  return `生成后 ${Math.ceil(bytes / 1024)} KB，超过 ${MAX_BYTES / 1024} KB 上限：目录要能被整篇读完，改为更紧凑的写法`;
}
export async function writeGenerated(root: string, output: GeneratedFile): Promise<void> {
  const problem = oversize(output);
  if (problem) throw new Error(`${output.file} ${problem}`);
  await mkdir(path.dirname(path.join(root, output.file)), { recursive: true });
  await writeFile(path.join(root, output.file), output.text);
  console.log(`${output.file}：${output.count} 条目`);
}
export async function checkGenerated(root: string, outputs: GeneratedFile[]): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const output of outputs) {
    const problem = oversize(output);
    if (problem) {
      issues.push({ file: output.file, line: 1, check: "生成目录", message: problem });
      continue;
    }
    let actual: Buffer | undefined;
    try {
      actual = await readFile(path.join(root, output.file));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    if (!actual?.equals(Buffer.from(output.text))) {
      issues.push({ file: output.file, line: 1, check: "生成目录", message: "目录过时，运行 npm run docs:gen" });
    }
  }
  return issues;
}
export async function loadModule(root: string, file: string): Promise<Record<string, unknown>> {
  return import(pathToFileURL(path.resolve(root, file)).href) as Promise<Record<string, unknown>>;
}
export function runGenerator(url: string, generate: () => Promise<GeneratedFile>): void {
  if (!process.argv[1] || path.resolve(process.argv[1]) !== fileURLToPath(url)) return;
  generate().then((output) => writeGenerated(ROOT, output)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
