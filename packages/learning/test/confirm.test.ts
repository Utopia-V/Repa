import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { parse } from "yaml";

import { confirmCourse, type ModelRequest } from "../src/check/confirm.js";
import { checkCourse } from "../src/check/course.js";
import type { Diagnostic } from "../src/format/diagnostics.js";
import type { Topic } from "../src/format/schema.js";
import { demoCourse, writeCourse, type DemoCourse } from "./demo-course.js";

function codes(diagnostics: Diagnostic[]): string[] {
  return diagnostics.filter((diagnostic) => diagnostic.severity === "error").map((diagnostic) => diagnostic.code).sort();
}

function t01(demo: DemoCourse): Topic {
  const topic = demo.topics.t01;
  assert.ok(topic);
  return topic;
}

/** 示例课程里把一道测验题和一道复习题改成要模型核对：程序不再核对，答案列进 manual。 */
function manualDemo(): DemoCourse {
  const demo = demoCourse();
  const [first, second] = t01(demo).kps;
  const quiz = first?.quiz?.[0];
  const review = second?.review?.[0];
  assert.ok(quiz && review);
  delete quiz.verify;
  quiz.manual = ["output"];
  delete review.verify;
  review.manual = ["rows", "equal"];
  return demo;
}

/** 按题目 id 给出固定输出的假模型，记下收到的请求。 */
function fakeModel(outputs: Record<string, string[]>) {
  const requests: ModelRequest[] = [];
  const complete = async (request: ModelRequest): Promise<string> => {
    requests.push(request);
    const id = /t01\.k1\.x1/.test(request.prompt) || /d = d \+ d/.test(request.prompt) ? "t01.k1.x1" : "t01.k2.r1";
    const next = outputs[id]?.shift();
    assert.ok(next !== undefined, `没有为 ${id} 准备输出`);
    return next;
  };
  return { complete, requests };
}

const RIGHT = {
  "t01.k1.x1": '{"answers": {"output": 2}}',
  "t01.k2.r1": '```json\n{"answers": {"rows": ["b", "c"], "equal": ["c"]}}\n```',
};

async function topicFile(root: string): Promise<{ text: string; verified: unknown }> {
  const text = await readFile(path.join(root, "topics", "t01.yaml"), "utf8");
  return { text, verified: (parse(text) as Topic).verified };
}

test("复习和测验题的 manual 作答位没有核对记录时检查不通过，练习题不强制", async (t) => {
  const demo = manualDemo();
  const practice = t01(demo).kps[0]?.practice?.[0];
  assert.ok(practice);
  delete practice.verify;
  practice.manual = ["output"];
  const root = await writeCourse(t, demo);
  const result = await checkCourse(root, { run: false, base: root });
  assert.deepEqual(codes(result.diagnostics), ["manual_unconfirmed", "manual_unconfirmed"]);
  assert.deepEqual(result.summary.confirmationSlots, ["t01.k1.x1/output", "t01.k2.r1/rows", "t01.k2.r1/equal"]);
});

test("模型独立解出的答案与标准答案一致时写入记录，之后检查通过；请求里没有答案和解析", async (t) => {
  const root = await writeCourse(t, manualDemo());
  const before = (await topicFile(root)).text;
  const model = fakeModel({ "t01.k1.x1": [RIGHT["t01.k1.x1"]], "t01.k2.r1": [RIGHT["t01.k2.r1"]] });
  const result = await confirmCourse(root, { complete: model.complete, model: "deepseek/deepseek-flash", maxRequests: 10, date: "2026-10-12", base: root });
  assert.deepEqual(result.outcomes.map((outcome) => [outcome.question, outcome.status]), [["t01.k1.x1", "confirmed"], ["t01.k2.r1", "confirmed"]]);
  assert.equal(result.requests, 2);
  for (const request of model.requests) {
    assert.doesNotMatch(request.prompt, /显示 2。|b、c；恰好等于 5 的是 c|verify|key/);
  }
  assert.match(model.requests[1]?.prompt ?? "", /value/);

  const after = await topicFile(root);
  assert.ok(after.text.startsWith(before.trimEnd()), "topic 文件原有内容不变，记录追加在末尾");
  assert.deepEqual(after.verified, result.outcomes.map((outcome) => ({
    question: outcome.question, version: outcome.version, slots: outcome.slots, model: "deepseek/deepseek-flash", date: "2026-10-12",
  })));
  const check = await checkCourse(root, { run: false, base: root });
  assert.deepEqual(check.diagnostics, []);

  // 已有当前版本的记录就不再发请求。
  const again = await confirmCourse(root, { complete: fakeModel({}).complete, model: "deepseek/deepseek-flash", maxRequests: 10, base: root });
  assert.deepEqual(again.outcomes.map((outcome) => outcome.status), ["skipped", "skipped"]);
  assert.equal(again.requests, 0);
});

test("模型的答案与标准答案不一致时列出差异，不写记录", async (t) => {
  const root = await writeCourse(t, manualDemo());
  const model = fakeModel({ "t01.k1.x1": [RIGHT["t01.k1.x1"]], "t01.k2.r1": ['{"answers": {"rows": ["b", "c"], "equal": []}}'] });
  const result = await confirmCourse(root, { complete: model.complete, model: "deepseek/deepseek-flash", maxRequests: 10, base: root });
  const disagreed = result.outcomes.find((outcome) => outcome.question === "t01.k2.r1");
  assert.equal(disagreed?.status, "disagreed");
  assert.deepEqual(disagreed?.differences, [{ slot: "equal", model: [], key: ["c"] }]);
  const { verified } = await topicFile(root);
  assert.deepEqual((verified as { question: string }[]).map((record) => record.question), ["t01.k1.x1"]);
  const check = await checkCourse(root, { run: false, base: root });
  assert.deepEqual(codes(check.diagnostics), ["manual_unconfirmed"]);
});

test("输出不合格式时重试一次，仍不行就交给人看；请求数不超过上限", async (t) => {
  const root = await writeCourse(t, manualDemo());
  const model = fakeModel({ "t01.k1.x1": ["答案是 2", '{"answers": {"value": 2}}'] });
  const result = await confirmCourse(root, { complete: model.complete, model: "deepseek/deepseek-flash", maxRequests: 2, base: root });
  assert.deepEqual(result.outcomes.map((outcome) => [outcome.status, outcome.requests]), [["unusable", 2], ["skipped", 0]]);
  assert.match(model.requests[1]?.prompt ?? "", /上一次的输出不符合要求/);
  assert.match(result.outcomes[1]?.detail ?? "", /请求上限/);
  assert.equal(result.requests, 2);
  assert.equal((await topicFile(root)).verified, undefined);
});

test("题目改过后旧记录不再算数，检查提示重新核对；记录指向不存在的题时报出", async (t) => {
  const root = await writeCourse(t, manualDemo());
  const model = fakeModel({ "t01.k1.x1": [RIGHT["t01.k1.x1"]], "t01.k2.r1": [RIGHT["t01.k2.r1"]] });
  await confirmCourse(root, { complete: model.complete, model: "deepseek/deepseek-flash", maxRequests: 10, base: root });
  const { verified } = await topicFile(root);

  const demo = manualDemo();
  const topic = t01(demo);
  const quiz = topic.kps[0]?.quiz?.[0];
  assert.ok(quiz);
  quiz.body = "程序显示什么？\n\n```python\nd = 1\nd = d + d + d\nprint(d)\n```";
  quiz.slots = [{ id: "output", type: "text", format: "integer", key: 3 }];
  topic.verified = [...(verified as NonNullable<Topic["verified"]>), { question: "t01.k1.x9", version: `sha256:${"0".repeat(64)}`, slots: ["output"], model: "deepseek/deepseek-flash", date: "2026-10-12" }];
  const changed = await writeCourse(t, demo);
  const result = await checkCourse(changed, { run: false, base: changed });
  assert.deepEqual(codes(result.diagnostics), ["manual_unconfirmed", "verified_unknown"]);
  assert.match(result.diagnostics.find((diagnostic) => diagnostic.code === "manual_unconfirmed")?.message ?? "", /旧版本/);
});
