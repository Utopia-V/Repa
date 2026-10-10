import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

import { type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

export function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function parse<S extends TSchema>(schema: S, value: unknown): Static<S> {
  if (!Check(schema, value)) throw failure("invalid_input", "输入不符合插件要求");
  return value as Static<S>;
}

export async function directory(file: string): Promise<void> {
  try {
    await mkdir(file);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  if (!(await lstat(file)).isDirectory()) throw failure("file_outside_space", "插件目录必须是普通目录");
}

// 子插件使用更窄的范围，连范围内部的链接也不追踪，避免链接日后换向。
export async function scopedFile(root: string, file: string): Promise<string> {
  const relative = path.relative(root, path.resolve(root, file));
  if (path.isAbsolute(file) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw failure("file_outside_space", "子插件只能操作笔记目录");
  }
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw failure("file_outside_space", "子插件不追踪符号链接");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      break;
    }
  }
  return relative;
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  const temporary = path.join(path.dirname(file), `.notes-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    const parent = await open(path.dirname(file), "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
