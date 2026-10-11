import { AsyncLocalStorage } from "node:async_hooks";

/** 一次 Agent 运行的标识；子 Agent 的运行同时记下发起它的父运行。 */
export interface RunContext {
  runId: string;
  parentRunId?: string;
  sessionId: string;
  agent: string;
}

// 插件可能经由另一份模块副本导入本文件；共用全局登记的存储，运行内的工具才能读到底座设置的上下文。
const holder = globalThis as unknown as Record<symbol, AsyncLocalStorage<RunContext> | undefined>;
const key = Symbol.for("repa.runContext");
const storage = holder[key] ?? (holder[key] = new AsyncLocalStorage<RunContext>());

/** 运行内的工具调用和插件写入可取得当前运行；运行之外返回 undefined。 */
export function currentRun(): RunContext | undefined {
  return storage.getStore();
}

/** 底座在一次运行的完成链内设置上下文，其中的模型回合、工具调用和文件写入都会继承。 */
export function withRun<T>(context: RunContext, action: () => Promise<T>): Promise<T> {
  return storage.run(context, action);
}
