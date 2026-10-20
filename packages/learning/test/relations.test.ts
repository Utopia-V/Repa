import assert from "node:assert/strict";
import test from "node:test";

import { contentVersion } from "@repa/base/protocol";

import { confirmationVersion, currentConfirmation, confirmCourse } from "../src/check/confirm.js";
import { checkCourse } from "../src/check/course.js";
import { legacyVersionInput, questionCredit, questionVersion } from "../src/check/items.js";
import { Report } from "../src/format/diagnostics.js";
import { loadCourse } from "../src/format/load.js";
import type { Confirmation, Question, Topic } from "../src/format/schema.js";
import { demoCourse, writeCourse, type DemoCourse } from "./demo-course.js";

function topic(demo: DemoCourse, id: string): Topic {
  const found = demo.topics[id];
  assert.ok(found);
  return found;
}

function question(owner: Topic): Question {
  const found = owner.kps[0]?.practice?.[0];
  assert.ok(found);
  return found;
}

function relations(): DemoCourse {
  const demo = demoCourse();
  demo.course.topics.push("t03", "t04");
  for (const id of ["t03", "t04"]) {
    demo.topics[id] = {
      id, title: id, status: "outline", minutes: 10,
      prerequisites: id === "t03" ? ["t02"] : [],
      sources: [], kps: [{ id: `${id}.k1`, title: "第一项" }, { id: `${id}.k2`, title: "第二项" }],
    };
  }
  const third = topic(demo, "t03");
  const kp = third.kps[0];
  assert.ok(kp);
  kp.keyPrerequisites = ["t01"];
  kp.practice = [{ ...structuredClone(question(topic(demo, "t01"))), id: "t03.k1.q1", uses: ["t04.k1"] }];
  third.encompassings = [{ topic: "t04", weight: 0.5 }];
  demo.course.retiredIds = [];
  return demo;
}

async function errors(t: Parameters<typeof writeCourse>[0], demo: DemoCourse): Promise<string[]> {
  const root = await writeCourse(t, demo);
  const result = await checkCourse(root, { run: false });
  return result.diagnostics.map((entry) => entry.code).sort();
}

test("纯先修不带信用，KP 可指定跳层补救，覆盖和 uses 可指向非祖先", async (t) => {
  const demo = relations();
  assert.deepEqual(topic(demo, "t02").prerequisites, ["t01"]);
  assert.equal(topic(demo, "t02").encompassings, undefined);
  assert.deepEqual(await errors(t, demo), []);
  const root = await writeCourse(t, demo);
  const loaded = await loadCourse(root, new Report());
  const third = loaded?.topics.find((entry) => entry.topic.id === "t03")?.topic;
  assert.deepEqual(third?.kps[0]?.keyPrerequisites, ["t01"]);
  assert.deepEqual(third?.encompassings, [{ topic: "t04", weight: 0.5 }]);
});

test("先修环和覆盖环各自报告，二图联合成环不算各图成环", async (t) => {
  const demo = relations();
  topic(demo, "t01").encompassings = [{ topic: "t03", weight: 1 }];
  assert.deepEqual(await errors(t, demo), []);
  topic(demo, "t01").prerequisites = ["t03"];
  assert.deepEqual(await errors(t, demo), ["prerequisites_cycle"]);
  topic(demo, "t04").encompassings = [{ topic: "t03", weight: 0.5 }];
  assert.deepEqual(await errors(t, demo), ["encompassings_cycle", "prerequisites_cycle"]);
});

test("零权重可声明但仍检查覆盖图的引用、重复和环", async (t) => {
  const demo = relations();
  const third = topic(demo, "t03");
  third.encompassings = [{ topic: "t04", weight: 0 }];
  assert.deepEqual(await errors(t, demo), []);
  topic(demo, "t04").encompassings = [{ topic: "t03", weight: 0 }];
  assert.deepEqual(await errors(t, demo), ["encompassings_cycle"]);
  delete topic(demo, "t04").encompassings;
  third.encompassings.push({ topic: "t04", weight: 0 }, { topic: "t09", weight: 0 });
  assert.deepEqual(await errors(t, demo), ["encompassings_duplicate", "encompassings_unknown"]);
});

test("两图拒绝自指，先修重复与覆盖权重越界被拒绝", async (t) => {
  const demo = relations();
  topic(demo, "t04").prerequisites = ["t04", "t01", "t01"];
  topic(demo, "t04").encompassings = [{ topic: "t04", weight: 1 }];
  assert.deepEqual(await errors(t, demo), ["encompassings_self", "prerequisites_duplicate", "prerequisites_self"]);
  for (const weight of [-0.01, 1.01]) {
    const invalid = relations();
    topic(invalid, "t03").encompassings = [{ topic: "t04", weight }];
    assert.ok((await errors(t, invalid)).includes("schema"));
  }
});

test("关键先修必须存在于先修祖先且不能重复，不把独立覆盖当成补救资格", async (t) => {
  const demo = relations();
  const first = topic(demo, "t03").kps[0];
  assert.ok(first);
  first.keyPrerequisites = ["t01", "t01", "t04", "t09", "t03"];
  assert.deepEqual(await errors(t, demo), [
    "key_prerequisite_duplicate", "key_prerequisite_not_ancestor", "key_prerequisite_not_ancestor", "key_prerequisite_not_ancestor",
  ]);
});

test("直接考查只归本 topic，uses 引用其他子技能，二者分别去重并拒绝重叠", async (t) => {
  const demo = relations();
  const q = question(topic(demo, "t01"));
  q.measures = ["t04.k1", "t01.k1", "t01.k1"];
  q.uses = ["t01.k1", "t04.k9", "t04.k9"];
  assert.deepEqual(await errors(t, demo), [
    "kp_reference_duplicate", "kp_reference_duplicate", "kp_unknown", "kp_unknown", "measures_other_topic", "uses_measured",
  ]);
});

test("当前 topic、KP、题目均不能复用退役 id，未使用的退役 id 不阻断", async (t) => {
  const demo = relations();
  demo.course.retiredIds = ["t01", "t01.k1", "t01.k1.q1", "t09.k1"];
  assert.deepEqual(await errors(t, demo), ["retired_id", "retired_id", "retired_id"]);
  demo.course.retiredIds = ["t09.k1"];
  assert.deepEqual(await errors(t, demo), []);
  const first = topic(demo, "t01").kps[0];
  assert.ok(first);
  first.id = "t02.k1";
  assert.ok((await errors(t, demo)).includes("kp_id_prefix"));
});

test("信用归属改变题目版本，集合顺序与显式缺省不改变版本", async () => {
  const owner = topic(relations(), "t01");
  const q = question(owner);
  const original = await questionVersion(q, owner);
  assert.equal(await questionVersion({ ...q, measures: ["t01.k1"], uses: [] }, owner), original);
  const changed = { ...q, measures: ["t01.k1", "t01.k2"], uses: ["t04.k1", "t04.k2"] };
  assert.notEqual(await questionVersion(changed, owner), original);
  assert.equal(await questionVersion({ ...changed, measures: ["t01.k2", "t01.k1"], uses: ["t04.k2", "t04.k1"] }, owner), await questionVersion(changed, owner));
  assert.notEqual(await questionVersion({ ...q, uses: ["t04.k1"] }, owner), original);
  assert.notEqual(await questionVersion({ ...q, measures: ["t01.k2"] }, owner), original);
  assert.deepEqual(questionCredit(q), { measures: ["t01.k1"], uses: [] });
});

test("核对范围绑定答案、题面、数据和运行依赖；信用、题型及检查元数据不使证明失效", async () => {
  const demo = relations();
  const owner = topic(demo, "t01");
  const q = question(owner);
  q.manual = ["output"];
  const version = await confirmationVersion(q, owner, demo.course.runtime);
  const record: Confirmation = {
    question: q.id, version, scope: "question-runtime-v1", slots: ["output"], model: "local/test", date: "2026-10-20",
  };
  owner.verified = [record];
  const changed: Question = { ...q, uses: ["t04.k1"], kind: ["debug"], verify: "answers = {}" };
  assert.equal(await currentConfirmation(owner, changed, demo.course.runtime), record);
  assert.equal(await currentConfirmation(owner, { ...q, body: "新题面" }, demo.course.runtime), undefined);
  assert.equal(await currentConfirmation(owner, { ...q, slots: [{ id: "output", type: "text", key: 99 }] }, demo.course.runtime), undefined);
  assert.equal(await currentConfirmation(owner, q, { ...demo.course.runtime, prelude: "x = 1" }), undefined);
  assert.equal(await currentConfirmation(owner, q, { ...demo.course.runtime, packages: { pandas: "99.0.0" } }), undefined);
  assert.equal(await currentConfirmation(owner, { ...q, manual: ["other"] }, demo.course.runtime), undefined);
  const withData = { ...q, data: ["nums"] };
  owner.verified = [{ ...record, version: await confirmationVersion(withData, owner, demo.course.runtime) }];
  assert.ok(await currentConfirmation(owner, withData, demo.course.runtime));
  const nums = owner.data?.nums;
  assert.ok(nums?.kind === "dataframe");
  nums.columns.value = [99];
  assert.equal(await currentConfirmation(owner, withData, demo.course.runtime), undefined);
});

test("旧证明只有原算法重算相同且运行环境等于冻结基线时才复用，原记录保留", async () => {
  const demo = relations();
  const owner = topic(demo, "t01");
  const q = question(owner);
  q.manual = ["output"];
  const runtime = { ...demo.course.runtime, prelude: "import pandas as pd\nimport numpy as np\n" };
  const record: Confirmation = {
    question: q.id, version: await contentVersion(legacyVersionInput(q, owner)), slots: ["output"], model: "legacy/test", date: "2026-10-12",
  };
  owner.verified = [record];
  assert.equal(await currentConfirmation(owner, q, runtime), record);
  assert.equal(await currentConfirmation(owner, { ...q, uses: ["t04.k1"] }, runtime), record);
  assert.equal(await currentConfirmation(owner, { ...q, body: "新题面" }, runtime), undefined);
  assert.equal(await currentConfirmation(owner, { ...q, slots: [{ id: "output", type: "text", key: 99 }] }, runtime), undefined);
  assert.equal(await currentConfirmation(owner, q, demo.course.runtime), undefined);
  assert.equal(await currentConfirmation(owner, q, { ...runtime, python: "3.14.3" }), undefined);
  assert.deepEqual(owner.verified, [record]);
});


test("课程检查与核对入口复用原证明，单改信用不发请求，单改答案要求重新核对", async (t) => {
  const demo = relations();
  const owner = topic(demo, "t01");
  const quiz = owner.kps[0]?.quiz?.[0];
  assert.ok(quiz);
  demo.course.runtime.prelude = "import pandas as pd\nimport numpy as np\n";
  delete quiz.verify;
  quiz.manual = ["output"];
  owner.verified = [{
    question: quiz.id,
    version: await contentVersion(legacyVersionInput(quiz, owner)),
    slots: ["output"], model: "legacy/test", date: "2026-10-12",
  }];
  const original = await questionVersion(quiz, owner);
  quiz.uses = ["t04.k1"];
  assert.notEqual(await questionVersion(quiz, owner), original);
  assert.deepEqual(await errors(t, demo), []);
  const root = await writeCourse(t, demo);
  const confirmed = await confirmCourse(root, {
    complete: async () => { throw new Error("已有原证明，不应调用模型"); },
    model: "local/unused", maxRequests: 1,
  });
  assert.equal(confirmed.requests, 0);
  assert.equal(confirmed.outcomes[0]?.status, "skipped");
  const answer = quiz.slots[0];
  assert.ok(answer?.type === "text");
  answer.key = 99;
  assert.deepEqual(await errors(t, demo), ["manual_unconfirmed"]);
});
