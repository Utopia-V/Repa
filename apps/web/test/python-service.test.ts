import type { PythonRunInput, PythonRunResult } from "@repa/learning/protocol";
import { describe, expect, it, vi } from "vitest";

import { PythonRunError } from "@/lib/python/runner";
import { servePythonRun } from "@/lib/python/service";
import { fakeClient } from "./fake-client";

const input: PythonRunInput = { program: "total = 1 + 1", tests: [{ id: "total", data: [], captures: ["total"], doctest: [] }] };
const result: PythonRunResult = {
  runtime: { pyodide: "314.0.7", python: "3.14.2", packages: {}, runner: "a".repeat(64) },
  tests: [{ id: "total", status: "done", stdout: "", error: null, captures: { total: { value: 2 } }, doctest: [] }],
};

function setup(run: (input: PythonRunInput, signal?: AbortSignal) => Promise<PythonRunResult>) {
  const call = vi.fn((_method: string, _params: never) => Promise.resolve(null));
  const { client, emit } = fakeClient(call);
  const runner = { run: vi.fn(run) };
  const stop = servePythonRun(client, runner);
  return { call, emit, runner, stop };
}

describe("servePythonRun", () => {
  it("把 python.run 交给运行器，结果用 service.reply 交回", async () => {
    const { call, emit, runner } = setup(() => Promise.resolve(result));
    emit("service.request", { id: "req-1", service: "python.run", input });

    await vi.waitFor(() => expect(call).toHaveBeenCalledWith("service.reply", { id: "req-1", result }));
    expect(runner.run).toHaveBeenCalledWith(input, expect.any(AbortSignal));
  });

  it("输入不符合约定、测试 id 重复或请求了别的服务时直接以错误回复，不运行代码", async () => {
    const { call, emit, runner } = setup(() => Promise.resolve(result));
    emit("service.request", { id: "req-1", service: "python.run", input: { ...input, verify: "assert total == 2" } });
    emit("service.request", { id: "req-2", service: "r.run", input: {} });
    emit("service.request", { id: "req-3", service: "python.run", input: { ...input, tests: [...input.tests, ...input.tests] } });

    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(call).toHaveBeenCalledWith("service.reply", {
      id: "req-1", error: { code: "invalid_input", message: "python.run 的输入不符合 @repa/learning/protocol 的约定" },
    });
    expect(call).toHaveBeenCalledWith("service.reply", { id: "req-2", error: { code: "service_unknown", message: "这个前端不提供 r.run" } });
    expect(call).toHaveBeenCalledWith("service.reply", { id: "req-3", error: { code: "invalid_input", message: "python.run 的测试 id 有重复" } });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("运行器的错误码原样交回", async () => {
    const { call, emit } = setup(() => Promise.reject(new PythonRunError("runtime_unavailable", "Pyodide 在 60 秒内没有就绪")));
    emit("service.request", { id: "req-1", service: "python.run", input });

    await vi.waitFor(() => expect(call).toHaveBeenCalledWith("service.reply", {
      id: "req-1", error: { code: "runtime_unavailable", message: "Pyodide 在 60 秒内没有就绪" },
    }));
  });

  it("service.closed 停掉对应的运行，不再回复", async () => {
    let signal: AbortSignal | undefined;
    const { call, emit } = setup((_input, received) => new Promise((_resolve, reject) => {
      signal = received;
      received?.addEventListener("abort", () => reject(new PythonRunError("cancelled", "运行已取消")));
    }));
    emit("service.request", { id: "req-1", service: "python.run", input });
    emit("service.closed", { id: "req-1", reason: "aborted" });

    expect(signal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(call).not.toHaveBeenCalled();
  });

  it("停止服务后不再接新的请求，进行中的运行一并停掉", () => {
    let signal: AbortSignal | undefined;
    const { emit, runner, stop } = setup((_input, received) => {
      signal = received;
      return new Promise(() => {});
    });
    emit("service.request", { id: "req-1", service: "python.run", input });
    stop();
    emit("service.request", { id: "req-2", service: "python.run", input });

    expect(signal?.aborted).toBe(true);
    expect(runner.run).toHaveBeenCalledOnce();
  });
});
