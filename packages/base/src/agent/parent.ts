import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import { parse, RepaFault, SessionParentSchema, type SessionParent } from "../schema.js";
import { writeJson } from "../storage.js";

// 父关联属于 Repa，不占用 Pi 的 parentSession（分支来源）。小文件以子会话 id 命名，
// 列表可单独读取，fork 得到新的 id，也就不会继承原会话的子 Agent 身份。
function parentFile(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, `${sessionId}.parent.json`);
}

export async function saveParent(sessionsDir: string, sessionId: string, parent: SessionParent): Promise<void> {
  await writeJson(parentFile(sessionsDir, sessionId), parse(SessionParentSchema, parent));
}

export async function readParent(sessionsDir: string, sessionId: string): Promise<SessionParent | undefined> {
  let text: string;
  try {
    text = await readFile(parentFile(sessionsDir, sessionId), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  let data: unknown;
  try {
    data = Value.Clean(SessionParentSchema, JSON.parse(text));
  } catch {
    throw new RepaFault("invalid_session_parent", "会话的父关联无法读取", { sessionId });
  }
  if (!Value.Check(SessionParentSchema, data)) throw new RepaFault("invalid_session_parent", "会话的父关联无法读取", { sessionId });
  return data;
}

const PARENT_SUFFIX = ".parent.json";

/** 这些会话连同它们起的子 Agent 的会话（逐层往下）。父关联文件在会话创建时写下，所以运行中的子会话也在内。 */
export async function withDescendants(sessionsDir: string, ids: Iterable<string>): Promise<Set<string>> {
  const children = new Map<string, string[]>();
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") names = [];
    else throw error;
  }
  for (const name of names) {
    if (!name.endsWith(PARENT_SUFFIX)) continue;
    const child = name.slice(0, -PARENT_SUFFIX.length);
    const parent = await readParent(sessionsDir, child);
    if (parent !== undefined) children.set(parent.sessionId, [...(children.get(parent.sessionId) ?? []), child]);
  }
  const result = new Set<string>();
  const pending = [...ids];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (result.has(id)) continue;
    result.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  return result;
}
