import { randomUUID } from "node:crypto";
import { link, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

// 反馈包与导出共用的发布：在内存中生成的 zip 先写同目录的临时文件，再放到不与已有文件重名的最终文件名。

const PackageSchema = Type.Object({ version: Type.String() });

/** 底座包的版本，反馈包和导出都记下它。 */
export async function repaVersion(): Promise<string> {
  // src/feedback 与构建后的 dist/feedback 到包根目录的距离相同。
  const text = await readFile(new URL("../../package.json", import.meta.url), "utf8");
  const parsed: unknown = JSON.parse(text);
  if (!Value.Check(PackageSchema, parsed)) throw new Error("package.json 没有 version");
  return parsed.version;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 本地时间，不带冒号：Windows 的文件名不能含冒号。 */
export function stamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** 把写完的临时文件放到最终文件名；最终文件名已存在时返回 false，不覆盖。 */
async function place(temporary: string, file: string): Promise<boolean> {
  try {
    // 硬链接不会覆盖已有文件，同一秒生成的两个包也不会互相顶掉。
    await link(temporary, file);
    return true;
  } catch (error) {
    if (isCode(error, "EEXIST")) return false;
    // exFAT 等文件系统不支持硬链接，退回先查再改名。
    if (!isCode(error, "EPERM") && !isCode(error, "ENOTSUP") && !isCode(error, "EOPNOTSUPP")) throw error;
  }
  try {
    await stat(file);
    return false;
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
  await rename(temporary, file);
  return true;
}

/**
 * 先写同目录的临时文件，写完再放到最终文件名 base.zip，重名时依次试 base-2.zip 到 base-100.zip；
 * 写到一半失败（例如磁盘满）时不会留下残缺的 zip。一百个文件名都被占用时返回 undefined，由调用方报错。
 */
export async function writeUnique(directory: string, base: string, data: Buffer): Promise<string | undefined> {
  const temporary = path.join(directory, `.${base}-${randomUUID()}.tmp`);
  await writeFile(temporary, data, { flag: "wx" });
  try {
    for (let attempt = 1; attempt <= 100; attempt++) {
      const file = path.join(directory, attempt === 1 ? `${base}.zip` : `${base}-${attempt}.zip`);
      if (await place(temporary, file)) return file;
    }
    return undefined;
  } finally {
    await rm(temporary, { force: true });
  }
}
