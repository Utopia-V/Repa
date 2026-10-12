import type { AgentWork, CompletionRequest, Models, ModelScope } from "../plugin.js";
import { RepaFault } from "../schema.js";

// 宿主持有模型工作，不要求每个插件再实现一份取消与等待链。
export function createModelScope(models: Models, onError?: (error: unknown) => void): ModelScope {
  const requests = new Set<Promise<unknown>>();
  const controllers = new Set<AbortController>();
  const work = new Set<AgentWork>();
  const stoppingWork = new Map<AgentWork, Promise<PromiseSettledResult<void>[]>>();
  let closing: Promise<void> | undefined;

  function checkOpen(): void {
    if (closing !== undefined) throw new RepaFault("models_closed", "模型工作作用域已经关闭");
  }

  function track<T>(operation: Promise<T>): Promise<T> {
    requests.add(operation);
    operation.then(() => { requests.delete(operation); }, () => { requests.delete(operation); });
    return operation;
  }

  function stopTask(task: AgentWork): void {
    if (!stoppingWork.has(task)) {
      // 取消与结果分别有完成链；任一请求卡住不应延迟其他工作的取消。
      stoppingWork.set(task, Promise.allSettled([task.cancel(), task.result]));
    }
  }

  function request<T>(input: CompletionRequest, invoke: (request: CompletionRequest) => Promise<T>): Promise<T> {
    checkOpen();
    const controller = new AbortController();
    controllers.add(controller);
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    const operation = Promise.resolve().then(() => invoke({ ...input, signal })).finally(() => { controllers.delete(controller); });
    return track(operation);
  }

  return {
    models: {
      complete: (input) => request(input, (request) => models.complete(request)),
      completeStructured: (input, schema) => request(input, (request) => models.completeStructured(request, schema)),
      runAgent(task) {
        checkOpen();
        return track(Promise.resolve().then(async () => {
          const original = await models.runAgent(task);
          let cancelling: Promise<void> | undefined;
          const owned: AgentWork = {
            id: original.id,
            result: original.result,
            cancel() {
              cancelling ??= track(Promise.resolve().then(() => original.cancel()));
              return cancelling;
            },
          };
          work.add(owned);
          original.result.then(() => { work.delete(owned); }, (error: unknown) => {
            work.delete(owned);
            if (closing === undefined && cancelling === undefined) onError?.(error);
          });
          if (closing !== undefined) stopTask(owned);
          return owned;
        }));
      },
    },
    close() {
      if (closing === undefined) {
        closing = Promise.resolve().then(async () => {
          for (const controller of controllers) controller.abort();
          for (const task of work) stopTask(task);
          // 创建中的 runAgent 取得句柄时也立即取消；等创建结束后，停止集合不再增加。
          await Promise.allSettled([...requests]);
          const stopped = await Promise.all(stoppingWork.values());
          // cancel 表示发出取消，result 的终态才表示实际工作已停稳。
          const failures = stopped.flatMap(([cancelled]) => cancelled?.status === "rejected" ? [cancelled.reason] : []);
          if (failures.length > 0) throw new AggregateError(failures, "插件模型工作取消失败");
        });
      }
      return closing;
    },
  };
}
