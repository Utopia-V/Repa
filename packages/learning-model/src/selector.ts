import { DEFAULT_MODEL_CONFIG, applyRepetition, isDue, memoryAt, type ModelConfig } from "./model.js";
import type { Candidate, KnowledgeGraph, Student } from "./schema.js";

export function selectTasks(
  graph: KnowledgeGraph,
  student: Student,
  day: number,
  limit = 3,
  includeNew = true,
  config: ModelConfig = DEFAULT_MODEL_CONFIG,
): Candidate[] {
  const states = new Map(Object.entries(student));
  const due = graph.topics.filter((id) => {
    const state = states.get(id);
    return state !== undefined && isDue(state, day, config);
  });
  const remaining = new Set(due);
  const available: Candidate[] = [];
  for (const topicId of graph.topics) {
    const state = states.get(topicId);
    const prerequisites = graph.prerequisites
      .filter((edge) => edge.topic === topicId)
      .map((edge) => edge.prerequisite);
    if (!state && (!includeNew || !prerequisites.every((id) => states.has(id)))) continue;
    const preview = applyRepetition(graph, student, { topicId, day, outcome: "pass" }, config);
    const clearsOnPass = due.filter((id) => {
      const updated = preview[id];
      return updated !== undefined && !isDue(updated, day, config);
    });
    const directlyDue = state !== undefined && isDue(state, day, config);
    if (state && !directlyDue && clearsOnPass.length === 0) continue;
    let reasonKind: Candidate["reason"]["kind"] = "frontier";
    if (state) {
      reasonKind = clearsOnPass.some((id) => id !== topicId) ? "compression" : "due";
    }
    available.push({
      topicId,
      kind: state ? "review" : "learn",
      reason: {
        kind: reasonKind,
        clearsOnPass,
        prerequisites,
        explicitOnly: state !== undefined && state.speed < 1,
      },
    });
  }

  // Repa 假设：贪心覆盖，不保证最小集合。相同覆盖量先做更逾期的显式复习，
  // 再选新主题，最后按输入主题顺序打破平局。每答一项都应重新计算。
  const selected: Candidate[] = [];
  while (selected.length < limit && available.length > 0) {
    const score = (candidate: Candidate): number => {
      const covered = new Set(candidate.reason.clearsOnPass.filter((id) => remaining.has(id)));
      // 严重逾期时，一次成功也可能仍到期；仍要给它直接复习的机会。
      if (remaining.has(candidate.topicId)) covered.add(candidate.topicId);
      return covered.size;
    };
    const urgency = (candidate: Candidate): number => {
      const state = states.get(candidate.topicId);
      return state && remaining.has(candidate.topicId) ? memoryAt(state, day) : Infinity;
    };
    available.sort((a, b) => score(b) - score(a)
      || urgency(a) - urgency(b)
      || Number(b.kind === "learn") - Number(a.kind === "learn"));
    const candidate = available.shift();
    if (!candidate) break;
    // 只被之前候选覆盖的复习不再占菜单位置；新主题可补足选择。
    if (candidate.kind === "review" && score(candidate) === 0) continue;
    selected.push(candidate);
    for (const id of candidate.reason.clearsOnPass) remaining.delete(id);
    remaining.delete(candidate.topicId);
  }
  return selected;
}
