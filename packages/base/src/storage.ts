import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

/** 同步目录项；Windows 不支持对目录调用 fsync，改名后的目录项由 NTFS 日志保证。 */
export async function syncDirectory(directory: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// 同目录原子替换；文件同步并按平台完成目录同步后才向调用方报告保存成功。
export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeText(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.repa-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await rm(temporary, { force: true });
  }
}

export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(action);
    this.#tail = result.catch(() => {});
    return result;
  }

  async settled(): Promise<void> {
    await this.#tail;
  }
}
