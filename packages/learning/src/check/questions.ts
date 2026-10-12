/**
 * 每道题投影成学生可见的 Item，再用标准答案拼出一份作答：它必须通过 Item 自己的结构检查，
 * 并按作答位上的判分规则得满分；登记的错误答案必须判错。
 */

import { Value } from "typebox/value";

import { checkResponse, ItemSchema, type Item } from "@repa/base/protocol";
import type { Report } from "../format/diagnostics.js";
import type { LoadedCourse } from "../format/load.js";
import { gradeSlot } from "./grade.js";
import { publicItem, referenceResponse, scalarText, topicQuestions } from "./items.js";

export async function checkReferences(course: LoadedCourse, report: Report): Promise<Map<string, Item>> {
  const items = new Map<string, Item>();
  for (const { topic, file } of course.topics) {
    for (const { question, at } of topicQuestions(topic)) {
      const item = await publicItem(question, topic);
      items.set(question.id, item);
      if (!Value.Check(ItemSchema, item)) {
        const first = Value.Errors(ItemSchema, item)[0];
        report.error("item_invalid", `投影出的题目不符合交互词汇：${first?.instancePath ?? ""} ${first?.message ?? ""}`, file, at);
        continue;
      }
      const response = referenceResponse(question, item);
      const structure = checkResponse(item, response);
      if (!structure.ok) {
        const problems = structure.problems.map((problem) => `${problem.slot ?? "题目"}：${problem.message}`).join("；");
        report.error("reference_rejected", `标准答案通不过题目自己的结构检查：${problems}`, file, at);
      }
      question.slots.forEach((slot, slotIndex) => {
        const grade = gradeSlot(slot, response.answers[slot.id]);
        if (grade.verdict !== "correct" && grade.verdict !== "ungraded") {
          report.error("reference_incorrect", `标准答案按 ${slot.id} 自己的判分规则没有得满分（${grade.earned}/${grade.max}）`, file, [...at, "slots", slotIndex]);
        }
        if (slot.type !== "text") return;
        slot.feedback?.forEach((feedback, feedbackIndex) => {
          const wrong = gradeSlot(slot, { type: "text", text: scalarText(feedback.when) });
          if (wrong.verdict === "correct") {
            report.error("feedback_not_wrong", `反馈针对的作答 ${scalarText(feedback.when)} 按判分规则其实是对的`, file, [...at, "slots", slotIndex, "feedback", feedbackIndex]);
          }
        });
      });
    }
  }
  return items;
}
