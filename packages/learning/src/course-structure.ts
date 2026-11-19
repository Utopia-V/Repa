import type { KnowledgeGraph } from "@repa/learning-model";
import { identifier, object } from "@repa/base/protocol";
import { Type, type Static } from "typebox";
import type { Pool } from "./check/items.js";
import { needsModel } from "./course-index.js";
import type { ResolvedCourse } from "./course-sources.js";

/**
 * 一个知识点的结构。题目只记 id，按课程里的顺序；完整题面、判分方式、能力需求属于课程内容（见 CourseIndex）。
 * 例题也记下，因为课程里的题目查找一向包括例题（CourseIndex.questions），重放按题目 id 归属作答时与之相同。
 * keyPrerequisites 是停在这个知识点时要补的 topic（见 foldTask）；open 是 practice 里要由模型按 rubric 判分的题（开放题）：
 * 不计入必做，有可用模型才出。
 */
const KpStructureSchema = object({
  id: identifier,
  keyPrerequisites: Type.Array(identifier),
  example: Type.Optional(identifier),
  practice: Type.Array(identifier),
  review: Type.Array(identifier),
  quiz: Type.Array(identifier),
  open: Type.Array(identifier),
});
/** 一个知识点的结构。 */
export type KpStructure = Static<typeof KpStructureSchema>;

/**
 * 一个 topic 的结构。标题、讲解等给人看的内容不在其中。outline 的 topic 还没有内容，不进菜单；minutes 是课的预计分钟数，
 * XP 的基数，也用于估算完课日期；encompassings 是包含关系（FIRe 沿它传递信用），零权重的边不传信用，不记，也不放进图里。
 */
const TopicStructureSchema = object({
  id: identifier,
  status: Type.Enum(["outline", "complete"]),
  minutes: Type.Integer({ minimum: 0 }),
  prerequisites: Type.Array(identifier),
  encompassings: Type.Array(object({ topic: identifier, weight: Type.Number({ exclusiveMinimum: 0 }) })),
  kps: Type.Array(KpStructureSchema),
});
/** 一个 topic 的结构。 */
export type TopicStructure = Static<typeof TopicStructureSchema>;

/**
 * 重放与教学流程用到的课程结构：课程身份，按课程顺序的 topic、知识点、各题池的题目 id、必做与开放题、分钟数、先修与关键先修、
 * 包含关系。它是纯数据，原样写进学习记录的结构事实（records-schema.ts），任务按序号引用它；任务的结论、XP、学生模型、补救、测验与菜单
 * 都只由它和学习记录决定。题面渲染、判分、所需服务是否可用读完整的课程内容，不经这里。
 */
export const CourseStructureSchema = object({
  course: object({ id: identifier, version: identifier }),
  topics: Type.Array(TopicStructureSchema),
});
/** 课程结构。 */
export type CourseStructure = Static<typeof CourseStructureSchema>;

/** 题目在结构里的位置。open 只对练习题有意义，见 KpStructure.open。 */
export interface QuestionPlace {
  topicId: string;
  kpId: string;
  pool: Pool;
  open: boolean;
}

/** 从课程内容取出结构。 */
export function courseStructure(resolved: ResolvedCourse): CourseStructure {
  return {
    course: { id: resolved.course.id, version: resolved.course.version },
    topics: resolved.topics.map((topic) => ({
      id: topic.id,
      status: topic.status,
      minutes: topic.minutes,
      prerequisites: [...topic.prerequisites],
      encompassings: (topic.encompassings ?? []).filter((edge) => edge.weight > 0).map((edge) => ({ topic: edge.topic, weight: edge.weight })),
      kps: topic.kps.map((kp) => ({
        id: kp.id,
        keyPrerequisites: [...kp.keyPrerequisites ?? []],
        ...(kp.example ? { example: kp.example.id } : {}),
        practice: (kp.practice ?? []).map((question) => question.id),
        review: (kp.review ?? []).map((question) => question.id),
        quiz: (kp.quiz ?? []).map((question) => question.id),
        open: (kp.practice ?? []).filter(needsModel).map((question) => question.id),
      })),
    })),
  };
}

/** 结构的查找表：按 id 找 topic 与题目的位置，有测验题的 topic，以及学生模型用的图。只由结构本身建出。 */
export class StructureIndex {
  readonly topics = new Map<string, TopicStructure>();
  readonly questions = new Map<string, QuestionPlace>();
  /** 有测验题的 topic。 */
  readonly quizTopics = new Set<string>();
  /**
   * 学生模型用的图：先修关系，以及各 topic 声明的包含关系。通过的信用沿包含关系传给被覆盖的 topic，失败的负信用传给覆盖它的 topic（FIRe）；
   * 权重取课程里写的值，是 Repa 的假设。
   */
  readonly graph: KnowledgeGraph;

  constructor(readonly data: CourseStructure) {
    for (const topic of data.topics) {
      this.topics.set(topic.id, topic);
      for (const kp of topic.kps) {
        const open = new Set(kp.open);
        const place = (pool: Pool, id: string) => this.questions.set(id, { topicId: topic.id, kpId: kp.id, pool, open: pool === "practice" && open.has(id) });
        // 与 topicQuestions 的顺序相同：同一 id 出现两次时（课程检查不允许）后者为准，与 CourseIndex.questions 一致。
        if (kp.example !== undefined) place("example", kp.example);
        for (const pool of ["practice", "review", "quiz"] as const) {
          for (const id of kp[pool]) place(pool, id);
        }
        if (kp.quiz.length > 0) this.quizTopics.add(topic.id);
      }
    }
    this.graph = {
      topics: data.topics.map((topic) => topic.id),
      encompassings: data.topics.flatMap((topic) => topic.encompassings.map((edge) => ({ advanced: topic.id, simple: edge.topic, weight: edge.weight }))),
      prerequisites: data.topics.flatMap((topic) => topic.prerequisites.map((prerequisite) => ({ topic: topic.id, prerequisite }))),
    };
  }

  /** 按课程顺序的全部 topic。 */
  get order(): TopicStructure[] {
    return this.data.topics;
  }

  /** 某个 topic 某个题池的题目 id，按知识点、再按题池里的顺序。 */
  pool(topicId: string, pool: Exclude<Pool, "example">): string[] {
    return this.topics.get(topicId)?.kps.flatMap((kp) => kp[pool]) ?? [];
  }
}
