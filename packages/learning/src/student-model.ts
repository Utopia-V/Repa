import { applyRepetition, DEFAULT_MODEL_CONFIG, selectTasks, type KnowledgeGraph, type ModelConfig, type Repetition, type Student } from "@repa/learning-model";
import { RepaFault } from "@repa/base";

export const MODEL_CONFIG_VERSION = "repa-hsrs-v0-direct";
function modelDay(student: Student, now: number): number {
  const day = now / 86_400_000;
  if (Object.values(student).some((state) => day < state.lastRepetitionDay)) throw new RepaFault("model_time_conflict", "模型计算时间早于现有状态");
  return day;
}
export function updateStudent(
  graph: KnowledgeGraph, student: Student, repetition: Omit<Repetition, "day">,
  now: number, config: ModelConfig = DEFAULT_MODEL_CONFIG,
): Student {
  const day = modelDay(student, now);
  return applyRepetition({ ...graph, encompassings: [] }, student, { ...repetition, day }, config);
}
export function chooseTasks(
  graph: KnowledgeGraph, student: Student, now: number, limit = 3,
  config: ModelConfig = DEFAULT_MODEL_CONFIG,
) {
  return selectTasks({ ...graph, encompassings: [] }, student, modelDay(student, now), limit, true, config);
}
