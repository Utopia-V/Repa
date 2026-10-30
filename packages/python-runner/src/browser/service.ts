import type { RepaClient } from "@repa/base/client";
import { Value } from "typebox/value";

import { PYTHON_RUN, PythonBatchInputSchema } from "../protocol.js";
import { PythonRunError, type PythonRunner } from "./runner.js";

/**
 * 在这个连接上提供 python.run：后端的 service.request 交给运行器，结果或错误用 service.reply 交回；
 * service.closed 表示调用方不再等待，停掉对应的运行。开始服务时就在后台预热一个 Worker，第一次判分不必等 Pyodide 启动。
 * 返回取消订阅的函数。
 */
export function servePythonRun(client: Pick<RepaClient, "on" | "call">, runner: Pick<PythonRunner, "run" | "warm">): () => void {
  const running = new Map<string, AbortController>();
  const reply = (params: { id: string; result: unknown } | { id: string; error: { code: string; message: string } }) => {
    client.call("service.reply", params).catch(() => {
      // 连接已经断开：后端那边的调用随断线以 service_cancelled 结束，没有人等这个回复。
    });
  };

  const stopRequests = client.on("service.request", ({ id, service, input }) => {
    if (service !== PYTHON_RUN) {
      reply({ id, error: { code: "service_unknown", message: `这个前端不提供 ${service}` } });
      return;
    }
    if (!Value.Check(PythonBatchInputSchema, input)) {
      reply({ id, error: { code: "invalid_input", message: "python.run 的输入不符合 @repa/python-runner/protocol 的约定" } });
      return;
    }
    if (new Set(input.tests.map((test) => test.id)).size !== input.tests.length) {
      reply({ id, error: { code: "invalid_input", message: "python.run 的测试 id 有重复" } });
      return;
    }
    const controller = new AbortController();
    running.set(id, controller);
    runner.run(input, controller.signal).then(
      (result) => reply({ id, result }),
      (error: unknown) => {
        // 取消来自 service.closed，后端已经不等了。
        if (error instanceof PythonRunError && error.code === "cancelled") return;
        reply({
          id,
          error: error instanceof PythonRunError
            ? { code: error.code, message: error.message }
            : { code: "runtime_unavailable", message: error instanceof Error ? error.message : "Python 运行器出错" },
        });
      },
    ).finally(() => running.delete(id));
  });
  const stopClosed = client.on("service.closed", ({ id }) => running.get(id)?.abort());
  runner.warm();

  return () => {
    stopRequests();
    stopClosed();
    for (const controller of running.values()) controller.abort();
  };
}
