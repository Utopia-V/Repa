import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { RepresentationSchema } from "./requests/schema.js";
import { remapInput } from "./requests/store.js";
import { atomicWrite } from "./storage/atomic.js";
import { historyView, Resources } from "./messages.js";
import type { ResourceRetention } from "./content/resources.js";
import {
  PiConversationHost,
  type ConversationRuntime,
  type OpenPiHostOptions,
} from "./pi-host.js";
import { RepaFault, type Message } from "./protocol.js";

export interface StoredSessionSnapshot {
  name: string | undefined;
  createdAt: number;
  messages: Message[];
  revision: string;
}
type RuntimeOptions = Omit<
  OpenPiHostOptions,
  "sessionManager" | "learnerSpace" | "resources"
>;

/** 仅改写复制空间中标准工具结果的归属；其他 Pi 条目保留原始字节。 */
export async function copySessionResources(root: string, source: string, destination: string): Promise<void> {
  const directory = path.join(root, ".repa", "sessions");
  let files: string[];
  try { files = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const file of files.filter(file => file.endsWith(".jsonl"))) {
    const filename = path.join(directory, file);
    const original = await readFile(filename, "utf8");
    const next = original.split("\n").map(line => {
      if (!line.trim()) return line;
      const entry: unknown = JSON.parse(line);
      if (!entry || typeof entry !== "object" || !("type" in entry)) return line;
      const message = entry.type === "message" && "message" in entry ? entry.message
        : entry.type === "context_edit" && "replacement" in entry ? entry.replacement : undefined;
      if (!message || typeof message !== "object" || !("details" in message) || !Check(RepresentationSchema, message.details)) return line;
      remapInput({ parts: [{ kind: "data", representation: message.details }] }, source, destination);
      return JSON.stringify(entry);
    }).join("\n");
    if (next !== original) await atomicWrite(filename, next);
  }
}
export interface StoredSession {
  readonly id: string;
  readonly exists: boolean;
  remove(): void;
  snapshot(revision?: string): StoredSessionSnapshot;
  branch(messageId: string): StoredSession;
  openRuntime(options: RuntimeOptions): Promise<ConversationRuntime>;
}

/** Repa publishes empty session identities; Pi normally defers their files until the first reply. */
function persistSession(manager: SessionManager): SessionManager {
  const file = manager.getSessionFile();
  if (!file) throw new Error("会话缺少持久保存位置。");
  if (!existsSync(file)) {
    writeFileSync(
      file,
      [manager.getHeader(), ...manager.getEntries()]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      { flag: "wx", mode: 0o600, flush: true },
    );
  }
  return SessionManager.open(file, manager.getSessionDir(), manager.getCwd());
}

/** Owns the Pi session format and tree semantics, without opening an Agent runtime for reads. */
class PiStoredSession implements StoredSession {
  readonly #manager: SessionManager;
  readonly #resources: Resources;
  readonly #retention: ResourceRetention;
  readonly #messages = new Map<string, Message[]>();

  constructor(manager: SessionManager, retention: ResourceRetention) {
    this.#manager = manager;
    this.#retention = retention;
    this.#resources = new Resources(retention, `session:${manager.getSessionId()}`);
    // 整个会话树的资源属于该会话，当前叶节点以外的历史也继续保留。
    this.#history(manager.getEntries());
  }

  #history(entries: SessionEntry[]): Message[] {
    return entries.flatMap(entry => {
      let messages = this.#messages.get(entry.id);
      if (messages === undefined) {
        // SDK 条目不可变；同一会话只投影新条目，不为读取历史反复保存图片。
        messages = historyView([entry], this.#resources);
        this.#messages.set(entry.id, messages);
      }
      return messages;
    });
  }

  get id(): string {
    return this.#manager.getSessionId();
  }
  get exists(): boolean { return existsSync(this.#manager.getSessionFile()!); }
  remove(): void {
    const file = this.#manager.getSessionFile()!;
    if (existsSync(file)) unlinkSync(file);
    this.#retention.releaseOwner(`session:${this.id}`);
  }

  snapshot(revision?: string): StoredSessionSnapshot {
    const prefix = `history-v1:${this.id}:`;
    let anchor = this.#manager.getLeafId();
    if (revision !== undefined) {
      if (!revision.startsWith(prefix))
        throw new RepaFault("revision_unavailable", "历史修订不属于该会话或已不可读取。");
      const selected = revision.slice(prefix.length);
      if (selected === "empty") anchor = null;
      else if (this.#manager.getEntry(selected)) anchor = selected;
      else throw new RepaFault("revision_unavailable", "历史修订的分支位置已不可读取。");
    }
    // Pi 原条目追加后不再改写；固定 leaf 即可冻结历史，不加载或改变运行位置。
    const entries = anchor === null ? [] : this.#manager.getBranch(anchor);
    return structuredClone({
      name: this.#manager.getSessionName(),
      createdAt:
        Date.parse(this.#manager.getHeader()?.timestamp ?? "") || Date.now(),
      messages: this.#history(entries),
      revision: `${prefix}${anchor ?? "empty"}`,
    });
  }

  branch(messageId: string): StoredSession {
    // Branch through a separate manager so an existing runtime keeps its identity and tree position.
    const manager = SessionManager.open(
      this.#manager.getSessionFile()!,
      this.#manager.getSessionDir(),
      this.#manager.getCwd(),
    );
    const entry = manager.getEntry(messageId);
    if (
      !entry ||
      !this.#history(manager.getBranch()).some(
        (message) => message.id === messageId,
      )
    ) {
      throw new RepaFault("invalid_branch_point", "请选择已经保存的历史消息。");
    }
    const pending = new Set<string>();
    for (const item of manager.getBranch(entry.id)) {
      if (item.type !== "message") continue;
      if (item.message.role === "assistant") {
        for (const part of item.message.content)
          if (part.type === "toolCall") pending.add(part.id);
      }
      if (item.message.role === "toolResult")
        pending.delete(item.message.toolCallId);
    }
    if (pending.size)
      throw new RepaFault(
        "invalid_branch_point",
        "该位置仍有未配对的工具调用，请选择工具结果之后的消息。",
      );
    manager.createBranchedSession(entry.id);
    return new PiStoredSession(persistSession(manager), this.#retention);
  }

  openRuntime(options: RuntimeOptions): Promise<ConversationRuntime> {
    return PiConversationHost.open({
      ...options,
      learnerSpace: this.#manager.getCwd(),
      sessionManager: this.#manager,
      resources: this.#resources,
    });
  }
}

export class PiSessionStore {
  readonly #cwd: string;
  readonly #directory: string;
  readonly #retention: ResourceRetention;

  constructor(cwd: string, retention: ResourceRetention) {
    this.#cwd = cwd;
    this.#directory = path.join(cwd, ".repa", "sessions");
    this.#retention = retention;
    mkdirSync(this.#directory, { recursive: true });
  }

  async list(): Promise<StoredSession[]> {
    // 空间目录拥有这些会话；历史 cwd 是来源信息，搬移后不能用它过滤当前会话。
    const sessions = await SessionManager.listAll(this.#directory);
    const files = (await readdir(this.#directory)).filter(file => file.endsWith(".jsonl"));
    // 有不可解释的会话文件时保守保留资源，避免将恢复所需字节当作孤儿删除。
    if (files.length === sessions.length)
      this.#retention.reconcileOwners("session:", new Set(sessions.map(session => session.id)));
    return sessions.map(
      (session) =>
        new PiStoredSession(
          SessionManager.open(session.path, this.#directory, this.#cwd),
          this.#retention,
        ),
    );
  }

  create(): StoredSession {
    return new PiStoredSession(
      persistSession(SessionManager.create(this.#cwd, this.#directory)),
      this.#retention,
    );
  }
}
