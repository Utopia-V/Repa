import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TSchema } from "typebox";

import type { Issue } from "./context.js";
import { document, loadModule, ROOT, runGenerator } from "./generation.js";
import { schemaTable } from "./schema-table.js";

export interface PersistentFormat {
  id: string;
  files: string[];
  owner: string;
  schema: string;
  versionedBy: string;
}
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
  }
  return value;
}
export function digest(schema: TSchema): string {
  return createHash("sha256").update(JSON.stringify(canonical(schema))).digest("hex").slice(0, 16);
}
export async function persistentSchemas(root: string) {
  const entries = JSON.parse(await readFile(path.join(root, "scripts/docs/persistence.json"), "utf8")) as PersistentFormat[];
  const ids = new Set<string>();
  return Promise.all(entries.map(async (entry) => {
    if (!entry.id || ids.has(entry.id) || !entry.owner || !entry.files.length || !entry.versionedBy) throw new Error("持久格式清单条目无效或 id 重复");
    ids.add(entry.id);
    const [file, name] = entry.schema.split("#");
    if (!file || !name) throw new Error(`schema 引用无效：${entry.schema}`);
    const schema = (await loadModule(root, file))[name];
    if (!schema || typeof schema !== "object") throw new Error(`找不到持久 schema：${entry.schema}`);
    return { ...entry, schema: schema as TSchema, reference: entry.schema, digest: digest(schema as TSchema) };
  }));
}
function changeMessage(id: string, hash: string): string {
  return `${id} 的 schema 变了。在 docs/persistence/changes/ 下写一份 YYYY-MM-DD-<主题>.md，第一行写 \`${id} ${hash}\`，第二行写“不升版本”或“升版本”并说明理由，然后运行 npm run docs:gen。`;
}
async function readDigests(root: string): Promise<Record<string, string> | undefined> {
  try {
    return JSON.parse(await readFile(path.join(root, "docs/persistence/digests.json"), "utf8")) as Record<string, string>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
export function changeRecord(text: string): { id: string; digest: string } | undefined {
  const [first = "", second = ""] = text.split(/\r?\n/);
  const match = /^(\S+) ([a-f0-9]{16})$/.exec(first);
  if (!match?.[1] || !match[2] || !/^(?:不升版本|升版本)(?:[：:，,。；;\s])+\S.*/u.test(second)) return undefined;
  return { id: match[1], digest: match[2] };
}
async function hasRecord(root: string, id: string, hash: string): Promise<boolean> {
  const directory = path.join(root, "docs/persistence/changes");
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  for (const file of files.filter((file) => /^\d{4}-\d{2}-\d{2}-.+\.md$/.test(file))) {
    const record = changeRecord(await readFile(path.join(directory, file), "utf8"));
    if (record?.id === id && record.digest === hash) return true;
  }
  return false;
}
export async function checkPersistence(root = ROOT): Promise<Issue[]> {
  const schemas = await persistentSchemas(root);
  const accepted = await readDigests(root);
  return schemas.filter((entry) => accepted?.[entry.id] !== entry.digest).map((entry) => ({
    file: "docs/persistence/digests.json", line: 1, check: "持久格式", message: changeMessage(entry.id, entry.digest),
  }));
}
export async function generatePersistence(root = ROOT, approve = false) {
  const schemas = await persistentSchemas(root);
  if (approve) {
    const accepted = await readDigests(root);
    // 先核对全部变更，避免其中一项缺记录时只更新了一部分摘要。
    if (accepted) {
      for (const entry of schemas) {
        if (accepted[entry.id] !== entry.digest && !await hasRecord(root, entry.id, entry.digest)) throw new Error(changeMessage(entry.id, entry.digest));
      }
    }
    await mkdir(path.join(root, "docs/persistence"), { recursive: true });
    await writeFile(path.join(root, "docs/persistence/digests.json"), `${JSON.stringify(Object.fromEntries(schemas.map((entry) => [entry.id, entry.digest])), null, 2)}\n`);
  }
  return document("persistence", "docs/generated/persistence.md", "持久格式", schemas.map((entry) =>
    `## ${entry.id}\n\n文件：${entry.files.join("、")}。\n\n负责的包：${entry.owner}。\n\n版本标记：${entry.versionedBy}。\n\nschema：${entry.reference}；SHA-256 前 16 位：${entry.digest}。\n\n${schemaTable(entry.schema)}`).join("\n\n"), schemas.length);
}
runGenerator(import.meta.url, () => generatePersistence(ROOT, true));
