/**
 * 学习插件接入学生模型的地方：时间换算、按课程的包含关系传递信用（FIRe），以及插件实际使用的参数。
 * 包含图来自课程里各 topic 的 encompassings（见 CourseIndex.graph），权重是课程作者写的 Repa 假设。
 */
import {
  applyRepetition, isDue, memoryAt, selectTasks,
  type Candidate, type KnowledgeGraph, type ModelConfig, type Repetition, type Student,
} from "@repa/learning-model";
import { STUDENT_MODEL } from "./parameters.js";

/** 一天的毫秒数：学生模型的时间是连续的天数。 */
export const DAY_MS = 86_400_000;

/**
 * 学生模型此刻的时间（连续天数）。时钟回拨到最近一次更新之前时，按最近一次更新的时刻算：模型的时间不倒退，
 * 回拨期间按零间隔继续，而不是拒绝计算、让学习停在那里。
 */
export function modelDay(student: Student, now: number): number {
  let day = now / DAY_MS;
  for (const state of Object.values(student)) {
    day = Math.max(day, state.lastRepetitionDay);
  }
  return day;
}

/** 按一次课、复习或测验的结论更新学生模型；信用沿课程的包含关系传给相关的 topic。 */
export function updateStudent(
  graph: KnowledgeGraph, student: Student, repetition: Omit<Repetition, "day">,
  now: number, config: ModelConfig = STUDENT_MODEL,
): Student {
  return applyRepetition(graph, student, { ...repetition, day: modelDay(student, now) }, config);
}

export function chooseTasks(
  graph: KnowledgeGraph, student: Student, now: number, limit = 3,
  config: ModelConfig = STUDENT_MODEL,
): Candidate[] {
  return selectTasks(graph, student, modelDay(student, now), limit, true, config);
}

/** 这个已学的 topic 此刻是否到期；没学过的不算到期。 */
export function topicDue(student: Student, topicId: string, now: number, config: ModelConfig = STUDENT_MODEL): boolean {
  const state = student[topicId];
  return state !== undefined && isDue(state, modelDay(student, now), config);
}

/** 这个 topic 此刻的 memory；没学过的为 0。memory 是调度量，不是答对概率。 */
export function topicMemory(student: Student, topicId: string, now: number): number {
  const state = student[topicId];
  return state ? memoryAt(state, modelDay(student, now)) : 0;
}
