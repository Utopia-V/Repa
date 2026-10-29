import { createReadStream } from "node:fs";
import { link, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { RepaFault } from "../schema.js";

// 只处理旧底座创建的 <随机 uuid>.jsonl；Pi 的标准文件名不需要再读头。
const LEGACY_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/u;
const SESSION_ID = /^[A-Za-z0-9_-]+$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

async function readFileName(file: string): Promise<string> {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const header: unknown = JSON.parse(line);
      if (header !== null && typeof header === "object" && "type" in header && header.type === "session"
        && "id" in header && typeof header.id === "string" && SESSION_ID.test(header.id)
        && "timestamp" in header && typeof header.timestamp === "string" && TIMESTAMP.test(header.timestamp)
        && Number.isFinite(Date.parse(header.timestamp))) {
        return `${header.timestamp.replace(/[:.]/gu, "-")}_${header.id}.jsonl`;
      }
      break;
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  } finally {
    lines.close();
    input.destroy();
  }
  throw new RepaFault("invalid_session_header", "旧会话的头部无法读取，文件保持原样", { path: file });
}

export async function migrateSessionFiles(directory: string): Promise<void> {
  for (const file of await readdir(directory)) {
    if (!LEGACY_FILE.test(file)) continue;
    const source = path.join(directory, file);
    const target = path.join(directory, await readFileName(source));
    try {
      // rename 会覆盖已有文件；同目录先建硬链接，只有成功后才移除旧名字。
      await link(source, target);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new RepaFault("session_migration_conflict", "会话改名的目标已存在，两份文件均已保留，请核对后再打开空间", { source, target });
      }
      throw error;
    }
    await unlink(source);
  }
}

export async function findSessionPath(directory: string, id: string): Promise<string | undefined> {
  const file = (await readdir(directory)).find(name => name.endsWith(`_${id}.jsonl`));
  return file === undefined ? undefined : path.join(directory, file);
}
