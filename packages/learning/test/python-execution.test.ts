import assert from "node:assert/strict";
import test from "node:test";
import { RepaFault } from "@repa/base";
import { createPluginTestHost } from "@repa/base/testing";
import type { Host } from "@repa/base/plugin";
import { compareProgram, executePython, pythonAvailable } from "../src/python-execution.js";
import { PYTHON_BATCH, type PythonBatchInput } from "@repa/python-runner/protocol";

const input: PythonBatchInput = {
  protocol: PYTHON_BATCH,
  kind: "execute",
  submissionId: "original",
  gradeRevision: 1,
  runtime: { pyodide: "314.0.7", python: "3.14.2", packages: {} },
  runner: "runner-version",
  tests: ["a", "b", "c"].map((id) => ({
    id,
    program: "x=2",
    prelude: "",
    setup: "",
    data: [],
    captures: ["x"],
    doctest: [],
  })),
};
const result = () => ({
  protocol: PYTHON_BATCH,
  submissionId: input.submissionId,
  gradeRevision: input.gradeRevision,
  runtime: input.runtime,
  runner: input.runner,
  freshInterpreter: true,
  tests: input.tests.map((test) => ({
    id: test.id,
    status: "completed",
    result: { stdout: "", error: null, captures: { x: { value: { t: "int", v: "2" } } }, doctest: [] },
  })),
});
const failure = (error: unknown) => error instanceof RepaFault && error.code === "service_failed";

test("整批终止区分学习者超时和未执行，环境阶段超时、版本不符与残缺结果均待恢复", async (t) => {
  let response: unknown = result();
  let captured: Host | undefined;
  const fixture = await createPluginTestHost({
    plugins: [
      {
        id: "python-test",
        async open(host) {
          captured = host;
          return {};
        },
      },
    ],
    services: {
      async call(service, request) {
        assert.equal(service, "python.run");
        assert.deepEqual(request, input);
        return response;
      },
    },
  });
  t.after(() => fixture.close());
  assert.ok(captured);
  assert.equal((await executePython(captured, input)).tests.length, 3);
  response = {
    ...result(),
    tests: [result().tests[0], { id: "b", status: "timeout", phase: "program" }, { id: "c", status: "not_run" }],
  };
  assert.equal((await executePython(captured, input)).tests[1]?.status, "timeout");
  for (const invalid of [
    { ...result(), runner: "different" },
    { ...result(), submissionId: "different" },
    { ...result(), gradeRevision: 99 },
    { ...result(), runtime: { ...input.runtime, python: "0" } },
    { ...result(), tests: result().tests.slice(0, 2) },
    {
      ...result(),
      tests: [result().tests[0], { id: "b", status: "failed", phase: "program" }, { id: "c", status: "not_run" }],
    },
    {
      ...result(),
      tests: [result().tests[0], { id: "b", status: "timeout", phase: "prepare" }, { id: "c", status: "not_run" }],
    },
    {
      ...result(),
      tests: [result().tests[0], { id: "b", status: "timeout", phase: "cleanup" }, { id: "c", status: "not_run" }],
    },
    { ...result(), tests: [result().tests[0], { id: "b", status: "not_run" }, result().tests[2]] },
  ]) {
    response = invalid;
    await assert.rejects(executePython(captured, input), failure);
  }
});

test("前端报告的环境不含 prelude：探测和执行只比较 Pyodide、Python 与包版本", async (t) => {
  const course = { pyodide: "314.0.7", python: "3.14.2", packages: { pandas: "3.0.2" }, prelude: "import pandas as pd" };
  const actual = { pyodide: "314.0.7", python: "3.14.2", packages: { pandas: "3.0.2" } };
  let response: unknown;
  let captured: Host | undefined;
  const fixture = await createPluginTestHost({
    plugins: [{ id: "python-test", async open(host) { captured = host; return {}; } }],
    services: { call: async () => response },
  });
  t.after(() => fixture.close());
  assert.ok(captured);

  response = { protocol: PYTHON_BATCH, runtime: actual, runner: "sha256:runner", freshInterpreter: true };
  assert.equal(await pythonAvailable(captured, course, "sha256:runner"), true);
  assert.equal(await pythonAvailable(captured, course, "sha256:other"), false);
  response = { protocol: PYTHON_BATCH, runtime: { ...actual, packages: { pandas: "2.0.0" } }, runner: "sha256:runner", freshInterpreter: true };
  assert.equal(await pythonAvailable(captured, course, "sha256:runner"), false);

  response = result();
  assert.equal((await executePython(captured, { ...input, runtime: { ...input.runtime, prelude: "import pandas as pd" } })).tests.length, 3);
});

test("比较在后端完成：缺 capture/doctest 和 too_large 不是学习失败，学习者异常与错误输出才判错", () => {
  const test = { name: "值与显示", expect: { x: "2" }, doctest: ">>> x\n2" };
  const passed = {
    stdout: "",
    error: null,
    captures: { x: { value: { t: "int", v: "2" } } },
    doctest: [{ out: "2\n", exception: null }],
  };
  assert.equal(compareProgram(test, { x: { t: "int", v: "2" } }, passed), true);
  assert.equal(compareProgram(test, { x: { t: "int", v: "3" } }, passed), false);
  assert.equal(
    compareProgram(test, { x: { t: "int", v: "2" } }, { ...passed, error: { type: "ValueError", message: "bad" } }),
    false,
  );
  assert.throws(() => compareProgram(test, {}, passed), failure);
  assert.throws(() => compareProgram(test, { x: 2 }, { ...passed, doctest: [] }), failure);
  assert.throws(
    () =>
      compareProgram(test, { x: 2 }, { ...passed, captures: { x: { value: { t: "list", v: [{ t: "too_large" }] } } } }),
    failure,
  );
});
