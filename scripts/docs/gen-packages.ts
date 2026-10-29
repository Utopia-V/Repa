import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { fromMarkdown } from "mdast-util-from-markdown";

import { plainText } from "./context.js";
import { cell, document, ROOT, runGenerator } from "./generation.js";

export async function generatePackages(root = ROOT) {
  const exceptions = JSON.parse(await readFile(path.join(root, "scripts/docs/exceptions.json"), "utf8")) as Record<string, Record<string, string>>;
  const rows = ["| 包名 | 目录 | 概述 |", "| --- | --- | --- |"];
  const packages = (await readdir(path.join(root, "packages"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const entry of packages) {
    const directory = `packages/${entry.name}`;
    const manifest = JSON.parse(await readFile(path.join(root, directory, "package.json"), "utf8")) as { name: string };
    const nodes = fromMarkdown(await readFile(path.join(root, directory, "README.md"), "utf8")).children;
    const legacy = exceptions["包 README 骨架"]?.[`${directory}/README.md`];
    const heading = nodes.findIndex((node) => node.type === "heading" && (legacy ? node.depth === 1 : node.depth === 2 && plainText(node) === "概述"));
    if (heading < 0) throw new Error(`${directory}/README.md 缺少概述标题`);
    const paragraph = nodes[heading + 1];
    if (paragraph?.type !== "paragraph") throw new Error(`${directory}/README.md 标题下缺少第一段`);
    const sentence = plainText(paragraph).match(/^.*?(?:[。！？]|\.(?=\s|$)|$)/u)?.[0] ?? "";
    rows.push(`| ${cell(manifest.name)} | [${entry.name}](./${entry.name}/README.md) | ${cell(sentence)} |`);
  }
  return document("packages", "packages/README.md", "包地图", rows.join("\n"), packages.length);
}
runGenerator(import.meta.url, () => generatePackages());
