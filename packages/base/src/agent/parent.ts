import { readFile } from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import { RepaFault, SessionParentSchema, type SessionParent } from "../schema.js";
import { writeJson } from "../storage.js";

// 父关联属于 Repa，不占用 Pi 的 parentSession（分支来源）。小文件以子会话 id 命名，
// 列表可单独读取，fork 得到新的 id，也就不会继承原会话的子 Agent 身份。
function parentFile(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, `${sessionId}.parent.json`);
}

export async function saveParent(sessionsDir: string, sessionId: string, parent: SessionParent): Promise<void> {
  await writeJson(parentFile(sessionsDir, sessionId), parent);
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
    data = JSON.parse(text);
  } catch {
    throw new RepaFault("invalid_session_parent", "会话的父关联无法读取", { sessionId });
  }
  if (!Value.Check(SessionParentSchema, data)) throw new RepaFault("invalid_session_parent", "会话的父关联无法读取", { sessionId });
  return data;
}
