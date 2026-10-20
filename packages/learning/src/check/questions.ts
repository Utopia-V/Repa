/**
 * 每道题投影成学生可见的 Item，再用标准答案拼出一份作答：它必须通过 Item 自己的结构检查，
 * 并按作答位上的判分规则得满分；登记的错误答案必须判错。
 */

import { Value } from "typebox/value";

import { checkResponse, ItemSchema, type Item } from "@repa/base/protocol";

import type { Report, SourceFile } from "../format/diagnostics.js";
import type { LoadedCourse } from "../format/load.js";
import type { Runtime, Topic } from "../format/schema.js";
import { currentConfirmation, needsConfirmation } from "./confirm.js";
import { gradeSlot } from "./grade.js";
import { publicItem, referenceResponse, scalarText, topicQuestions, type QuestionEntry } from "./items.js";

/** verified 段的记录要指向本 topic 存在的题和作答位，每道题一条。 */
function checkRecords(topic: Topic, file: SourceFile, report: Report): void {
  const questions = new Map(topicQuestions(topic).map((entry) => [entry.question.id, entry.question]));
  const seen = new Set<string>();
  (topic.verified ?? []).forEach((record, index) => {
    const at = ["verified", index];
    const question = questions.get(record.question);
    if (!question) {
      report.error("verified_unknown", `核对记录里的 ${record.question} 不是本 topic 的题目`, file, [...at, "question"]);
      return;
    }
    if (seen.has(record.question)) report.error("verified_duplicate", `${record.question} 有两条核对记录`, file, [...at, "question"]);
    seen.add(record.question);
    for (const slot of record.slots) {
      if (!question.slots.some((candidate) => candidate.id === slot)) report.error("verified_unknown", `核对记录里的 ${slot} 不是 ${record.question} 的作答位`, file, [...at, "slots"]);
    }
  });
}

/** 复习和测验题的 manual 作答位要有当前题面、判分定义与运行依赖的核对记录。 */
async function checkConfirmation(topic: Topic, file: SourceFile, entry: QuestionEntry, runtime: Runtime, report: Report): Promise<void> {
  if (!needsConfirmation(entry) || await currentConfirmation(topic, entry.question, runtime)) return;
  const stale = (topic.verified ?? []).some((record) => record.question === entry.question.id);
  const slots = (entry.question.manual ?? []).join("、");
  report.error(
    "manual_unconfirmed",
    stale
      ? `${entry.question.id} 的核对记录对应的是旧版本或没有覆盖 ${slots}；题面、判分或运行依赖变化后要重新核对：npm run course:confirm -- --topic ${topic.id}`
      : `复习和测验题 ${entry.question.id} 的作答位 ${slots} 还没有模型核对记录：npm run course:confirm -- --topic ${topic.id}`,
    file, [...entry.at, "manual"],
  );
}

export async function checkReferences(course: LoadedCourse, report: Report): Promise<Map<string, Item>> {
  const items = new Map<string, Item>();
  for (const { topic, file } of course.topics) {
    checkRecords(topic, file, report);
    for (const entry of topicQuestions(topic)) {
      const { question, at } = entry;
      const item = await publicItem(question, topic);
      items.set(question.id, item);
      await checkConfirmation(topic, file, entry, course.course.runtime, report);
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
