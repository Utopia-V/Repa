import { closeSync, constants, openSync, readFileSync, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";

import { isCode } from "../backup/copy.js";
import type { ExportRequest, PreparedExport } from "../plugin.js";
import { RepaFault, type ExportedFile } from "../schema.js";
import { within } from "../space/paths.js";
import { repaVersion, stamp, writeUnique } from "./publish.js";
import { environmentSecrets, Redactor } from "./redact.js";
import { createZip, type ZipEntry } from "./zip.js";

/** 导出用到的应用配置目录与保存的凭据，由装配方给出。 */
export interface ExportSources {
  home: string;
  /** 保存的凭据里的全部字符串值；读不到时抛错，导出就不生成。 */
  credentials(): Promise<string[]>;
}

/** 一次导出的归属：哪个插件、它的数据目录、空间的会话目录，以及当前时间。 */
export interface ExportScope extends ExportSources {
  pluginId: string;
  dataDir: string;
  sessionsDir: string;
  now(): number;
}

// Windows 没有 O_NOFOLLOW；那里靠 lstat 和目录项类型认出链接。
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

// 导出是读取空间数据的边界：在唯一的读取处计数，测试据此断言导出只读取白名单中的文件，每个文件只读一次。
const reads = new Map<string, number>();

/** 本进程中导出读取过的文件，按路径计次。 */
export function exportReads(): Map<string, number> {
  return new Map(reads);
}

function counted(file: string): void {
  reads.set(file, (reads.get(file) ?? 0) + 1);
}

/** 只取到最后一个换行符：按行追加的日志正在追加的半行不收，以完整行结尾的前缀都能读。 */
function completeLines(data: Buffer): Buffer {
  return data.subarray(0, data.lastIndexOf(0x0a) + 1);
}

/**
 * 读取插件数据目录中的一个文件：不跟随链接，按读取开始时的大小读，之后追加的内容不收；.jsonl 只取到最后一个换行符。
 * 插件的数据文件在第一次写入时才建立，不存在时按空文件收入。
 */
async function readDataFile(dataDir: string, relative: string): Promise<Buffer> {
  const file = path.resolve(dataDir, ...relative.split("/"));
  if (file === dataDir || !within(dataDir, file)) {
    throw new RepaFault("invalid_path", "导出只能收入本插件数据目录中的文件", { file: relative });
  }
  counted(file);
  let info: Stats;
  try {
    info = await lstat(file);
  } catch (error) {
    if (isCode(error, "ENOENT")) return Buffer.alloc(0);
    throw error;
  }
  if (!info.isFile()) throw new RepaFault("invalid_path", "导出只收普通文件，不跟随链接", { file: relative });
  const handle = await open(file, constants.O_RDONLY | NOFOLLOW);
  try {
    const size = (await handle.stat()).size;
    const data = Buffer.alloc(size);
    let length = 0;
    while (length < size) {
      const { bytesRead } = await handle.read(data, length, size - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const content = data.subarray(0, length);
    return relative.endsWith(".jsonl") ? completeLines(content) : content;
  } finally {
    await handle.close();
  }
}

/**
 * 空间的全部会话记录，按文件名排列。Pi 在主线程上同步写会话：平时按行追加，新建、迁移旧版本和分支时整体重写；
 * 每个文件在一段同步代码里读完，整体重写不会与之交错，同样只取到最后一个换行符。父关联等其余文件与符号链接不收。
 */
async function readSessions(sessionsDir: string): Promise<{ name: string; data: Buffer }[]> {
  const entries = await readdir(sessionsDir, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => entry.name).sort();
  return names.map((name) => {
    const file = path.join(sessionsDir, name);
    counted(file);
    const descriptor = openSync(file, constants.O_RDONLY | NOFOLLOW);
    try {
      return { name, data: completeLines(readFileSync(descriptor)) };
    } finally {
      closeSync(descriptor);
    }
  });
}

/**
 * 准备一份导出：读出插件列出的内容，sessions 为真时再收入会话记录，最后加上 manifest.json，记下时间、Repa 版本、插件、
 * 是否收入会话，以及各文件的字节数、记录条数与替换处数。全部内容按反馈包的规则替换凭据与密钥：保存的凭据和 Pi 解析出的密钥、
 * 名称像凭据的环境变量值逐字替换，再处理私钥与常见令牌格式；.jsonl 逐行解析后替换。zip 在内存中生成并冻结，
 * 返回的清单与之后写出的文件出自同一份内容。凭据读不到时整次失败，不生成只靠格式匹配脱敏的包。
 */
export async function prepareExport(scope: ExportScope, request: ExportRequest): Promise<PreparedExport> {
  let credentials: string[];
  try {
    credentials = await scope.credentials();
  } catch (error) {
    throw new RepaFault("export_redaction_failed", "读不到保存的凭据，无法脱敏，没有生成导出", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  const redactor = new Redactor([...credentials, ...environmentSecrets(process.env)]);
  const created = new Date(scope.now());
  const entries: ZipEntry[] = [];
  const files: ExportedFile[] = [];
  const add = (name: string, raw: string) => {
    const before = redactor.count;
    const lines = name.endsWith(".jsonl");
    const text = lines ? redactor.jsonl(raw) : redactor.text(raw);
    const data = Buffer.from(text, "utf8");
    entries.push({ name, data });
    files.push({ name, bytes: data.length, ...(lines ? { records: text.split("\n").length - 1 } : {}), redactions: redactor.count - before });
  };
  for (const item of request.files) {
    add(item.name, "text" in item ? item.text : (await readDataFile(scope.dataDir, item.file)).toString("utf8"));
  }
  if (request.sessions) {
    for (const session of await readSessions(scope.sessionsDir)) add(`sessions/${session.name}`, session.data.toString("utf8"));
  }
  // 清单只有路径、计数与版本，不含记录内容，最后写。
  const manifest = Buffer.from(`${JSON.stringify({
    createdAt: created.toISOString(),
    repa: await repaVersion(),
    plugin: scope.pluginId,
    sessions: request.sessions,
    redactions: redactor.count,
    files,
  }, null, 2)}\n`, "utf8");
  entries.push({ name: "manifest.json", data: manifest });
  const names = entries.map((entry) => entry.name);
  if (new Set(names).size !== names.length) throw new RepaFault("invalid_export", "导出的包内路径重复", { names });
  const zip = createZip(entries, created);
  return {
    files: [...files, { name: "manifest.json", bytes: manifest.length, redactions: 0 }],
    async write(directory) {
      if (directory !== undefined && !path.isAbsolute(directory)) {
        throw new RepaFault("invalid_path", "导出的存放目录需要是绝对路径", { path: directory });
      }
      const target = directory ?? path.join(scope.home, "exports");
      await mkdir(target, { recursive: true });
      const file = await writeUnique(target, `repa-${scope.pluginId}-export-${stamp(created)}`, zip);
      if (file === undefined) throw new RepaFault("export_write_failed", "导出的文件名都被占用了", { directory: target });
      return file;
    },
  };
}
