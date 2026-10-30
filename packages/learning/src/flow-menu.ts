import type { CourseIndex } from "./course-index.js";
import { topicEligible, type Fold } from "./flow-state.js";
import { LESSON_COOLDOWN_MS, MENU_SIZE, REVIEWS_BEFORE_LESSON } from "./parameters.js";
import type { LearningMenu } from "./protocol.js";
import { chooseTasks } from "./student-model.js";

type Candidate = LearningMenu["candidates"][number];

/**
 * 常规菜单：强制补救优先，再按学生模型的候选提供课和复习。菜单由学习状态和当前时间算出，同样的状态得到同样的菜单；
 * 候选的编号由类型和 topic 得出，刷新和重开都不变。supply 判断当前调用方能否拿到足够的题：课要每个没过的知识点都有
 * 这个前端能用的题，复习至少有一道。菜单的规则（冷却、项数、相近项不同列、连续复习后给新课）都是 Repa 的假设，见 parameters.ts。
 */
export function learningMenu(
  course: CourseIndex,
  fold: Fold,
  now: number,
  menuId: string,
  supply: (id: string, kind: Candidate["kind"]) => boolean,
): LearningMenu {
  const candidates: Candidate[] = [];
  let availableAt: number | undefined;
  const add = (topicId: string, kind: Candidate["kind"]) => {
    const topic = course.topics.get(topicId);
    if (!topic || topic.status !== "complete" || !supply(topicId, kind)) {
      return;
    }
    if (!topicEligible(course, fold, topicId, kind, now)) {
      return;
    }
    if (kind === "lesson") {
      const failure = fold.failures.get(topicId);
      if (failure && now < failure.at + LESSON_COOLDOWN_MS) {
        availableAt = Math.min(availableAt ?? Infinity, failure.at + LESSON_COOLDOWN_MS);
        return;
      }
    }
    if (!candidates.some((entry) => entry.kind === kind && entry.topicIds[0] === topicId)) {
      candidates.push({ id: `${kind}-${topicId}`, kind, title: topic.title, topicIds: [topicId] });
    }
  };
  for (const [id, kind] of fold.forced) {
    add(id, kind);
    if (candidates.length) {
      break;
    }
  }
  for (const candidate of chooseTasks(course.graph, fold.student, now, course.course.topics.length)) {
    add(candidate.topicId, candidate.kind === "learn" ? "lesson" : "review");
  }
  const priority = (candidate: Candidate) => {
    if (fold.forced.has(candidate.topicIds[0] ?? "")) {
      return 0;
    }
    return candidate.kind === "review" ? 1 : 2;
  };
  const ordered = [...candidates].sort((a, b) => priority(a) - priority(b));
  if (!fold.forced.size && fold.consecutiveReviews >= REVIEWS_BEFORE_LESSON) {
    const lesson = ordered.findIndex((entry) => entry.kind === "lesson");
    if (lesson >= 0) {
      ordered.unshift(...ordered.splice(lesson, 1));
    }
  }
  const related = (a: Candidate, b: Candidate) => {
    const left = course.topics.get(a.topicIds[0] ?? "");
    const right = course.topics.get(b.topicIds[0] ?? "");
    return (
      !left ||
      !right ||
      left.id === right.id ||
      left.prerequisites.includes(right.id) ||
      right.prerequisites.includes(left.id) ||
      left.prerequisites.some((id) => right.prerequisites.includes(id))
    );
  };
  const selected: Candidate[] = [];
  for (const candidate of ordered) {
    if (selected.length < MENU_SIZE && !selected.some((old) => related(old, candidate))) {
      selected.push(candidate);
    }
  }
  const menu: LearningMenu = { menuId, candidates: selected };
  if (!selected.length) {
    menu.unavailableReason = "当前没有可开始的任务；可以回顾已学内容，或等待冷却结束／所需执行服务就绪。";
    if (availableAt !== undefined) {
      menu.availableAt = availableAt;
    }
  }
  return menu;
}
