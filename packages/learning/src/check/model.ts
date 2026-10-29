/**
 * 课程核对用的模型调用：经底座的 Agent 运行时（其中是 Pi 的模型接口）发单轮请求，凭据由 Pi 从
 * agentDir/auth.json 读取，这里不读也不复制凭据。每次请求只有一条系统说明和一条用户消息，没有工具和历史。
 */

import type { ModelRequest } from "./confirm.js";

export interface ModelChoice {
  provider: string;
  id: string;
}

export function parseModel(text: string): ModelChoice {
  const [provider, id, ...rest] = text.split("/");
  if (!provider || !id || rest.length > 0) throw new Error(`模型写成 provider/id，例如 deepseek/deepseek-flash；收到的是 ${text}`);
  return { provider, id };
}

/** 打开底座的 Agent 运行时，把单轮请求函数交给 use；结束后关闭运行时。 */
export async function withModel<T>(
  agentDir: string,
  model: ModelChoice,
  use: (complete: (request: ModelRequest) => Promise<string>) => Promise<T>,
): Promise<T> {
  const { createAgentRuntime } = await import("@repa/base");
  const runtime = await createAgentRuntime({ agentDir });
  try {
    return await use((request) => runtime.complete({ system: request.system, prompt: request.prompt, model }));
  } finally {
    await runtime.close();
  }
}
