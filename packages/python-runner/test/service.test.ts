import assert from "node:assert/strict";
import test from "node:test";

import type { RepaClient } from "@repa/base/client";

import { PythonRunError, type PythonCapabilities } from "../src/browser/runner.js";
import { servePythonRun } from "../src/browser/service.js";
import { PYTHON_BATCH, type PythonBatchInput, type PythonBatchResult } from "../src/protocol.js";

const runtime = { pyodide: "314.0.7", python: "3.14.2", packages: { pandas: "3.0.2" } };
const input: PythonBatchInput = {
  protocol: PYTHON_BATCH,
  kind: "execute",
  submissionId: "sub-1",
  gradeRevision: 1,
  runtime,
  runner: "sha256:runner",
  tests: [{ id: "total", program: "total = 1 + 1", prelude: "", setup: "", data: [], captures: ["total"], doctest: [] }],
};
const result: PythonBatchResult = {
  protocol: PYTHON_BATCH,
  submissionId: "sub-1",
  gradeRevision: 1,
  runtime,
  runner: "sha256:runner",
  freshInterpreter: true,
  tests: [{ id: "total", status: "completed", result: { stdout: "", error: null, captures: { total: { value: 2 } }, doctest: [] } }],
};
const capabilities: PythonCapabilities = { protocol: PYTHON_BATCH, runtime, runner: "sha256:runner", freshInterpreter: true };

type Run = (input: PythonBatchInput, signal?: AbortSignal) => Promise<PythonBatchResult>;

/** 只替换通知订阅和调用的客户端；emit 模拟后端推送的通知，replies 记下前端的 service.reply。 */
function fixture(run: Run) {
  const listeners = new Map<string, Set<(params: unknown) => void>>();
  const replies: unknown[] = [];
  const client = {
    on(method: string, listener: (params: unknown) => void) {
      const set = listeners.get(method) ?? new Set();
      listeners.set(method, set);
      set.add(listener);
      return () => set.delete(listener);
    },
    call(method: string, params: unknown) {
      assert.equal(method, "service.reply");
      replies.push(params);
      return Promise.resolve(null);
    },
  } as unknown as Pick<RepaClient, "on" | "call">;
  const emit = (method: string, params: unknown) => {
    for (const listener of listeners.get(method) ?? []) listener(params);
  };
  const runs: [PythonBatchInput, AbortSignal | undefined][] = [];
  let probes = 0;
  const runner = {
    run: (received: PythonBatchInput, signal?: AbortSignal) => {
      runs.push([received, signal]);
      return run(received, signal);
    },
    capabilities: () => {
      probes += 1;
      return Promise.resolve(capabilities);
    },
  };
  const stop = servePythonRun(client, runner);
  return { emit, replies, runs, probes: () => probes, stop };
}

/** 等所有已排队的回调跑完。 */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test("把 python.run 交给运行器，结果用 service.reply 交回", async () => {
  const { emit, replies, runs } = fixture(() => Promise.resolve(result));
  emit("service.request", { id: "req-1", service: "python.run", input });
  await settled();

  assert.deepEqual(replies, [{ id: "req-1", result }]);
  assert.deepEqual(runs.map(([received]) => received), [input]);
  assert.ok(runs[0]?.[1] instanceof AbortSignal);
});

test("探测交给运行器的 capabilities，不运行代码", async () => {
  const { emit, replies, runs, probes } = fixture(() => Promise.resolve(result));
  emit("service.request", { id: "req-1", service: "python.run", input: { protocol: PYTHON_BATCH, kind: "capabilities" } });
  await settled();

  assert.deepEqual(replies, [{ id: "req-1", result: capabilities }]);
  assert.equal(probes(), 1);
  assert.equal(runs.length, 0);
});

test("输入不符合约定、测试 id 重复或请求了别的服务时直接以错误回复，不运行代码", async () => {
  const { emit, replies, runs } = fixture(() => Promise.resolve(result));
  emit("service.request", { id: "req-1", service: "python.run", input: { ...input, protocol: "repa-python-batch-v0" } });
  emit("service.request", { id: "req-2", service: "r.run", input: {} });
  emit("service.request", { id: "req-3", service: "python.run", input: { ...input, tests: [...input.tests, ...input.tests] } });
  await settled();

  assert.deepEqual(replies, [
    { id: "req-1", error: { code: "invalid_input", message: "python.run 的输入不符合 @repa/python-runner/protocol 的约定" } },
    { id: "req-2", error: { code: "service_unknown", message: "这个前端不提供 r.run" } },
    { id: "req-3", error: { code: "invalid_input", message: "python.run 的测试 id 有重复" } },
  ]);
  assert.equal(runs.length, 0);
});

test("运行器的错误码原样交回", async () => {
  const { emit, replies } = fixture(() => Promise.reject(new PythonRunError("runtime_unavailable", "Pyodide 在 60 秒内没有就绪")));
  emit("service.request", { id: "req-1", service: "python.run", input });
  await settled();

  assert.deepEqual(replies, [{ id: "req-1", error: { code: "runtime_unavailable", message: "Pyodide 在 60 秒内没有就绪" } }]);
});

test("service.closed 停掉对应的运行，不再回复", async () => {
  let signal: AbortSignal | undefined;
  const { emit, replies } = fixture((_input, received) => new Promise((_resolve, reject) => {
    signal = received;
    received?.addEventListener("abort", () => reject(new PythonRunError("cancelled", "运行已取消")));
  }));
  emit("service.request", { id: "req-1", service: "python.run", input });
  emit("service.closed", { id: "req-1", reason: "aborted" });

  assert.equal(signal?.aborted, true);
  await settled();
  assert.deepEqual(replies, []);
});

test("停止服务后不再接新的请求，进行中的运行一并停掉", () => {
  let signal: AbortSignal | undefined;
  const { emit, runs, stop } = fixture((_input, received) => {
    signal = received;
    return new Promise(() => {});
  });
  emit("service.request", { id: "req-1", service: "python.run", input });
  stop();
  emit("service.request", { id: "req-2", service: "python.run", input });

  assert.equal(signal?.aborted, true);
  assert.equal(runs.length, 1);
});
