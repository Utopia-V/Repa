import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Static, TSchema } from "typebox";

import type { AskRoute } from "./ask.js";
import type { AgentTask, AgentWork, CompletionRequest, ModelRef, Models, Plugin, Services } from "./plugin.js";
import { openPluginHost, type PluginHost } from "./plugins.js";
import { parse } from "./schema.js";
import { createSpace, type Space } from "./space.js";

export type { AskInput, AskRoute, AskRouteOptions } from "./ask.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  // 作者可以先安排失败再调用插件；失败仍由真正调用方观察。
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** 离线单次生成的控制句柄，测试可观察请求后安排成功或失败。 */
export interface TestCompletion<T> {
  requested: Promise<CompletionRequest>;
  succeed(value: T): void;
  fail(error: unknown): void;
}

/** 离线 Agent 工作的控制句柄，测试可观察任务、取消请求并决定终态。 */
export interface TestAgent {
  id: string;
  requested: Promise<AgentTask>;
  cancelRequested: Promise<void>;
  result: Promise<void>;
  finish(): void;
  fail(error: unknown): void;
}

type CompletionPlan = {
  requested: ReturnType<typeof deferred<CompletionRequest>>;
  response: ReturnType<typeof deferred<unknown>>;
};
type AgentPlan = { requested: ReturnType<typeof deferred<AgentTask>>; work: AgentWork };

/** 离线驱动捕获的模型调用，用于断言文本、结构化生成与 Agent 任务请求。 */
export type TestModelCall =
  | { kind: "complete"; request: CompletionRequest }
  | { kind: "structured"; request: CompletionRequest; schema: TSchema }
  | { kind: "agent"; task: AgentTask };

// 替身只放在 Models 边界；输入 schema 仍走真实校验。
/** Models 边界的离线测试驱动，按预先安排的结果响应并保留调用记录。 */
export class ModelTestDriver implements Models {
  readonly calls: TestModelCall[] = [];
  private readonly completions: CompletionPlan[] = [];
  private readonly structured: CompletionPlan[] = [];
  private readonly agents: AgentPlan[] = [];
  private nextAgent = 1;
  private model: ModelRef | undefined = { provider: "test", id: "test" };

  /** 设定 defaultModel() 的回答；传 undefined 模拟没有可用模型。默认有一个测试模型。 */
  setDefaultModel(model: ModelRef | undefined): void {
    this.model = model;
  }

  defaultModel(): ModelRef | undefined {
    return this.model;
  }

  expectComplete(): TestCompletion<string> {
    return this.planCompletion<string>(this.completions);
  }

  expectStructured(): TestCompletion<unknown> {
    return this.planCompletion<unknown>(this.structured);
  }

  private planCompletion<T>(queue: CompletionPlan[]): TestCompletion<T> {
    const requested = deferred<CompletionRequest>();
    const response = deferred<unknown>();
    queue.push({ requested, response });
    return {
      requested: requested.promise,
      succeed: (value) => { response.resolve(value); },
      fail: (error) => { response.reject(error); },
    };
  }

  expectAgent(options: { cancel?: "finish" | "manual" } = {}): TestAgent {
    const id = `test-agent-${this.nextAgent++}`;
    const requested = deferred<AgentTask>();
    const cancelled = deferred<void>();
    const result = deferred<void>();
    this.agents.push({
      requested,
      work: {
        id,
        result: result.promise,
        async cancel() {
          cancelled.resolve();
          if (options.cancel !== "manual") result.resolve();
        },
      },
    });
    return {
      id,
      requested: requested.promise,
      cancelRequested: cancelled.promise,
      result: result.promise,
      finish: () => { result.resolve(); },
      fail: (error) => { result.reject(error); },
    };
  }

  async complete(request: CompletionRequest): Promise<string> {
    this.calls.push({ kind: "complete", request });
    const value = await this.respond(this.completions, request, "complete");
    if (typeof value !== "string") throw new Error("complete 的测试结果必须是字符串");
    return value;
  }

  async completeStructured<S extends TSchema>(request: CompletionRequest, schema: S): Promise<Static<S>> {
    this.calls.push({ kind: "structured", request, schema });
    return parse(schema, await this.respond(this.structured, request, "completeStructured"));
  }

  async runAgent(task: AgentTask): Promise<AgentWork> {
    this.calls.push({ kind: "agent", task });
    const plan = this.agents.shift();
    if (!plan) throw new Error("未安排 runAgent 的测试结果；先调用 expectAgent()");
    plan.requested.resolve(task);
    return plan.work;
  }

  private async respond(queue: CompletionPlan[], request: CompletionRequest, method: string): Promise<unknown> {
    const plan = queue.shift();
    if (!plan) throw new Error(`未安排 ${method} 的测试结果；先调用相应的 expect 方法`);
    plan.requested.resolve(request);
    const signal = request.signal;
    if (!signal) return plan.response.promise;
    signal.throwIfAborted();
    const aborted = deferred<never>();
    const onAbort = () => { aborted.reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([plan.response.promise, aborted.promise]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/** 临时空间及其插件宿主的测试夹具，关闭时等待资源收尾并删除目录。 */
export interface PluginTestHost {
  directory: string;
  space: Space;
  host: PluginHost;
  models: ModelTestDriver;
  events: { pluginId: string; event: unknown }[];
  errors: unknown[];
  writeFile(file: string, text: string): Promise<void>;
  close(): Promise<void>;
}

/** 离线插件宿主的装配选项，用于提供插件、时钟、模型驱动及模拟用户服务。 */
export interface PluginTestHostOptions {
  /** 当前时间，Unix 毫秒；省略时使用系统时钟。 */
  now?: () => number;
  plugins: Plugin[];
  models?: ModelTestDriver;
  /**
   * 模拟用户回答 ToolContext.ask：收到整理好的 Item（version 与 requires 已算出），返回询问的结局。
   * 要模拟提交时调用 options.onSubmit 得到插件的处理结果。省略时询问以 ask_unavailable 失败。
   */
  ask?: AskRoute;
  /** 模拟前端声明的服务。省略时调用以 service_unavailable 失败。 */
  services?: Services;
}

/** 在临时空间中打开真实插件宿主并注入离线模型驱动，供插件集成测试使用。 */
export async function createPluginTestHost(options: PluginTestHostOptions): Promise<PluginTestHost> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-plugin-test-"));
  const errors: unknown[] = [];
  const events: PluginTestHost["events"] = [];
  const models = options.models ?? new ModelTestDriver();
  let space: Space | undefined;
  let host: PluginHost | undefined;
  let closing: Promise<void> | undefined;

  function close(): Promise<void> {
    closing ??= (async () => {
      const failures: unknown[] = [];
      try {
        await host?.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await space?.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) throw new AggregateError(failures, "离线测试宿主清理失败");
    })();
    return closing;
  }

  try {
    space = await createSpace(path.join(directory, "space"), { watch: false, onError: (error) => { errors.push(error); } });
    host = await openPluginHost({
      space,
      plugins: options.plugins,
      models,
      now: options.now,
      ...(options.ask === undefined ? {} : { ask: options.ask }),
      ...(options.services === undefined ? {} : { services: options.services }),
      // 导出写到临时目录的 home/exports/；没有保存的凭据，只按环境变量和格式替换。
      exports: { home: path.join(directory, "home"), credentials: async () => [] },
      emit: (pluginId, event) => { events.push({ pluginId, event }); },
      onError: (error) => { errors.push(error); },
    });
    const openedSpace = space;
    const openedHost = host;
    return {
      directory, space, host, models, events, errors,
      async writeFile(file, text) {
        // 不依赖操作系统 watcher 的时序；真实快照与订阅在 flush 内完成。
        await openedSpace.files.write(file, text);
        await openedHost.flush();
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "离线测试宿主打开与清理失败");
    }
    throw error;
  }
}
