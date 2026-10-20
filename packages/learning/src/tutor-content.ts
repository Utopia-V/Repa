import { isDeepStrictEqual } from "node:util";
import { RepaFault } from "@repa/base";
import { contentVersion, type Content } from "@repa/base/protocol";
import type { ResolvedCourse } from "./course-sources.js";
import { content } from "./check/items.js";
import { taskEvidence } from "./flow-state.js";
import type { ContentPage, ContentRef, LearningTask } from "./protocol.js";
import type { Projection } from "./records-schema.js";
import type { LearningRecords } from "./records.js";

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

export function requireReferenceAccess(current: Projection | undefined): Projection {
  if (!current) {
    throw new RepaFault("service_failed", "学习状态尚未初始化");
  }
  const task = current.state.task;
  const restricted = task && task.kind !== "lesson" && !["completed", "aborted"].includes(task.phase.stage);
  if (restricted || !current.state.restrictions.referenceContentAllowed) {
    throw new RepaFault("restricted", "受限任务期间暂时不能求助或查看参考内容", {
      reason: "restricted",
      taskId: task?.taskId,
      stage: task?.phase.stage,
    });
  }
  return current;
}

/** 每次操作重新从当前投影和已释放的反馈生成可见集合，不能凭旧 view 或猜 id 取题解。 */
export async function visibleContent(
  records: LearningRecords,
  current: Projection,
  index: ReferenceContent[],
  requested: ContentRef[] = [],
): Promise<ContentPage[]> {
  const tasks = taskEvidence(records.records).map((entry) => entry.task);
  const currentTask = current.state.task;
  if (currentTask) {
    const position = tasks.findIndex((task) => task.taskId === currentTask.taskId);
    if (position >= 0) {
      tasks[position] = currentTask;
    } else {
      tasks.push(currentTask);
    }
  }
  const retained = [...index];
  const versions = new Set<string>();
  const missing = requested.filter((ref) =>
    ref.kind !== "explanation" && !index.some((entry) => isDeepStrictEqual(entry.ref, ref)),
  );
  for (const digest of missing.length ? new Set(Object.values(current.deliveries)) : []) {
    const snapshot = records.snapshot(digest);
    const needed = snapshot && missing.some((ref) =>
      ref.topicId === snapshot.topic.id && !retained.some((entry) => isDeepStrictEqual(entry.ref, ref)),
    );
    if (needed && !versions.has(snapshot.topicVersion)) {
      versions.add(snapshot.topicVersion);
      retained.push(...await referenceContent({ course: snapshot.course, topics: [snapshot.topic], origins: {} }));
    }
  }
  const originalDeliveries = new Map<string, { taskId: string; deliveryId: string }>();
  for (const task of tasks) {
    for (const delivery of task.deliveries) {
      const snapshot = records.snapshot(current.deliveries[delivery.deliveryId] ?? "");
      if (snapshot && !originalDeliveries.has(snapshot.questionId)) {
        originalDeliveries.set(snapshot.questionId, { taskId: task.taskId, deliveryId: delivery.deliveryId });
      }
    }
  }
  const pages: ContentPage[] = [];
  for (const entry of retained) {
    const learned = current.student[entry.ref.topicId];
    const active = currentTask?.topicIds.includes(entry.ref.topicId);
    if (!learned && !active) {
      continue;
    }
    const originTask = tasks.find((task) => task.topicIds.includes(entry.ref.topicId));
    if (!originTask) {
      continue;
    }
    let origin: ContentPage["origin"] = { taskId: originTask.taskId, content: entry.originRef ?? entry.ref };
    const original = entry.from && originalDeliveries.get(entry.from);
    if (original) {
      origin = { ...original, content: entry.originRef ?? entry.ref };
    }
    pages.push({ ref: entry.ref, origin, blocks: entry.blocks, offset: 0, total: entry.blocks.length });
  }
  for (const task of tasks) {
    for (const submission of task.submissions) {
      const delivery = task.deliveries.find((entry) => entry.deliveryId === submission.deliveryId);
      if (!delivery || !submission.explanation) {
        continue;
      }
      const ref: ContentRef = {
        courseId: current.state.course?.id ?? "learning",
        topicId: delivery.topicId,
        kpId: delivery.kpId,
        kind: "explanation",
        id: `${delivery.deliveryId}.explanation`,
        version: await contentVersion(submission.explanation),
      };
      const blocks = submission.explanation;
      pages.push({
        ref,
        origin: { taskId: task.taskId, deliveryId: delivery.deliveryId, content: ref },
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
