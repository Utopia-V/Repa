/**
 * 每道题投影成学生可见的 Item，再用标准答案拼出一份作答：它必须通过 Item 自己的结构检查，
 * 并按作答位上的判分规则得满分；登记的错误答案必须判错。另按核对范围清点哪些题缺当前的模型核对记录。
 */

import { Value } from "typebox/value";

import { checkResponse, ItemSchema, type Item } from "@repa/base/protocol";

import type { Report, SourceFile } from "../format/diagnostics.js";
import type { LoadedCourse } from "../format/load.js";
import type { ConfirmationScope, Topic } from "../format/schema.js";
import { confirmationSlots, currentRecord } from "./confirm.js";
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

/** 缺模型核对记录时：required 报错；reported 不报错，只记进结果，由调用方处理（应用里做课时 course_use 不换用）。 */
export type ConfirmationMode = "required" | "reported";

/** 要模型核对的题有多少，其中哪些缺当前记录。 */
export interface ConfirmationSummary {
  scope: ConfirmationScope;
  questions: number;
  missing: { topic: string; question: string }[];
}

/** 一道要核对的题缺当前记录时，required 下报的错误。 */
function reportUnconfirmed(topic: Topic, file: SourceFile, entry: QuestionEntry, slots: string[], scope: ConfirmationScope, report: Report): void {
  const stale = (topic.verified ?? []).some((record) => record.question === entry.question.id);
  const listed = slots.join("、");
  if (scope === "question-lesson-v1") {
    const command = `npm run course:confirm -- --scope question-lesson-v1 --topic ${topic.id}`;
    report.error(
      "question_unconfirmed",
      stale
        ? `${entry.question.id} 的核对记录对应的是旧版本或没有覆盖 ${listed}；题面、答案、选项或讲解变化后要重新核对：${command}`
        : `${entry.question.id} 的作答位 ${listed} 还没有模型核对记录：${command}`,
      file, entry.at,
    );
    return;
  }
  report.error(
    "manual_unconfirmed",
    stale
      ? `${entry.question.id} 的核对记录对应的是旧版本或没有覆盖 ${listed}；题面、判分或运行依赖变化后要重新核对：npm run course:confirm -- --topic ${topic.id}`
      : `复习和测验题 ${entry.question.id} 的作答位 ${listed} 还没有模型核对记录：npm run course:confirm -- --topic ${topic.id}`,
    file, [...entry.at, "manual"],
  );
}

/** 按核对范围清点要核对的题和缺当前记录的题；mode 为 required 时缺记录的报错。 */
export async function checkConfirmations(
  course: LoadedCourse, report: Report, scope: ConfirmationScope, mode: ConfirmationMode,
): Promise<ConfirmationSummary> {
  const summary: ConfirmationSummary = { scope, questions: 0, missing: [] };
  for (const { topic, file } of course.topics) {
    // 随包课程的记录要指向存在的题。自制的课的记录由 course_confirm 写，题改了、删了以后旧记录只是对不上，下次写入时去掉。
    if (scope === "question-runtime-v1") checkRecords(topic, file, report);
    for (const entry of topicQuestions(topic)) {
      const slots = confirmationSlots(entry, scope);
      if (slots.length === 0) continue;
      summary.questions += 1;
      if (await currentRecord(topic, entry, course.course.runtime, scope)) continue;
      summary.missing.push({ topic: topic.id, question: entry.question.id });
      if (mode === "required") reportUnconfirmed(topic, file, entry, slots, scope, report);
    }
  }
  return summary;
}

export async function checkReferences(course: LoadedCourse, report: Report): Promise<Map<string, Item>> {
  const items = new Map<string, Item>();
  for (const { topic, file } of course.topics) {
    for (const entry of topicQuestions(topic)) {
      const { question, at } = entry;
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
