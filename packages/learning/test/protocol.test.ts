import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Value } from "typebox/value";

import { checkResponse } from "@repa/base/protocol";
import { publicItem, referenceResponse } from "../src/check/items.js";
import { checkSubmission, FeedbackSchema, SubmitResultSchema, type Feedback } from "../src/protocol.js";
import { demoCourse } from "./demo-course.js";

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

async function sampleItem() {
  const topic = demoCourse().topics.t01;
  const question = topic?.kps[0]?.practice?.[2];
  assert.ok(topic && question);
  const item = await publicItem(question, topic);
  return { item, reference: referenceResponse(question, item) };
}

test("平常的作答照底座检查；说“不会”时不带作答，只查题目和版本", async () => {
  const { item, reference } = await sampleItem();
  assert.deepEqual(checkSubmission(item, reference), checkResponse(item, reference));
  assert.equal(checkSubmission(item, { ...reference, answers: {} }).ok, false);

  const dontKnow = { item: reference.item, answers: {}, dontKnow: true as const };
  assert.deepEqual(checkSubmission(item, dontKnow), { ok: true });
  assert.deepEqual(checkSubmission(item, { ...reference, dontKnow: true }), { ok: false, problems: [{ message: "说“不会”时不带作答" }] });
  const stale = checkSubmission(item, { ...dontKnow, item: { id: item.id, version: `sha256:${"0".repeat(64)}` } });
  assert.equal(stale.ok, false);
  assert.equal(checkSubmission(item, { ...dontKnow, dontKnow: false } as never).ok, false);
});

test("反馈和提交结果按约定严格校验，多余字段和不认识的取值被拒", async () => {
  const { item } = await sampleItem();
  const feedback: Feedback = {
    item: { id: item.id, version: item.version },
    verdict: "partial",
    judge: "rule",
    score: { earned: 1, max: 2 },
    message: [{ type: "markdown", text: "第二问再看看。" }],
    slots: {
      line: { verdict: "incorrect", expected: { type: "choice", selected: ["minus"] }, marks: { plus: "incorrect", minus: "missed" } },
      code: { verdict: "correct", tests: [{ name: "公开例子", result: "passed" }, { name: "更多输入", result: "failed", hidden: true }] },
      why: { verdict: "pending", criteria: [{ label: "说出原因", met: "unsure" }] },
    },
  };
  assert.ok(Value.Check(FeedbackSchema, feedback));
  assert.ok(Value.Check(SubmitResultSchema, { status: "recorded", feedback }));
  assert.ok(Value.Check(SubmitResultSchema, { status: "recorded" }));
  assert.ok(Value.Check(SubmitResultSchema, { status: "rejected", problems: [{ slot: "line", message: "请选择一项" }] }));

  assert.equal(Value.Check(FeedbackSchema, { ...feedback, verdict: "excellent" }), false);
  assert.equal(Value.Check(FeedbackSchema, { ...feedback, answer: "minus" }), false);
  assert.equal(Value.Check(SubmitResultSchema, { status: "rejected", problems: [] }), false);
  assert.equal(Value.Check(SubmitResultSchema, { status: "accepted" }), false);
});

/** 收集一个模块在运行时会加载的说明符；只有 import type 的语句在编译后消失，不算。 */
function runtimeImports(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm)) {
    if (match[1] === undefined && match[2] !== undefined) specifiers.push(match[2]);
  }
  for (const match of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) if (match[1] !== undefined) specifiers.push(match[1]);
  return specifiers;
}

/** 从入口出发走遍相对导入，返回全部外部说明符。 */
async function externalImports(entry: string, toFile: (from: string, specifier: string) => string): Promise<Set<string>> {
  const external = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of runtimeImports(await readFile(file, "utf8"))) {
      if (specifier.startsWith(".")) queue.push(toFile(file, specifier));
      else external.add(specifier);
    }
  }
  return external;
}

test("@repa/learning/protocol 在浏览器里也能用：只依赖 typebox 和底座的交互词汇，底座那边也不加载 Node 模块", async () => {
  const learning = await externalImports(path.join(SOURCE, "protocol.ts"), (from, specifier) =>
    path.resolve(path.dirname(from), specifier.replace(/\.js$/, ".ts")));
  assert.deepEqual([...learning].sort(), ["@repa/base/protocol", "typebox", "typebox/value"]);

  const base = fileURLToPath(import.meta.resolve("@repa/base/protocol"));
  const reached = await externalImports(base, (from, specifier) => path.resolve(path.dirname(from), specifier));
  assert.deepEqual([...reached].filter((specifier) => specifier.startsWith("node:") || !specifier.startsWith("typebox")), []);
});
