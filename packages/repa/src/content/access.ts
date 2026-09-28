import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { RepaFault } from "../errors.js";
import { IdSchema, object } from "../schema.js";
import { SerialQueue, writeJson } from "../storage/atomic.js";

const AccessFileSchema = object({
  format: Type.Literal("repa.content-access"),
  version: Type.Literal(1),
  reads: Type.Array(object({ spaceId: IdSchema, file: Type.String({ minLength: 1 }) })),
});
type AccessFile = Static<typeof AccessFileSchema>;
const emptyFile = (): AccessFile => ({ format: "repa.content-access", version: 1, reads: [] });

/** 应用持有外部材料的精确文件读取授权，空间内容不能自行添加授权。 */
export class ContentAccessStore {
  readonly #file: string;
  readonly #queue = new SerialQueue();

  private constructor(appDirectory: string) {
    this.#file = path.resolve(appDirectory, "repa-content-access.json");
  }

  static async open(appDirectory: string): Promise<ContentAccessStore> {
    const store = new ContentAccessStore(appDirectory);
    store.#read();
    return store;
  }

  #read(): AccessFile {
    let bytes: string;
    try { bytes = readFileSync(this.#file, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
      throw new RepaFault("invalid_storage", "无法读取应用的材料授权记录。", { file: this.#file });
    }
    let saved: unknown;
    try { saved = JSON.parse(bytes); } catch {
      throw new RepaFault("invalid_storage", "材料授权记录无法解析，原文件保持不变。", { file: this.#file });
    }
    if (!Check(AccessFileSchema, saved) || saved.reads.some((grant) =>
      !path.isAbsolute(grant.file) || path.normalize(grant.file) !== grant.file))
      throw new RepaFault("invalid_storage", "材料授权记录格式无效，原文件保持不变。", { file: this.#file });
    return saved;
  }

  /** 调用者提供已解析的规范路径；每次读取应用记录，其他进程的授权立即可见。 */
  canRead(spaceId: string, canonicalFile: string): boolean {
    if (!Check(IdSchema, spaceId) || !path.isAbsolute(canonicalFile) || path.normalize(canonicalFile) !== canonicalFile)
      return false;
    if (!this.#read().reads.some((grant) => grant.spaceId === spaceId && grant.file === canonicalFile))
      return false;
    try {
      // 路径或其父目录被替换为符号链接后，不沿用原先目标的授权。
      return realpathSync(canonicalFile) === canonicalFile && lstatSync(canonicalFile).isFile();
    } catch (error) {
      // 保留失联原件的授权，让内容模块继续区分来源缺失与尚未授权。
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  /** 只由已认证前端明确关联或重新关联材料的应用入口调用。 */
  async grant(spaceId: string, absoluteFile: string): Promise<void> {
    if (!Check(IdSchema, spaceId) || !path.isAbsolute(absoluteFile))
      throw new RepaFault("invalid_input", "材料授权需要有效的空间标识与绝对文件路径。");
    let canonicalFile: string;
    try {
      canonicalFile = await realpath(absoluteFile);
      if (!(await stat(canonicalFile)).isFile())
        throw new RepaFault("invalid_input", "外部材料读取授权只接受普通文件。");
    } catch (error) {
      if (error instanceof RepaFault) throw error;
      throw new RepaFault("not_found", "无法确认外部材料的实际文件。", { file: absoluteFile });
    }
    return this.#queue.run(async () => {
      const includes = (saved: AccessFile) => saved.reads.some((grant) =>
        grant.spaceId === spaceId && grant.file === canonicalFile);
      if (includes(this.#read())) return;
      try {
        await mkdir(path.dirname(this.#file), { recursive: true });
        const file = path.join(await realpath(path.dirname(this.#file)), path.basename(this.#file));
        let compromised: Error | undefined;
        const release = await lockfile.lock(file, {
          realpath: false,
          retries: { retries: 30, minTimeout: 10, maxTimeout: 100 },
          onCompromised: (error) => { compromised = error; },
        });
        try {
          const current = this.#read();
          if (includes(current)) return;
          current.reads.push({ spaceId, file: canonicalFile });
          if (compromised) throw compromised;
          await writeJson(file, current);
          if (compromised) throw compromised;
        } finally {
          await release();
        }
      } catch (error) {
        if (error instanceof RepaFault) throw error;
        throw new RepaFault("invalid_storage", "无法保存应用的材料授权记录。", {
          file: this.#file, reason: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }
}
