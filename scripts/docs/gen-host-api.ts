import { readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

import { documentation } from "./compiler.js";
import { cell, document, ROOT, runGenerator } from "./generation.js";

export async function generateHostApi(root = ROOT) {
  const file = "packages/base/src/plugin.ts";
  const source = ts.createSourceFile(file, await readFile(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
  const names = ["Host", "Plugin", "PluginInstance", "AgentDefinition"];
  let count = 0;
  const sections = names.map((name) => {
    const node = source.statements.find((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === name);
    if (!node) throw new Error(`缺少插件接口：${name}`);
    count += node.members.length;
    const rows = node.members.map((member) => `| ${cell(member.name?.getText(source) ?? "")} | ${cell(member.getText(source))} | ${cell(documentation(member))} |`);
    return `## ${name}\n\n${documentation(node)}\n\n| 成员 | 声明 | 说明 |\n| --- | --- | --- |\n${rows.join("\n")}`;
  });
  return document("host-api", "docs/generated/host-api.md", "插件接口", sections.join("\n\n"), count);
}
runGenerator(import.meta.url, () => generateHostApi());
