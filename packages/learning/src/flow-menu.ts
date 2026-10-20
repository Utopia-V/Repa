import { chooseTasks } from "./student-model.js";
import type { ResolvedCourse } from "./course-sources.js";
import type { LearningMenu } from "./protocol.js";
import { opaqueId } from "./delivery.js";
import { graphFor, replayLearning, type TaskEvidence } from "./flow-state.js";

type Candidate = LearningMenu["candidates"][number];
export function learningMenu(course: ResolvedCourse, evidence: TaskEvidence[], now: number, previous: LearningMenu | null, supply: (id: string, kind: Candidate["kind"], model: ReturnType<typeof replayLearning>) => boolean) {
  const model = replayLearning(evidence, course);
  const candidates: Candidate[] = [];
  let availableAt: number | undefined;
  const add = (topicId: string, kind: Candidate["kind"]) => {
    const topic = course.topics.find((topic) => topic.id === topicId);
    if (!topic || topic.status !== "complete" || !supply(topicId, kind, model)) return;
    if (kind === "lesson") {
      if (!topic.prerequisites.every((id) => model.student[id])) return;
      if (model.forced.size && model.forced.get(topicId) !== "lesson") return;
      const failure = model.failures.get(topicId);
      if (failure && now < failure.at + 48 * 3_600_000) {
        availableAt = Math.min(availableAt ?? Infinity, failure.at + 48 * 3_600_000);
        return;
      }
    }
    if (!candidates.some((entry) => entry.kind === kind && entry.topicIds[0] === topicId)) {
      candidates.push({ id: opaqueId(), kind, title: topic.title, topicIds: [topicId] });
    }
  };
  for (const [id, kind] of model.forced) {
    add(id, kind);
    if (candidates.length) break;
  }
  for (const candidate of chooseTasks(graphFor(course), model.student, now, course.topics.length)) {
    add(candidate.topicId, candidate.kind === "learn" ? "lesson" : "review");
  }
  const priority = (candidate: Candidate) => model.forced.has(candidate.topicIds[0] ?? "") ? 0 : candidate.kind === "review" ? 1 : 2;
  const retained = previous?.candidates.flatMap((old) => {
    const valid = candidates.find((entry) => entry.kind === old.kind && entry.topicIds[0] === old.topicIds[0]);
    return valid ? [old] : [];
  }) ?? [];
  const ordered = candidates.map((entry) => retained.find((old) => old.kind === entry.kind && old.topicIds[0] === entry.topicIds[0]) ?? entry);
  ordered.sort((a, b) => priority(a) - priority(b));
  if (!model.forced.size && model.consecutiveReviews >= 3) {
    const lesson = ordered.findIndex((entry) => entry.kind === "lesson");
    if (lesson >= 0) ordered.unshift(...ordered.splice(lesson, 1));
  }
  const related = (a: Candidate, b: Candidate) => {
    const left = course.topics.find((topic) => topic.id === a.topicIds[0]);
    const right = course.topics.find((topic) => topic.id === b.topicIds[0]);
    return !left || !right || left.id === right.id || left.prerequisites.includes(right.id)
      || right.prerequisites.includes(left.id) || left.prerequisites.some((id) => right.prerequisites.includes(id));
  };
  const selected: Candidate[] = [];
  for (const candidate of ordered) {
    if (selected.length < 3 && !selected.some((old) => related(old, candidate))) selected.push(candidate);
  }
  const menu: LearningMenu = { menuId: previous?.menuId ?? opaqueId(), candidates: selected };
  if (!selected.length) {
    menu.unavailableReason = "当前没有可开始的任务；可以回顾已学内容，或等待冷却结束／所需执行服务就绪。";
    if (availableAt !== undefined) menu.availableAt = availableAt;
  }
  return { menu, model, candidates: candidates.map((candidate) => `${candidate.kind}:${candidate.topicIds[0]}`) };
}
