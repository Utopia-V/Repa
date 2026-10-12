/**
 * 课程核对用的模型调用：经底座的 Agent 运行时（其中是 Pi 的模型接口）发单轮请求，凭据由 Pi 从
 * agentDir/auth.json 读取，这里不读也不复制凭据。每次请求只有一条系统说明和一条用户消息，没有工具和历史。
 *
 * 底座的运行时在 settings.json 没有 cacheWarming 时会写入缺省值 idle，这是 Repa 服务启动时同样会做的事。
 * 课程核对只是借用这个目录里的凭据，所以结束时若 settings.json 只多了这一项，就恢复成原来的内容。
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ModelRequest } from "./confirm.js";

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${sortedJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 运行时只补了 cacheWarming 时恢复原文件；有别的改动就保留现状并说明。 */
async function restoreSettings(file: string, before: string | undefined): Promise<string | undefined> {
  const after = await readOptional(file);
  if (after === before) return undefined;
  const added = after === undefined ? undefined : JSON.parse(after) as Record<string, unknown>;
  if (!added || added.cacheWarming !== "idle") return "settings.json 在运行期间有其他改动，没有恢复";
  const rest: Record<string, unknown> = { ...added };
  delete rest.cacheWarming;
  const original = before === undefined ? {} : JSON.parse(before) as Record<string, unknown>;
  if ("cacheWarming" in original || sortedJson(rest) !== sortedJson(original)) return "settings.json 在运行期间有其他改动，没有恢复";
  if (before === undefined) await rm(file);
  else await writeFile(file, before);
  return undefined;
}

export interface ModelChoice {
  provider: string;
  id: string;
}

export function parseModel(text: string): ModelChoice {
  const [provider, id, ...rest] = text.split("/");
  if (!provider || !id || rest.length > 0) throw new Error(`模型写成 provider/id，例如 deepseek/deepseek-flash；收到的是 ${text}`);
  return { provider, id };
}

/** 打开底座的 Agent 运行时，把单轮请求函数交给 use；结束后关闭运行时并检查设置文件。 */
export async function withModel<T>(
  agentDir: string,
  model: ModelChoice,
  use: (complete: (request: ModelRequest) => Promise<string>) => Promise<T>,
): Promise<{ value: T; warning?: string }> {
  const settings = path.join(agentDir, "settings.json");
  const before = await readOptional(settings);
  const { createAgentRuntime } = await import("@repa/base");
  let warning: string | undefined;
  let value: T;
  try {
    const runtime = await createAgentRuntime({ agentDir });
    try {
      value = await use((request) => runtime.complete({ system: request.system, prompt: request.prompt, model }));
    } finally {
      await runtime.close();
    }
  } finally {
    warning = await restoreSettings(settings, before);
  }
  return warning === undefined ? { value } : { value, warning };
}
