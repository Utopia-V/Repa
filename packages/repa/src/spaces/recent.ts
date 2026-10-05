import { access, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { RepaFault } from "../errors.js";
import { object } from "../schema.js";
import { SerialQueue, writeJson } from "../storage/atomic.js";
import { RecentSpaceRecordSchema, type RecentSpace, type RecentSpaceRecord } from "./schema.js";

const RecentSpacesFileSchema = object({
  format: Type.Literal("repa.recent-spaces"),
  version: Type.Literal(1),
  entries: Type.Array(RecentSpaceRecordSchema),
});
type RecentSpacesFile = Static<typeof RecentSpacesFileSchema>;

async function available(directory: string): Promise<boolean> {
  try {
    if (!(await stat(directory)).isDirectory()) return false;
    await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

/** 应用侧保存最近使用的路径；空间内容、身份和运行状态仍由原模块持有。 */
export class RecentSpaces {
  readonly #file: string;
  readonly #queue = new SerialQueue();

  constructor(appDirectory: string) {
    this.#file = path.join(appDirectory, "repa-recent-spaces.json");
  }

  async #read(): Promise<RecentSpaceRecord[]> {
    let bytes: string;
    try {
      bytes = await readFile(this.#file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new RepaFault("invalid_storage", "无法读取最近空间记录。", { file: this.#file });
    }
    let saved: unknown;
    try {
      saved = JSON.parse(bytes);
    } catch {
      throw new RepaFault("invalid_storage", "最近空间记录不是有效的 JSON。", { file: this.#file });
    }
    if (!Check(RecentSpacesFileSchema, saved))
      throw new RepaFault("invalid_storage", "最近空间记录格式无效。", { file: this.#file });
    return saved.entries;
  }

  async list(limit = 20): Promise<RecentSpace[]> {
    const entries = (await this.#read()).slice(0, limit);
    return Promise.all(entries.map(async entry => ({ ...entry, available: await available(entry.path) })));
  }

  remember(directory: string): Promise<void> {
    return this.#queue.run(async () => {
      await mkdir(path.dirname(this.#file), { recursive: true });
      const file = path.join(await realpath(path.dirname(this.#file)), path.basename(this.#file));
      const release = await lockfile.lock(file, {
        realpath: false,
        retries: { retries: 30, minTimeout: 10, maxTimeout: 100 },
      });
      try {
        const previous = await this.#read();
        const saved: RecentSpacesFile = {
          format: "repa.recent-spaces",
          version: 1,
          entries: [{ path: directory, lastOpenedAt: Date.now() }, ...previous.filter(entry => entry.path !== directory)],
        };
        await writeJson(file, saved);
      } finally {
        await release();
      }
    });
  }
}
