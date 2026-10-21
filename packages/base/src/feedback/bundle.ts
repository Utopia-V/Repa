import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Revision } from "@repa/space-history";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AgentSpace } from "../agent.js";
import type { CompletionRequest } from "../plugin.js";
import { RepaFault, type SessionInfo } from "../schema.js";
import { describe } from "./describe.js";
import type { RecentErrors } from "./errors.js";
import { environmentSecrets, Redactor } from "./redact.js";
import { createZip, type ZipEntry } from "./zip.js";

// 反馈包里的空间历史条数。这是 Repa 的假设：够核对最近几次运行写了什么，按实际反馈调整。
const HISTORY_LIMIT = 50;

export interface FeedbackRequest {
  sessionId: string;
  note?: string;
  describe: boolean;
  clientErrors?: { time: string; message: string; source?: string }[];
  /** 宿主指定的存放目录，例如 Desktop 的“下载”；省略时放在 Repa home 的 feedback/。 */
  directory?: string;
}

export interface FeedbackSources {
  home: string;
  root: string;
  agent: AgentSpace;
  history: { list(limit?: number): Promise<Revision[]> };
  complete(request: CompletionRequest): Promise<string>;
  /** 用户保存在 Repa 里的凭据值。读不到时抛错，反馈包就不生成。 */
  credentials(): Promise<string[]>;
  errors: RecentErrors;
  commandPolicy: string;
  plugins: { id: string }[];
}

interface ManifestFile {
  name: string;
  source: string;
  redactions: number;
}

const PackageSchema = Type.Object({ version: Type.String() });

async function repaVersion(): Promise<string> {
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
function stamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 会话及其派生的子 Agent 会话，按父关联逐层找下去。 */
function withDescendants(sessions: readonly SessionInfo[], id: string): string[] {
  const found = [id];
  for (let index = 0; index < found.length; index++) {
    const parent = found[index];
    for (const session of sessions) {
      if (session.parent?.sessionId === parent && !found.includes(session.id)) found.push(session.id);
    }
  }
  return found;
}

async function sessionRecord(agent: AgentSpace, id: string): Promise<string> {
  const file = agent.sessionFile(id);
  if (file === undefined) throw new RepaFault("session_not_found", "会话记录不存在", { id });
  return readFile(file, "utf8");
}

function failure(error: unknown): string {
  if (error instanceof RepaFault) return `${error.message}（${error.code}）`;
  return error instanceof Error ? error.message : String(error);
}

async function writeUnique(directory: string, base: string, data: Buffer): Promise<string> {
  for (let attempt = 1; attempt <= 100; attempt++) {
    const file = path.join(directory, attempt === 1 ? `${base}.zip` : `${base}-${attempt}.zip`);
    try {
      await writeFile(file, data, { flag: "wx" });
      return file;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new RepaFault("feedback_write_failed", "反馈包的文件名都被占用了", { directory });
}

/**
 * 生成反馈包：先取得凭据并建好脱敏，再写自述、收集材料，全部脱敏后在内存里打包，最后只写出 zip。
 * 磁盘上不会出现未脱敏的中间文件；凭据读不到时整次失败，不生成只靠格式匹配脱敏的包。
 */
export async function createFeedbackBundle(sources: FeedbackSources, request: FeedbackRequest, signal?: AbortSignal): Promise<{ path: string; files: string[] }> {
  if (request.directory !== undefined && !path.isAbsolute(request.directory)) {
    throw new RepaFault("invalid_path", "反馈包的存放目录需要是绝对路径", { path: request.directory });
  }
  let credentials: string[];
  try {
    credentials = await sources.credentials();
  } catch (error) {
    throw new RepaFault("feedback_redaction_failed", "读不到保存的凭据，无法脱敏，没有生成反馈包", { reason: failure(error) });
  }
  const redactor = new Redactor([...credentials, ...environmentSecrets(process.env)]);
  const created = new Date();
  const session = await sources.agent.get(request.sessionId);
  const info = session.info();
  const files: ManifestFile[] = [];
  const entries: ZipEntry[] = [];
  const add = (name: string, source: string, content: () => string) => {
    const before = redactor.count;
    entries.push({ name, data: Buffer.from(content(), "utf8") });
    files.push({ name, source, redactions: redactor.count - before });
  };
  const json = (value: unknown) => `${JSON.stringify(redactor.value(value), null, 2)}\n`;

  let description: string;
  if (!request.describe) {
    description = "用户没有让 Agent 描述这次的问题。";
  } else {
    try {
      description = await describe(sources.complete, session.history(), {
        ...(info.model === undefined ? {} : { model: info.model }),
        ...(request.note === undefined ? {} : { note: request.note }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      description = `Agent 自述没有生成：${failure(error)}`;
    }
  }
  const note = request.note === undefined || request.note.trim().length === 0 ? "（没有填写）" : request.note;
  add("description.md", "用户填写的说明与 Agent 自述", () => redactor.text([
    "# 问题反馈",
    "",
    "## 用户补充的说明",
    "",
    note,
    "",
    "## Agent 自述",
    "",
    "> 以下由 Agent 根据对话记录生成，可能有误；以 sessions/ 里的原始记录为准。",
    "",
    description,
    "",
  ].join("\n")));

  for (const id of withDescendants(await sources.agent.list(), info.id)) {
    const record = await sessionRecord(sources.agent, id);
    add(`sessions/${id}.jsonl`, id === info.id ? "当前会话" : "子 Agent 会话", () => redactor.jsonl(record));
  }
  const revisions = await sources.history.list(HISTORY_LIMIT);
  add("history.json", `最近 ${HISTORY_LIMIT} 条空间历史`, () => json(revisions));
  add("errors.json", "后端最近的错误与前端带来的错误事件", () => json({ backend: sources.errors.list(), client: request.clientErrors ?? [] }));
  let version: string;
  try {
    version = await repaVersion();
  } catch (error) {
    version = `读取失败：${failure(error)}`;
  }
  add("environment.json", "运行环境", () => json({
    repa: version,
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    node: process.versions.node,
    ...(process.versions.electron === undefined ? {} : { electron: process.versions.electron }),
    space: sources.root,
    session: { id: info.id, agent: info.agent, ...(info.model === undefined ? {} : { model: info.model }) },
    commandPolicy: sources.commandPolicy,
    plugins: sources.plugins.map(plugin => plugin.id),
    createdAt: created.toISOString(),
  }));
  // manifest 本身不含会话内容，最后写，记下每个文件替换了几处。
  const manifest = { createdAt: created.toISOString(), sessionId: info.id, redactions: redactor.count, files };
  entries.push({ name: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") });

  const directory = request.directory ?? path.join(sources.home, "feedback");
  await mkdir(directory, { recursive: true });
  const file = await writeUnique(directory, `repa-feedback-${stamp(created)}`, createZip(entries, created));
  return { path: file, files: entries.map(entry => entry.name) };
}
