// 界面文字只放在 apps/web/src/strings/zh-CN.ts：组件里不写字面量，新键的值由人书写。
// 含中文的字符串、JSX 文字和给人看的属性都会报出；纯英文常量识别不出来，靠审查。
// 带 --no-placeholders 时，还有占位就失败，用于打包前。规则来由见 .agents/notes/implemented/architecture/2026-11-06-ui-strings-and-components.md。
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = path.join(ROOT, "apps/web/src");
const STRINGS = path.join(SOURCE, "strings/zh-CN.ts");
const PLACEHOLDER = "〔待写〕";
const HAN = /\p{Script=Han}/u;
const LETTER = /\p{L}/u;
// 这些属性的值是给人看的，英文也算界面文字。
const UI_ATTRIBUTES = new Set(["title", "aria-label", "placeholder", "alt", "label"]);
const IGNORE = /ui-text: ignore \S/u;

const REMEDY = "界面文字放进 apps/web/src/strings/zh-CN.ts，组件用 t(键) 引用；Agent 新增键时值写〔待写〕。开发用标记在上一行写 // ui-text: ignore 原因。";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return full === path.dirname(STRINGS) ? [] : sourceFiles(full);
    return /\.tsx?$/u.test(entry.name) ? [full] : [];
  }));
  return files.flat();
}

function literalText(node: ts.Node): string | undefined {
  if (ts.isJsxText(node)) return LETTER.test(node.text) ? node.text.trim() : undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    const parent = node.parent;
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return undefined;
    const uiAttribute = ts.isJsxAttribute(parent) && UI_ATTRIBUTES.has(parent.name.getText());
    return HAN.test(node.text) || (uiAttribute && LETTER.test(node.text)) ? node.text : undefined;
  }
  if (ts.isTemplateExpression(node)) {
    const parts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
    return parts.some((part) => HAN.test(part)) ? node.getText() : undefined;
  }
  return undefined;
}

async function literals(file: string): Promise<string[]> {
  const text = await readFile(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = text.split("\n");
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const literal = literalText(node);
    if (literal !== undefined) {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line;
      if (!IGNORE.test(lines[line] ?? "") && !IGNORE.test(lines[line - 1] ?? "")) {
        found.push(`${path.relative(ROOT, file)}:${line + 1} ${literal.replace(/\s+/gu, " ").slice(0, 60)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

async function placeholders(): Promise<string[]> {
  const text = await readFile(STRINGS, "utf8");
  return [...text.matchAll(new RegExp(`"([^"]+)":\\s*"${PLACEHOLDER}"`, "gu"))].flatMap((match) => match[1] ?? []);
}

async function main(): Promise<void> {
  const problems = (await Promise.all((await sourceFiles(SOURCE)).map(literals))).flat();
  if (problems.length > 0) {
    console.error(REMEDY);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exitCode = 1;
  }
  const waiting = await placeholders();
  if (waiting.length > 0) {
    const report = process.argv.includes("--no-placeholders") ? console.error : console.log;
    report(`还有 ${waiting.length} 个键待人书写：`);
    for (const key of waiting) report(`  ${key}`);
    if (process.argv.includes("--no-placeholders")) process.exitCode = 1;
  }
  if (process.exitCode === undefined) console.log("界面文字检查通过");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
