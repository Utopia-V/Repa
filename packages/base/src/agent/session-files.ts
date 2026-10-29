import { createReadStream } from "node:fs";
import { link, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

// 只处理旧底座创建的 <随机 uuid>.jsonl；Pi 的标准文件名不需要再读头。
const LEGACY_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/u;
const SESSION_ID = /^[A-Za-z0-9_-]+$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** 按会话头算出 Pi 的文件名；头部读不出或不合规时返回 undefined。 */
async function readFileName(file: string): Promise<string | undefined> {
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
  return undefined;
}

/** 两个名字指向同一个文件（上次改名在建链之后中断），或者内容逐字相同。 */
async function sameFile(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([stat(a), stat(b)]);
  if (left.dev === right.dev && left.ino === right.ino) return true;
  return left.size === right.size && (await readFile(a)).equals(await readFile(b));
}

export async function migrateSessionFiles(
  directory: string,
  warn: (message: string) => void = message => process.stderr.write(`${message}\n`),
): Promise<void> {
  for (const file of await readdir(directory)) {
    if (!LEGACY_FILE.test(file)) continue;
    const source = path.join(directory, file);
    const name = await readFileName(source);
    // 头部读不出的旧文件原样留着，和以前查找时一样跳过它；一份坏文件不该让整个空间打不开。
    if (name === undefined) continue;
    const target = path.join(directory, name);
    try {
      // rename 会覆盖已有文件；同目录先建硬链接，只有成功后才移除旧名字。
      await link(source, target);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      // 目标已存在：是同一份内容，就补完上次中断的改名；内容不同，两份都留着，按编号打开的是新名字那份，并提示用户核对。
      if (!await sameFile(source, target)) {
        warn(`旧会话 ${source} 改名时，目标 ${target} 已存在且内容不同；两份都已保留，按编号打开的是 ${target}，请核对后删掉多余的一份。`);
        continue;
      }
    }
    await unlink(source);
  }
}

export async function findSessionPath(directory: string, id: string): Promise<string | undefined> {
  const file = (await readdir(directory)).find(name => name.endsWith(`_${id}.jsonl`));
  return file === undefined ? undefined : path.join(directory, file);
}
