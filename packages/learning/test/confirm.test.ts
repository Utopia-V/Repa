import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { confirmCourse, writeConfirmations, type ModelRequest } from "../src/check/confirm.js";
import { checkCourse } from "../src/check/course.js";
import type { Diagnostic } from "../src/format/diagnostics.js";
import type { Question, Topic } from "../src/format/schema.js";
import { demoCourse, writeCourse, type DemoCourse } from "./demo-course.js";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

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

/** 选项 id 带含义、选项是多行代码、表格有选择格和只有一列要填的文字格、题面代码带行号。 */
function revealingQuestion(): Question {
  return {
    id: "t01.k2.x2",
    kind: ["explain"],
    body: "```python startLine=3\nx = 1\ny = 2\n```\n\n读这段代码，回答下面的问题。",
    slots: [
      {
        id: "why", type: "choice", key: "faithful",
        options: [
          { id: "faithful", content: "```python\nz = 1\nw = 2\n```" },
          { id: "silent", content: "没有任何影响" },
        ],
      },
      { id: "steps", type: "order", items: [{ id: "first", content: "先读" }, { id: "second", content: "再算" }], key: ["first", "second"] },
      {
        id: "verdicts", type: "table",
        columns: [
          { id: "item", header: "项" },
          { id: "verdict", header: "判断", input: { type: "choice", options: [{ id: "pass", label: "通过" }, { id: "fail", label: "不通过" }] } },
          { id: "note", header: "说明", input: "text" },
        ],
        rows: [
          { id: "r1", cells: { item: "x", verdict: "pass", note: "ok" } },
          { id: "r2", cells: { item: "y", verdict: "fail", note: "bad" } },
        ],
      },
      {
        id: "counts", type: "table",
        columns: [{ id: "item", header: "项" }, { id: "n", header: "个数", input: "integer" }],
        rows: [{ id: "r1", cells: { item: "x", n: 1 } }, { id: "r2", cells: { item: "y", n: 2 } }],
      },
    ],
    manual: ["why", "steps", "verdicts", "counts"],
    explanation: "按内容判断。",
  };
}

function revealingDemo(): DemoCourse {
  const demo = demoCourse();
  t01(demo).kps[1]?.quiz?.push(revealingQuestion());
  return demo;
}

test("发给模型的请求：选项 id 换成不透明的编号、多行代码保持原样、选择格显示标签、代码块带行号；模型按编号作答，换回课程里的 id 判分", async (t) => {
  // 示例课程里只有这一道题列了 manual。
  const root = await writeCourse(t, revealingDemo());
  const requests: ModelRequest[] = [];
  const complete = async (request: ModelRequest): Promise<string> => {
    requests.push(request);
    // 单选、排列、选择格用编号作答；只有一列要填的表格用 {行: 值} 的短写法。
    return JSON.stringify({ answers: { why: "a", steps: ["a", "b"], verdicts: { r1: { verdict: "a", note: "ok" }, r2: { verdict: "b", note: "bad" } }, counts: { r1: 1, r2: "2" } } });
  };
  const result = await confirmCourse(root, { complete, model: "deepseek/deepseek-flash", maxRequests: 10, date: "2026-10-12", base: root });
  assert.equal(requests.length, 1);
  const revealing = result.outcomes.find((outcome) => outcome.question === "t01.k2.x2");
  assert.equal(revealing?.status, "confirmed", JSON.stringify(revealing));
  assert.deepEqual(revealing?.aliases?.why, { a: "faithful", b: "silent" });
  assert.deepEqual(revealing?.aliases?.["verdicts#r1/verdict"], { a: "pass", b: "fail" });

  const prompt = requests[0]?.prompt ?? "";
  assert.doesNotMatch(prompt, /faithful|silent|first|second|pass|fail/);
  assert.match(prompt, /- `a`：\n {2}```python\n {2}z = 1\n {2}w = 2\n {2}```/);
  assert.match(prompt, /- `b`：没有任何影响/);
  assert.match(prompt, /- `a`：先读/);
  assert.match(prompt, /待填 r1\/verdict，可选 a（通过）、b（不通过）/);
  assert.match(prompt, /3 \| x = 1\n4 \| y = 2/);
  assert.match(prompt, /### 作答位 verdicts\n表格：答案写成 \{行 id: \{列 id: 值\}\}/);
  assert.match(prompt, /### 作答位 counts\n表格：只有一列要填，答案写成 \{行 id: 值\}/);
});

test("模型答错时，报告里的差异写的是课程里的 id，不是发给模型的编号", async (t) => {
  const root = await writeCourse(t, revealingDemo());
  const complete = async (): Promise<string> =>
    JSON.stringify({ answers: { why: "b", steps: ["b", "a"], verdicts: { r1: { verdict: "b", note: "ok" }, r2: { verdict: "b", note: "bad" } }, counts: { r1: 1, r2: 3 } } });
  const result = await confirmCourse(root, { complete, model: "deepseek/deepseek-flash", maxRequests: 10, base: root });
  const revealing = result.outcomes.find((outcome) => outcome.question === "t01.k2.x2");
  assert.equal(revealing?.status, "disagreed");
  assert.deepEqual(revealing?.differences?.map((difference) => [difference.slot, difference.model]), [
    ["why", "silent"],
    ["steps", ["second", "first"]],
    ["verdicts", { r1: { verdict: "fail", note: "ok" }, r2: { verdict: "fail", note: "bad" } }],
    ["counts", { r1: { n: "1" }, r2: { n: "3" } }],
  ]);
});

test("记录并入写文件那一刻磁盘上的记录：别人刚写进去的不会被覆盖", async (t) => {
  const root = await writeCourse(t, manualDemo());
  const file = path.join(root, "topics", "t01.yaml");
  const record = (question: string, model: string) => ({ question, version: `sha256:${"1".repeat(64)}`, slots: ["output"], model, date: "2026-10-12" });
  await writeConfirmations(file, [record("t01.k1.x1", "model-a")]);
  // 另一个进程在这期间写入了 t01.k2.r1 的记录；这里只带来 t01.k1.x1 的新记录。
  await writeConfirmations(file, [record("t01.k2.r1", "model-b")]);
  await writeConfirmations(file, [record("t01.k1.x1", "model-c")]);
  const { verified } = await topicFile(root);
  assert.deepEqual(verified, [record("t01.k1.x1", "model-c"), record("t01.k2.r1", "model-b")]);
});

/** 运行命令行，返回退出码和输出。 */
async function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, stdout, stderr };
}

test("--log 指定的文件已经存在时，发请求之前就报错，文件原样保留", async (t) => {
  const root = await writeCourse(t, manualDemo());
  const log = path.join(root, "existing.jsonl");
  await writeFile(log, "旧日志\n");
  const before = (await topicFile(root)).text;
  const result = await runCli(["confirm", root, "--agent-dir", path.join(root, "no-agent"), "--log", log]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--log 指定的文件已经存在/);
  assert.doesNotMatch(result.stdout, /共发请求/);
  assert.equal(await readFile(log, "utf8"), "旧日志\n");
  assert.equal((await topicFile(root)).text, before);

  // 文件不存在时 dry-run 照常运行并写出日志。
  const fresh = path.join(root, "fresh.jsonl");
  const dry = await runCli(["confirm", root, "--dry-run", "--log", fresh]);
  assert.equal(dry.code, 0, dry.stderr);
  const lines = (await readFile(fresh, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { question: string; status: string; request?: string });
  assert.deepEqual(lines.map((line) => [line.question, line.status]), [["t01.k1.x1", "skipped"], ["t01.k2.r1", "skipped"]]);
  assert.match(lines[0]?.request ?? "", /## 作答位/);
});
