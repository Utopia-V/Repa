import { RepaFault } from "@repa/base";
import { contentVersion, type Content } from "@repa/base/protocol";
import type { ResolvedCourse } from "./course-sources.js";
import { content } from "./check/items.js";
import { deliveryId, taskId } from "./flow-state.js";
import type { ContentPage, ContentRef, LearningTask } from "./protocol.js";
import type { LearningSession, LearningView } from "./session.js";
import { referenceAllowed } from "./submission-visibility.js";

export interface ReferenceContent {
  ref: ContentRef;
  title: string;
  blocks: Content;
  from?: string;
  originRef?: ContentRef;
}

/** 只索引作者的讲解、例题和概念卡；正式题目的私有定义不进入读取路径。 */
export async function referenceContent(course: ResolvedCourse): Promise<ReferenceContent[]> {
  const entries: ReferenceContent[] = [];
  for (const topic of course.topics) {
    const base = { courseId: course.course.id, topicId: topic.id };
    entries.push({
      ref: { ...base, kind: "topic", id: topic.id, version: await contentVersion(topic) },
      title: topic.title,
      blocks: [...content(topic.intro), ...content(topic.wrapup)],
    });
    for (const kp of topic.kps) {
      const version = await contentVersion(kp);
      const ref = { ...base, kpId: kp.id, version };
      const lesson = content(kp.lesson);
      const example = [...content(kp.example?.body), ...content(kp.example?.explanation)];
      entries.push(
        { ref: { ...ref, kind: "kp", id: kp.id }, title: kp.title, blocks: lesson },
        { ref: { ...ref, kind: "lesson", id: `${kp.id}.explanation` }, title: `${kp.title}：讲解`, blocks: lesson },
        { ref: { ...ref, kind: "example", id: `${kp.id}.example` }, title: `${kp.title}：例题`, blocks: example },
      );
      if (kp.card) {
        entries.push({
          ref: { ...ref, kind: "card", id: `${kp.id}.card` },
          title: [kp.card.name, ...(kp.card.aliases ?? [])].join(" / "),
          blocks: [
            ...content(kp.card.definition),
            ...kp.card.conditions.flatMap((condition) => content(condition)),
            ...content(kp.card.example.text),
          ],
          from: kp.card.example.from,
          originRef: kp.card.example.from === kp.example?.id
            ? { ...ref, kind: "example", id: `${kp.id}.example` }
            : { ...ref, kind: "kp", id: kp.id },
        });
      }
    }
  }
  return entries.sort((left, right) => left.ref.id < right.ref.id ? -1 : left.ref.id > right.ref.id ? 1 : 0);
}

/** 复习和测验进行中拒绝求助和参考读取，细节里带上当前任务与阶段。 */
export function requireReferenceAccess(view: LearningView): LearningView {
  const task = view.state.task;
  if (!referenceAllowed(view.state)) {
    throw new RepaFault("restricted", "受限任务期间暂时不能求助或查看参考内容", {
      reason: "restricted",
      taskId: task?.taskId,
      stage: task?.phase.stage,
    });
  }
  return view;
}

/**
 * 每次操作重新从当前状态和已释放的反馈生成可见集合，不能凭旧 view 或猜 id 取题解。
 * 只提供当前课程里的内容；课程换版以后，旧版本的引用按不存在处理。
 */
export async function visibleContent(session: LearningSession, view: LearningView, index: ReferenceContent[]): Promise<ContentPage[]> {
  const tasks = session.replay.tasks;
  const currentTask = view.state.task;
  const originalDeliveries = new Map<string, { taskId: string; deliveryId: string }>();
  for (const task of tasks) {
    for (const delivery of task.deliveries) {
      if (!originalDeliveries.has(delivery.questionId)) {
        originalDeliveries.set(delivery.questionId, { taskId: taskId(task), deliveryId: deliveryId(delivery) });
      }
    }
  }
  const pages: ContentPage[] = [];
  for (const entry of index) {
    const learned = view.student[entry.ref.topicId];
    const active = currentTask?.topics.some((topic) => topic.id === entry.ref.topicId);
    if (!learned && !active) {
      continue;
    }
    const originTask = tasks.find((task) => task.topicIds.includes(entry.ref.topicId));
    if (!originTask) {
      continue;
    }
    let origin: ContentPage["origin"] = { taskId: taskId(originTask), content: entry.originRef ?? entry.ref };
    const original = entry.from && originalDeliveries.get(entry.from);
    if (original) {
      origin = { ...original, content: entry.originRef ?? entry.ref };
    }
    pages.push({ ref: entry.ref, origin, blocks: entry.blocks, offset: 0, total: entry.blocks.length });
  }
  for (const task of tasks) {
    for (const delivery of task.answered) {
      const question = session.course.questions.get(delivery.questionId);
      if (!question || !delivery.grades.length || !session.released(delivery)) {
        continue;
      }
      const blocks = content(question.question.explanation);
      const ref: ContentRef = {
        courseId: session.course.course.course.id,
        topicId: question.topic.id,
        kpId: question.kp.id,
        kind: "explanation",
        id: `${deliveryId(delivery)}.explanation`,
        version: await session.explanationVersion(delivery.questionId, blocks),
      };
      pages.push({
        ref,
        origin: { taskId: taskId(task), deliveryId: deliveryId(delivery), content: ref },
        blocks,
        offset: 0,
        total: blocks.length,
      });
    }
  }
  return pages.sort((left, right) => left.ref.id < right.ref.id ? -1 : left.ref.id > right.ref.id ? 1 : 0);
}

export function currentDelivery(task: LearningTask | null) {
  const phase = task?.phase;
  return phase?.stage === "awaiting_answer"
    ? task?.deliveries.find((entry) => entry.deliveryId === phase.deliveryId)
    : task?.deliveries.at(-1);
}
