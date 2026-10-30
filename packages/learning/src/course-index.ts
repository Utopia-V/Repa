import { requiredCapabilities } from "@repa/base/protocol";
import type { KnowledgeGraph } from "@repa/learning-model";
import { draftItem, itemVersion, questionVersion, slotTests, topicQuestions, type QuestionEntry } from "./check/items.js";
import type { ResolvedCourse } from "./course-sources.js";
import type { Question, Topic } from "./format/schema.js";

/** 一道题和它所在的 topic。 */
export interface IndexedQuestion extends QuestionEntry {
  topic: Topic;
}

/** 判分需要的外部条件：rule 当场就能判，tests 要前端运行 Python，model 要调用模型。 */
export type GradingNeed = "rule" | "tests" | "model";

export function gradingNeed(question: Question): GradingNeed {
  if (needsModel(question)) return "model";
  if (needsPython(question)) return "tests";
  return "rule";
}

/** 有要由模型按 rubric 判分的开放作答位。 */
export function needsModel(question: Question): boolean {
  return question.slots.some((slot) => slot.type === "text" && slot.rubric !== undefined);
}

/** 有要运行 Python 测试的作答位（代码题、按测试判的 Parsons 题）。 */
export function needsPython(question: Question): boolean {
  return question.slots.some((slot) => slotTests(slot).length > 0);
}

/** 当前课程的查找表：按 id 找 topic 和题目，并缓存题面版本、题目版本与显示题目所需的能力（各算一次）。 */
export class CourseIndex {
  readonly topics = new Map<string, Topic>();
  readonly questions = new Map<string, IndexedQuestion>();
  /** 有测验题的 topic。 */
  readonly quizTopics = new Set<string>();
  /**
   * 学生模型用的图：先修关系，以及各 topic 在课程里声明的包含关系（encompassings）。通过的信用沿包含关系传给被覆盖的 topic，
   * 失败的负信用传给覆盖它的 topic（FIRe）；权重取课程里写的值，是 Repa 的假设。零权重的边不传信用，不放进图里。
   */
  readonly graph: KnowledgeGraph;
  private readonly versions = new Map<string, Promise<{ item: string; question: string }>>();
  private readonly capabilities = new Map<string, string[]>();

  constructor(readonly course: ResolvedCourse) {
    for (const topic of course.topics) {
      this.topics.set(topic.id, topic);
      for (const entry of topicQuestions(topic)) {
        this.questions.set(entry.question.id, { ...entry, topic });
        if (entry.pool === "quiz") this.quizTopics.add(topic.id);
      }
    }
    this.graph = {
      topics: course.topics.map((topic) => topic.id),
      encompassings: course.topics.flatMap((topic) => (topic.encompassings ?? [])
        .filter((edge) => edge.weight > 0)
        .map((edge) => ({ advanced: topic.id, simple: edge.topic, weight: edge.weight }))),
      prerequisites: course.topics.flatMap((topic) => topic.prerequisites.map((prerequisite) => ({ topic: topic.id, prerequisite }))),
    };
  }

  /** 题面版本（学习者看到的）与题目版本（含判分方式，代码题还含判分用的运行前导）；题目不在当前课程里时返回 undefined。 */
  async versionsOf(questionId: string): Promise<{ item: string; question: string } | undefined> {
    const entry = this.questions.get(questionId);
    if (!entry) return undefined;
    let cached = this.versions.get(questionId);
    if (!cached) {
      cached = (async () => ({
        item: await itemVersion(entry.question, entry.topic),
        // 与 judge.ts 判分时用的前导相同：缺省按空串。
        question: await questionVersion(entry.question, entry.topic, this.course.course.runtime.prelude ?? ""),
      }))();
      this.versions.set(questionId, cached);
    }
    return cached;
  }

  /** 前端显示这道题需要的交互能力（作答位与内容块的种类），与交付时公开题目的 requires 相同。 */
  requires(question: Question, topic: Topic): string[] {
    let cached = this.capabilities.get(question.id);
    if (!cached) {
      cached = requiredCapabilities(draftItem(question, topic));
      this.capabilities.set(question.id, cached);
    }
    return cached;
  }
}
