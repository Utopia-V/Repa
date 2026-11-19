import type { Candidate as ModelCandidate } from "@repa/learning-model";
import { scoped, unscoped } from "./course-key.js";
import type { StructureIndex } from "./course-structure.js";
import { topicEligible, type Fold } from "./flow-state.js";
import { LESSON_REST_MS, MENU_COURSE_ORDER, MENU_SIZE, REVIEWS_BEFORE_LESSON, STUDENT_MODEL } from "./parameters.js";
import type { LearningMenu } from "./protocol.js";
import { chooseTasks, topicMemory } from "./student-model.js";

type Candidate = LearningMenu["candidates"][number];

/**
 * 常规菜单：强制补救优先，再按学生模型的候选提供课和复习。菜单由学习状态和当前时间算出，同样的状态得到同样的菜单；
 * 候选的编号由类型和 topic 得出，刷新和重开都不变。supply 判断当前调用方能否拿到足够的题：课要每个没过的知识点都有
 * 这个前端能用的题，复习至少有一道。菜单的规则（失败后的重试、项数、相近项不同列、连续复习后给新课）都是 Repa 的假设，
 * 见 parameters.ts。没通过的课或复习当天没有休息过时，先给别的任务；别的都给不了，才在休息 LESSON_REST_MS 之后重新提供它。
 * timeZone 用来判断失败与现在是否在同一个本地自然日。菜单由课程结构算出，候选的标题是给人看的内容，由 title 按 topic 取。
 * key 是这门课的键：学习状态按它加编号查，候选带上它；fold 的补救只含还要求的义务（见 obligations）。
 */
export function learningMenu(
  structure: StructureIndex,
  key: string,
  fold: Fold,
  now: number,
  menuId: string,
  supply: (id: string, kind: Candidate["kind"]) => boolean,
  timeZone: string,
  title: (topicId: string) => string,
): LearningMenu {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const resting = (failure: { at: number; rested: boolean }) => !failure.rested && day.format(failure.at) === day.format(now);
  const first = buildMenu(structure, key, fold, now, menuId, supply, title, (failure) => !resting(failure));
  if (first.candidates.length) {
    return first;
  }
  return buildMenu(structure, key, fold, now, menuId, supply, title, (failure) => !resting(failure) || now >= failure.at + LESSON_REST_MS, LESSON_REST_MS);
}

/** 按给定的重试条件算一次菜单。rest 给出时，被挡下的失败课在 failure.at + rest 记为最早恢复的时间。 */
function buildMenu(
  structure: StructureIndex,
  key: string,
  fold: Fold,
  now: number,
  menuId: string,
  supply: (id: string, kind: Candidate["kind"]) => boolean,
  title: (topicId: string) => string,
  retry: (failure: { at: number; rested: boolean }) => boolean,
  rest?: number,
): LearningMenu {
  const candidates: Candidate[] = [];
  let availableAt: number | undefined;
  const at = (id: string) => scoped(key, id);
  /** 菜单接受这项候选吗：有强制补救时只接受补救本身；topic 完整、调用方拿得到题、有学习资格，失败的课满足重试条件。 */
  const acceptable = (topicId: string, kind: Candidate["kind"]): boolean => {
    // 补救的筛选放在这里而不在菜单算完以后：补救都还在休息时第一份菜单才是空的，后备菜单才会算出最早恢复的时间。
    if (fold.forced.size && fold.forced.get(at(topicId)) !== kind) {
      return false;
    }
    const topic = structure.topics.get(topicId);
    if (!topic || topic.status !== "complete" || !supply(topicId, kind) || !topicEligible(structure, fold, key, topicId, kind, now)) {
      return false;
    }
    const failure = kind === "lesson" ? fold.failures.get(at(topicId)) : fold.reviewFailures.get(at(topicId));
    if (failure && !retry(failure)) {
      if (rest !== undefined) {
        availableAt = Math.min(availableAt ?? Infinity, failure.at + rest);
      }
      return false;
    }
    return true;
  };
  const push = (topicId: string, kind: Candidate["kind"]) => {
    if (structure.topics.has(topicId) && !candidates.some((entry) => entry.kind === kind && entry.topicIds[0] === topicId)) {
      candidates.push({ id: `${kind}-${key}-${topicId}`, kind, title: title(topicId), topicIds: [topicId], course: key });
    }
  };
  const kindOf = (candidate: ModelCandidate): Candidate["kind"] => (candidate.kind === "learn" ? "lesson" : "review");
  for (const [id, kind] of fold.forced) {
    const topicId = unscoped(key, id);
    if (topicId !== undefined && acceptable(topicId, kind)) {
      push(topicId, kind);
      break;
    }
  }
  // 菜单不接受的候选（没到期的复习、还不能重试的课、调用方没有能用题目的）不参加覆盖：它被选中却提供不了，
  // 被它覆盖而略去的到期复习就从菜单上消失了。
  // 学生模型与图都按“课的键加编号”，候选的 topic 去掉课的键再交给菜单。
  const bare = (candidate: ModelCandidate) => unscoped(key, candidate.topicId) ?? candidate.topicId;
  const accept = (candidate: ModelCandidate) => acceptable(bare(candidate), kindOf(candidate));
  for (const candidate of chooseTasks(structure.scopedGraph(key), fold.student, now, structure.order.length, STUDENT_MODEL, accept)) {
    push(bare(candidate), kindOf(candidate));
  }
  const priority = (candidate: Candidate) => {
    if (fold.forced.has(at(candidate.topicIds[0] ?? ""))) {
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
    const left = structure.topics.get(a.topicIds[0] ?? "");
    const right = structure.topics.get(b.topicIds[0] ?? "");
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
  if (!selected.length && availableAt !== undefined) {
    menu.availableAt = availableAt;
  }
  return menu;
}

/**
 * 一份菜单：各门课按各自的规则算出的菜单（learningMenu）并起来。只有一门课时就是它的菜单。几门课时按 MENU_COURSE_ORDER 排：
 * 强制补救在前（它是全局的门：任何一门课有补救，各门课的菜单都只剩补救）；再是各门课的复习，按此刻的记忆从低到高；
 * 再是新课，先给最久没学的那门（studied 是这门课最近一项任务的序号，没学过为 0），同一门课里保持它自己的次序。
 * 连续复习够数以后先给一节课的规则照旧（REVIEWS_BEFORE_LESSON）。都没有候选时，最早恢复的时间取各门课里最早的。
 */
export function combinedMenu(parts: readonly { key: string; studied: number; menu: LearningMenu }[], fold: Fold, now: number, menuId: string): LearningMenu {
  if (parts.length === 1 && parts[0]) return parts[0].menu;
  const order = new Map(MENU_COURSE_ORDER.map((name, index) => [name, index]));
  const rank = (candidate: Candidate) => {
    if (fold.forced.has(scoped(candidate.course, candidate.topicIds[0] ?? ""))) return order.get("remediation") ?? 0;
    return candidate.kind === "review" ? order.get("reviews-by-memory") ?? 1 : order.get("lessons-by-least-recent-course") ?? 2;
  };
  const studied = new Map(parts.map((part) => [part.key, part.studied]));
  const memory = (candidate: Candidate) => topicMemory(fold.student, scoped(candidate.course, candidate.topicIds[0] ?? ""), now);
  const ordered = parts.flatMap((part) => part.menu.candidates).sort((a, b) => rank(a) - rank(b)
    || (a.kind === "review" && b.kind === "review" ? memory(a) - memory(b) : 0)
    || (a.kind === "lesson" && b.kind === "lesson" ? (studied.get(a.course) ?? 0) - (studied.get(b.course) ?? 0) : 0));
  if (!fold.forced.size && fold.consecutiveReviews >= REVIEWS_BEFORE_LESSON) {
    const lesson = ordered.findIndex((entry) => entry.kind === "lesson");
    if (lesson >= 0) ordered.unshift(...ordered.splice(lesson, 1));
  }
  const menu: LearningMenu = { menuId, candidates: ordered.slice(0, MENU_SIZE) };
  const times = parts.flatMap((part) => (part.menu.availableAt === undefined ? [] : [part.menu.availableAt]));
  if (!menu.candidates.length && times.length) menu.availableAt = Math.min(...times);
  return menu;
}
