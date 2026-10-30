/**
 * 检查与判分走同一个入口：同一道题、同一份作答，课程核对（Node 沙箱，整门课一个解释器）和判分（judgeAnswer 经 python.run）
 * 给出相同的结论。判分这边的 python.run 由另一个 Node 沙箱按同一约定提供，代替页面的 Worker；Worker 本身的批次处理由运行器包的测试检查。
 */
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { Host } from "@repa/base/plugin";
import { parse, type Answer } from "@repa/base/protocol";
import { describeRuntime, SandboxRunner } from "@repa/python-runner";
import { PYTHON_BATCH, PythonBatchInputSchema } from "@repa/python-runner/protocol";

import { checkCourse } from "../src/check/course.js";
import { questionVersion, referenceAnswer, topicQuestions } from "../src/check/items.js";
import { mapAnswer, renderDelivery } from "../src/delivery.js";
import { Report, type Diagnostic } from "../src/format/diagnostics.js";
import { loadCourse } from "../src/format/load.js";
import type { CodeSlot, Course, OrderSlot, Question, Topic } from "../src/format/schema.js";
import { judgeAnswer } from "../src/judge.js";
import type { Feedback } from "../src/protocol.js";
import { demoCourse, runtimeUnavailable, writeCourse, type DemoCourse } from "./demo-course.js";
import { skipUnavailableEnvironment } from "./environment.js";

const PYTHON_COURSE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "courses", "python");

function errors(diagnostics: Diagnostic[]): string[] {
  return diagnostics.filter((diagnostic) => diagnostic.severity === "error").map((diagnostic) => diagnostic.code).sort();
}

/** 判分用的前端替身：python.run 交给一个 Node 沙箱，按同一约定运行；返回判分函数和调用次数。 */
async function frontend(t: TestContext, course: Course) {
  const runner = new SandboxRunner({ assets: await describeRuntime(course.runtime) });
  t.after(() => runner.close());
  let calls = 0;
  const host = {
    services: {
      async call(service: string, input: unknown) {
        assert.equal(service, "python.run");
        calls += 1;
        const { tests } = parse(PythonBatchInputSchema, input);
        return { protocol: PYTHON_BATCH, runtime: await runner.start(), tests: await runner.runTests(tests) };
      },
    },
  } as unknown as Host;

  /** 像学习者那样交一份作答，走完整的判分：交付换号，收下时换回课程里的编号，再经 judgeAnswer 判分。 */
  async function grade(topic: Topic, questionId: string, answer: Answer): Promise<Feedback["verdict"]> {
    const entry = topicQuestions(topic).find((candidate) => candidate.question.id === questionId);
    assert.ok(entry, questionId);
    const identity = { deliveryId: "d1", submissionId: "s1", repeated: false };
    const { delivery, idMap } = await renderDelivery(entry.question, topic, entry.kp.id, "practice", identity, 1);
    const slot = entry.question.slots[0];
    const shown = delivery.item.slots.find((candidate) => candidate.id === slot?.id);
    assert.ok(slot && shown);
    const recorded = mapAnswer(mapAnswer(answer, shown, idMap, true), shown, idMap);
    return (await judgeAnswer(host, { ...course, topics: [topic.id] }, entry.question, topic, { answers: { [slot.id]: recorded } })).verdict;
  }
  return { grade, calls: () => calls };
}

function question(demo: DemoCourse, id: string): Question {
  const found = Object.values(demo.topics).flatMap((topic) => topicQuestions(topic)).find((entry) => entry.question.id === id)?.question;
  assert.ok(found, id);
  return found;
}

const t01 = (demo: DemoCourse): Topic => {
  assert.ok(demo.topics.t01);
  return demo.topics.t01;
};

test("同一道题的参考答案和错误写法，经检查和判分得到相同的结论；一次判分只调用一次 python.run", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return skipUnavailableEnvironment(t, reason);
  const demo = demoCourse();
  const root = await writeCourse(t, demo);
  assert.deepEqual(errors((await checkCourse(root, { base: root })).diagnostics), []);
  // 核对通过，说明参考答案、等价写法判对，初始代码和错误写法判错；判分对每一份给出同样的结论。
  const { grade, calls } = await frontend(t, demo.course);
  const code = question(demo, "t01.k2.q1").slots[0] as CodeSlot;
  const expected: [Answer, Feedback["verdict"]][] = [
    [referenceAnswer(code), "correct"],
    ...(code.accepts ?? []).map((accepted): [Answer, Feedback["verdict"]] => [{ type: "code", code: accepted }, "correct"]),
    [{ type: "code", code: code.starter }, "incorrect"],
    ...(code.rejects ?? []).map((rejected): [Answer, Feedback["verdict"]] => [{ type: "code", code: rejected.code }, "incorrect"]),
  ];
  for (const [answer, verdict] of expected) assert.equal(await grade(t01(demo), "t01.k2.q1", answer), verdict, JSON.stringify(answer));
  const parsons = question(demo, "t01.k2.q2").slots[0] as OrderSlot;
  assert.equal(await grade(t01(demo), "t01.k2.q2", referenceAnswer(parsons)), "correct");
  // 用了 > 而不是 >=：恰好等于 limit 的不算。
  const wrong = parsons.key.map((id) => (id === "b4" ? "b7" : id));
  assert.equal(await grade(t01(demo), "t01.k2.q2", { type: "order", items: wrong, indents: wrong.map((id) => parsons.indents?.[id] ?? 0) }), "incorrect");
  assert.equal(calls(), expected.length + 2);

  // 反过来：一份“错误写法”其实是对的，核对报出它通过了全部测试，判分同样判它对。
  code.rejects = [{ code: "def double(x):\n    return 2 * x\n", why: "其实是对的" }];
  const changed = await writeCourse(t, demo);
  assert.deepEqual(errors((await checkCourse(changed, { base: changed })).diagnostics), ["reject_passed"]);
  assert.equal(await grade(t01(demo), "t01.k2.q1", { type: "code", code: "def double(x):\n    return 2 * x\n" }), "correct");
});

test("随包课程里比较 DataFrame 的代码题：检查与判分对参考答案和每种错误写法的结论相同", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return skipUnavailableEnvironment(t, reason);
  const check = await checkCourse(PYTHON_COURSE, { base: PYTHON_COURSE, topics: ["py17"] });
  assert.deepEqual(errors(check.diagnostics), []);
  const loaded = await loadCourse(PYTHON_COURSE, new Report());
  const topic = loaded?.topics.find((entry) => entry.topic.id === "py17")?.topic;
  assert.ok(loaded && topic);
  const code = topicQuestions(topic).find((entry) => entry.question.id === "py17.k2.q3")?.question.slots[0];
  assert.ok(code?.type === "code");
  const { grade } = await frontend(t, loaded.course);
  assert.equal(await grade(topic, "py17.k2.q3", referenceAnswer(code)), "correct");
  for (const rejected of code.rejects ?? []) {
    assert.equal(await grade(topic, "py17.k2.q3", { type: "code", code: rejected.code }), "incorrect", rejected.why);
  }
});

test("课程文件换成 CRLF 换行后，检查照样通过，题目版本不变，判分可用、结论不变", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return skipUnavailableEnvironment(t, reason);
  const demo = demoCourse();
  const lf = await writeCourse(t, demo);
  const crlf = await writeCourse(t, demo);
  for (const file of ["course.yaml", ...(await readdir(path.join(crlf, "topics"))).map((name) => path.join("topics", name))]) {
    const target = path.join(crlf, file);
    await writeFile(target, (await readFile(target, "utf8")).replace(/\n/g, "\r\n"));
  }
  assert.match(await readFile(path.join(crlf, "topics", "t01.yaml"), "utf8"), /\r\n/);
  assert.deepEqual(errors((await checkCourse(crlf, { base: crlf })).diagnostics), []);

  const [fromLf, fromCrlf] = await Promise.all([loadCourse(lf, new Report()), loadCourse(crlf, new Report())]);
  const topic = (loaded: typeof fromLf) => loaded?.topics.find((entry) => entry.topic.id === "t01")?.topic;
  const lfTopic = topic(fromLf);
  const crlfTopic = topic(fromCrlf);
  assert.ok(lfTopic && crlfTopic && fromCrlf);
  const versions = async (source: Topic) => Promise.all(topicQuestions(source).map((entry) => questionVersion(entry.question, source)));
  assert.deepEqual(await versions(crlfTopic), await versions(lfTopic));

  const { grade } = await frontend(t, fromCrlf.course);
  const code = question(demo, "t01.k2.q1").slots[0] as CodeSlot;
  assert.equal(await grade(crlfTopic, "t01.k2.q1", referenceAnswer(code)), "correct");
  assert.equal(await grade(crlfTopic, "t01.k2.q1", { type: "code", code: code.rejects?.[0]?.code ?? "" }), "incorrect");
});

test("学习者的程序设随机种子、写文件、改环境变量，影响不到期望值：判分先算期望值，核对时后面的题也看不到这些改动", async (t) => {
  const reason = await runtimeUnavailable();
  if (reason) return skipUnavailableEnvironment(t, reason);
  // 期望值读环境变量、文件和随机数。程序之后才算的话，会读到程序留下的 ("1", True, True)。
  const observe = '(__import__("os").environ.get("LEAK", "clean"), __import__("os").path.exists("leak.txt"), __import__("random").random() == __import__("random").Random(0).random())';
  const leaky = 'import os, random\nos.environ["LEAK"] = "1"\nopen("leak.txt", "w").write("x")\nrandom.seed(0)\nstate = ("clean", False, False)';
  const looking = `import os, random\nos.environ["LEAK"] = "1"\nopen("leak.txt", "w").write("x")\nrandom.seed(0)\nstate = ${observe}`;
  const codeQuestion = (id: string, solution: string): Question => ({
    id,
    body: "让 `state` 记下运行环境。",
    explanation: "见题面。",
    slots: [{
      id: "code", type: "code", language: "python", starter: "state = None", solution,
      tests: [{ name: "第一次", expect: { state: observe } }, { name: "第二次", hidden: true, expect: { state: observe } }],
    }],
  });
  const demo = demoCourse();
  const kp = t01(demo).kps[1];
  assert.ok(kp?.practice);
  // 第一道题的参考答案留下改动；第二道题的期望值在它之后、同一个解释器里算出。
  kp.practice.push(codeQuestion("t01.k2.q4", leaky), codeQuestion("t01.k2.q5", 'state = ("clean", False, False)'));
  const root = await writeCourse(t, demo);
  const check = await checkCourse(root, { base: root });
  assert.deepEqual(errors(check.diagnostics), []);
  assert.equal(check.summary.code.interpreterStarts, 1);

  const { grade } = await frontend(t, demo.course);
  assert.equal(await grade(t01(demo), "t01.k2.q4", { type: "code", code: leaky }), "correct");
  // 对照：同样的改动确实能被程序自己看到，所以上面的期望值没有受它影响。
  assert.equal(await grade(t01(demo), "t01.k2.q4", { type: "code", code: looking }), "incorrect");
});
