import { AsyncLocalStorage } from "node:async_hooks";

/** 一次 Agent 运行的标识。 */
export interface RunContext {
  runId: string;
  /**
   * 祖先运行，从近到远：子运行的链是父运行的 runId 加上父运行自己的链，根运行的链为空。
   * 同一个 runId 每次读到的链都相同；第一项就是父运行。
   */
  ancestorRunIds: readonly string[];
  sessionId: string;
  agent: string;
  /** 插件工具内发起子调用时，用于关联父工具。 */
  callId?: string;
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

/** 插件宿主在工具执行期间补上调用编号，普通运行的上下文保持不变。 */
export function withToolCall<T>(callId: string, action: () => Promise<T>): Promise<T> {
  const run = currentRun();
  return run === undefined ? action() : withRun({ ...run, callId }, action);
}
