/**
 * 测试用的前端：连上真实的协议后端，在 capabilities.services 里声明 python.run，按给定的答复交回结果。
 * 它不运行 Python：verify 任务按 program 查表交回算出的作答，用来在任何系统上走“经前端页面核对”这条路的接线；
 * 真的在页面 Worker 里运行由 apps/web 的走查负责。
 */
import type { TestContext } from "node:test";

import { RepaClient } from "@repa/base/client";
import {
  PYTHON_BATCH, PYTHON_RUN, PythonBatchInputSchema, type PythonBatchInput, type PythonBatchResult, type Runtime,
} from "@repa/python-runner/protocol";
import { Value } from "typebox/value";

/** 随包课与写课说明里的运行时，也是页面实际加载的版本。 */
export const PAGE_RUNTIME: Runtime = { pyodide: "314.0.7", python: "3.14.2", packages: { numpy: "2.4.6", pandas: "3.0.2" } };

/** 页面怎样答复一批测试；返回 undefined 时不回应，模拟页面卡住。 */
export type PageReply = (input: PythonBatchInput) => PythonBatchResult | undefined;

/** 按 verify 程序查表交回算出的作答；表里没有的程序记为运行出错。 */
export function verifiedAnswers(answers: Record<string, Record<string, unknown>>, runtime: Runtime = PAGE_RUNTIME): PageReply {
  return (input) => ({
    protocol: PYTHON_BATCH,
    runtime,
    tests: input.tests.map((test) => {
      const found = answers[test.program];
      return {
        id: test.id,
        status: "completed",
        result: {
          stdout: "", captures: {}, doctest: [],
          ...(found ? { error: null, verified: { answers: found, unknown: [] } } : { error: { type: "NameError", message: "测试前端不认识这段程序", line: null } }),
        },
      };
    }),
  });
}

/** 连上后端的测试前端；reply 可以随时换。requests 记下收到的每批测试。 */
export async function pythonFrontend(t: TestContext, connection: { url: string; token: string }, reply: PageReply) {
  const client = await RepaClient.connect(connection, { capabilities: { services: [PYTHON_RUN] } });
  const page = { client, reply, requests: [] as PythonBatchInput[] };
  client.on("service.request", ({ id, service, input }) => {
    if (service !== PYTHON_RUN || !Value.Check(PythonBatchInputSchema, input)) throw new Error(`测试前端收到意外的请求 ${service}`);
    page.requests.push(input);
    const result = page.reply(input);
    if (result) void client.call("service.reply", { id, result });
  });
  t.after(() => client.close());
  return page;
}
