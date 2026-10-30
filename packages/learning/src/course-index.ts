import type { KnowledgeGraph } from "@repa/learning-model";
import { itemVersion, questionVersion, slotTests, topicQuestions, type QuestionEntry } from "./check/items.js";
import type { ResolvedCourse } from "./course-sources.js";
import type { Question, Topic } from "./format/schema.js";

/** 一道题和它所在的 topic。 */
export interface IndexedQuestion extends QuestionEntry {
  topic: Topic;
}

/** 判分需要的外部条件：rule 当场就能判，tests 要前端运行 Python，model 要调用模型。 */
export type GradingNeed = "rule" | "tests" | "model";

export function gradingNeed(question: Question): GradingNeed {
  if (question.slots.some((slot) => slot.type === "text" && slot.rubric)) return "model";
  if (question.slots.some((slot) => slotTests(slot).length > 0)) return "tests";
  return "rule";
}

/** 当前课程的查找表：按 id 找 topic 和题目，并缓存题面版本与题目版本（各算一次）。 */
export class CourseIndex {
  readonly topics = new Map<string, Topic>();
  readonly questions = new Map<string, IndexedQuestion>();
  /** 有测验题的 topic。 */
  readonly quizTopics = new Set<string>();
  /** 学生模型用的先修图；包含关系置空，正负隐式传播都关闭。 */
  readonly graph: KnowledgeGraph;
  private readonly versions = new Map<string, Promise<{ item: string; question: string }>>();

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
      encompassings: [],
      prerequisites: course.topics.flatMap((topic) => topic.prerequisites.map((prerequisite) => ({ topic: topic.id, prerequisite }))),
    };
  }

  /** 题面版本（学习者看到的）与题目版本（含判分方式）；题目不在当前课程里时返回 undefined。 */
  async versionsOf(questionId: string): Promise<{ item: string; question: string } | undefined> {
    const entry = this.questions.get(questionId);
    if (!entry) return undefined;
    let cached = this.versions.get(questionId);
    if (!cached) {
      cached = (async () => ({
        item: await itemVersion(entry.question, entry.topic),
        question: await questionVersion(entry.question, entry.topic),
      }))();
      this.versions.set(questionId, cached);
    }
    return cached;
  }
}
