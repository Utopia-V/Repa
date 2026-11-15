/**
 * 展开任务里“学习者在这之前学到的概念”的规模：更早的部分按先修图由近到远列到上限为止，其余只给个数和怎样取。
 * 经后端与 faux 模型的整条路见 growing-course.test.ts；这里只验证清单的取舍，课程直接在内存里造。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedCourse } from "../src/course-sources.js";
import { EARLIER_CONCEPTS, expansionBrief } from "../src/expansion-brief.js";
import type { Topic } from "../src/format/schema.js";

/** 一个三知识点的 topic；complete 时每个知识点有概念卡。 */
function topic(id: string, prerequisites: string[], status: Topic["status"] = "complete"): Topic {
  return {
    id, title: `标题${id}`, status, minutes: 15, prerequisites, sources: [],
    kps: [1, 2, 3].map((index) => ({
      id: `${id}.k${index}`, title: `知识点${id}.${index}`,
      ...(status === "complete" ? { card: { name: `概念${id}.${index}`, definition: `定义${id}.${index}`, conditions: ["条件"], example: { from: `${id}.k${index}.q1`, text: "例子" } } } : {}),
    })),
  };
}

function course(topics: Topic[]): ResolvedCourse {
  return {
    course: { id: "chain", version: "1.0.0", title: "一条链", language: "zh-CN", license: "NOASSERTION", sources: {}, topics: topics.map((entry) => entry.id) },
    topics,
    origins: {},
  };
}

test("更早的概念超过上限：按先修图由近到远列整个部分，学过而不是先修的排在先修之后，其余只写个数和怎样取", () => {
  // t01 → t02 → … → t49 一条先修链，另有学过但不在链上的 side；要展开 t50，它的直接先修是 t49。
  const chain = Array.from({ length: 50 }, (_, index) => {
    const id = `t${String(index + 1).padStart(2, "0")}`;
    return topic(id, index === 0 ? [] : [`t${String(index).padStart(2, "0")}`], index === 49 ? "outline" : "complete");
  });
  const side = topic("side", []);
  const text = expansionBrief(course([side, ...chain]), ["t50"], new Set(["side", ...chain.slice(0, 49).map((entry) => entry.id)]));

  // 直接先修带定义；更早的 t48 往前，每个三个概念，列到上限能放下的整数个部分为止。
  assert.match(text, /\n直接先修 t49「标题t49」：\n- t49\.k1 概念t49\.1：定义t49\.1\n/u);
  const listed = Math.floor(EARLIER_CONCEPTS / 3);
  const shown = [...text.matchAll(/^- (\w+)「/gmu)].map((match) => match[1]);
  assert.deepEqual(shown, Array.from({ length: listed }, (_, index) => `t${String(48 - listed + 1 + index).padStart(2, "0")}`));
  assert.doesNotMatch(text, /定义t48/u);
  // 没列出的：链上更远的部分和不在链上的 side。
  const omitted = 48 - listed + 1;
  assert.match(text, new RegExp(`\\n另有 ${omitted} 个更早的部分（共 ${omitted * 3} 个概念）没有列出；要查时用 grep 在 course/topics/ 里搜概念名`, "u"));
  assert.doesNotMatch(text, /side/u);
});

test("没有展开过的部分、也没有学过的部分：清单写明学习者还没有学过任何概念", () => {
  const text = expansionBrief(course([topic("t01", [], "outline"), topic("t02", ["t01"], "outline")]), ["t01", "t02"], new Set());
  assert.match(text, /\nt02「标题t02」\n出处：没有登记\n直接先修：t01「标题t01」（这次一起展开，先写它）\n/u);
  assert.match(text, /\n## 学习者在这之前学到的概念\n\n学习者在这几部分之前还没有学过任何概念：术语第一次出现时都要先用一句话说清。$/u);
});
