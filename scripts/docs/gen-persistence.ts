import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
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

interface AcceptedDigest {
  digest: string;
  basis: string;
}

// 只认可这批格式各自首次入库时的摘要；后续格式和变更都必须提供记录。
const BASELINE_DIGESTS: Readonly<Record<string, string>> = {
  "space-format": "557283bfb3e5b4a7",
  "session-parent": "3d399c4db9c7ad1a",
  "history-source": "4fd83ee1e6b7ba61",
  "app-settings": "c3263cf294fcf89f",
  "learning-format": "557283bfb3e5b4a7",
  "learning-records": "59e4f9eda6457388",
};
const DIGESTS_FILE = "docs/persistence/digests.json";
const RECORD_FILENAME = /^\d{4}-\d{2}-\d{2}-[^/\\]+\.md$/;

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
async function readDigests(root: string): Promise<Record<string, AcceptedDigest>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path.join(root, DIGESTS_FILE), "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`从 git 恢复 ${DIGESTS_FILE}`);
    }
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${DIGESTS_FILE} 应为对象`);
  return Object.fromEntries(Object.entries(value).map(([id, entry]: [string, unknown]) => {
    if (!entry || typeof entry !== "object" || !("digest" in entry) || !("basis" in entry)
      || typeof entry.digest !== "string" || !/^[a-f0-9]{16}$/.test(entry.digest)
      || typeof entry.basis !== "string" || (entry.basis !== "baseline" && !RECORD_FILENAME.test(entry.basis))) {
      throw new Error(`${DIGESTS_FILE} 的 ${id} 须包含摘要和有效依据（baseline 或变更记录文件名）`);
    }
    return [id, { digest: entry.digest, basis: entry.basis }];
  }));
}
export function changeRecord(text: string): { id: string; digest: string } | undefined {
  const [first = "", second = ""] = text.split(/\r?\n/);
  const match = /^(\S+) ([a-f0-9]{16})$/.exec(first);
  if (!match?.[1] || !match[2] || !/^(?:不升版本|升版本)(?:[：:，,。；;\s])+\S.*/u.test(second)) return undefined;
  return { id: match[1], digest: match[2] };
}
async function readRecord(root: string, file: string): Promise<ReturnType<typeof changeRecord>> {
  try {
    return changeRecord(await readFile(path.join(root, "docs/persistence/changes", file), "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
async function findRecord(root: string, id: string, hash: string): Promise<string | undefined> {
  const directory = path.join(root, "docs/persistence/changes");
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  for (const file of files.filter((file) => RECORD_FILENAME.test(file)).sort()) {
    const record = await readRecord(root, file);
    if (record?.id === id && record.digest === hash) return file;
  }
  return undefined;
}
async function checkBasis(root: string, accepted: Record<string, AcceptedDigest>): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const [id, entry] of Object.entries(accepted)) {
    let message: string;
    if (entry.basis === "baseline") {
      if (Object.hasOwn(BASELINE_DIGESTS, id) && BASELINE_DIGESTS[id] === entry.digest) continue;
      message = `${id} 的 baseline 须与该格式首次入库的摘要相同；新格式或摘要变更须提供变更记录。`;
    } else {
      const record = await readRecord(root, entry.basis);
      if (record?.id === id && record.digest === entry.digest) continue;
      message = `${id} 的依据 docs/persistence/changes/${entry.basis} 不存在或无效；第一行须为 \`${id} ${entry.digest}\`，第二行须说明版本判断及理由。`;
    }
    issues.push({ file: DIGESTS_FILE, line: 1, check: "持久格式", message });
  }
  return issues;
}
export async function checkPersistence(root = ROOT): Promise<Issue[]> {
  const schemas = await persistentSchemas(root);
  const accepted = await readDigests(root);
  return [
    ...await checkBasis(root, accepted),
    ...schemas.filter((entry) => accepted[entry.id]?.digest !== entry.digest).map((entry) => ({
      file: DIGESTS_FILE, line: 1, check: "持久格式", message: changeMessage(entry.id, entry.digest),
    })),
  ];
}
export async function generatePersistence(root = ROOT, approve = false) {
  const schemas = await persistentSchemas(root);
  const accepted = await readDigests(root);
  if (approve) {
    const issues = await checkBasis(root, accepted);
    if (issues.length) throw new Error(issues.map((issue) => issue.message).join("\n"));
    // 先核对全部变更，避免其中一项缺记录时只更新了一部分摘要。
    const next: Record<string, AcceptedDigest> = {};
    for (const entry of schemas) {
      const previous = accepted[entry.id];
      if (previous?.digest === entry.digest) {
        next[entry.id] = previous;
        continue;
      }
      const basis = await findRecord(root, entry.id, entry.digest);
      if (!basis) throw new Error(changeMessage(entry.id, entry.digest));
      next[entry.id] = { digest: entry.digest, basis };
    }
    await writeFile(path.join(root, DIGESTS_FILE), `${JSON.stringify(next, null, 2)}\n`);
  }
  return document("persistence", "docs/generated/persistence.md", "持久格式", schemas.map((entry) =>
    `## ${entry.id}\n\n文件：${entry.files.join("、")}。\n\n负责的包：${entry.owner}。\n\n版本标记：${entry.versionedBy}。\n\nschema：${entry.reference}；SHA-256 前 16 位：${entry.digest}。\n\n${schemaTable(entry.schema)}`).join("\n\n"), schemas.length);
}
runGenerator(import.meta.url, () => generatePersistence(ROOT, true));
