import { isDeepStrictEqual } from "node:util";
import { RepaFault } from "@repa/base";
import type { Host, PluginInstance, PluginMethod, Tool } from "@repa/base/plugin";
import { contentVersion, object, parse } from "@repa/base/protocol";
import { memoryAt } from "@repa/learning-model";
import { Type } from "typebox";
import type { ResolvedCourse } from "./course-sources.js";
import {
  learningMethods,
  type ContentPage,
  type ContentRef,
  type LearningInput,
  type LearningMethod,
  type LearningResult,
} from "./protocol.js";
import type { LearningRecords } from "./records.js";
import type { Projection, RecordBody } from "./records-schema.js";
import { currentDelivery, referenceContent, requireReferenceAccess, visibleContent } from "./tutor-content.js";

export const TUTOR_AGENT = "learning-tutor";
const TEXT_BYTES = 16 * 1024;
const SearchParametersSchema = object({
  query: Type.String({ maxLength: 200 }),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
});
const ReadParametersSchema = object({
  refs: learningMethods["content.read"].input.properties.refs,
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
});
type Viewed = Omit<Extract<RecordBody, { type: "viewed" }>, "type">;

export async function connectTutor(
  records: LearningRecords,
  course: ResolvedCourse,
  host: Host,
  clock = Date.now,
): Promise<Pick<PluginInstance, "methods" | "tools" | "agents">> {
  const index = await referenceContent(course);
  const titles = new Map(index.map((entry) => [entry.ref.id, entry.title]));
  const methods: Record<string, PluginMethod> = {};
  async function observe(input: Parameters<LearningRecords["viewed"]>[0]) {
    const revision = records.revision;
    await records.viewed(input);
    if (records.revision !== revision) {
      const state = records.current()?.state;
      host.emit({
        type: "learning.changed",
        revision: records.revision,
        taskId: state?.task?.taskId ?? null,
        menuId: state?.menu?.menuId ?? null,
      });
    }
  }
  function help(current: Projection, ref: ContentRef): Viewed[] {
    const task = current.state.task;
    const delivery = currentDelivery(task);
    if (!task || !delivery || task.kind !== "lesson") {
      return [];
    }
    const accepted = task.submissions.some((entry) => entry.deliveryId === delivery.deliveryId);
    return [{
      taskId: task.taskId,
      deliveryId: delivery.deliveryId,
      action: accepted ? "help_after" : "help_before",
      ref,
    }];
  }
  async function access<T>(
    action: (current: Projection, pages: ContentPage[]) => { result: T; viewed: Viewed[] },
    requested: ContentRef[] = [],
  ) {
    let result: T | undefined;
    await observe(async (stored) => {
      const current = requireReferenceAccess(stored);
      const value = action(current, await visibleContent(records, current, index, requested));
      result = value.result;
      return value.viewed;
    });
    return result;
  }
  function find(pages: ContentPage[], ref: ContentRef) {
    const page = pages.find((entry) => isDeepStrictEqual(entry.ref, ref));
    if (!page) {
      throw new RepaFault("invalid_input", "内容尚未开放或指定版本不存在", {
        reason: "invalid_structure",
        problems: [{ message: "内容引用不可用" }],
      });
    }
    return page;
  }
  function viewed(current: Projection, page: ContentPage): Viewed[] {
    const action = page.ref.kind === "card" ? "card" : "kp";
    return [{
      taskId: page.origin.taskId,
      ...(page.origin.deliveryId ? { deliveryId: page.origin.deliveryId } : {}),
      action,
      ref: page.ref,
    }, ...help(current, page.ref)];
  }
  function register<M extends LearningMethod>(
    name: M,
    invoke: (input: LearningInput<M>) => Promise<LearningResult<M> | undefined>,
  ) {
    const method: PluginMethod = {
      parameters: learningMethods[name].input,
      result: learningMethods[name].result,
      // schema 索引联合在这里丢失 M，parse 已按本方法校验。
      invoke: async (raw) => invoke(parse(learningMethods[name].input, raw) as LearningInput<M>),
    };
    methods[name] = method;
    return method;
  }
  const search = register("content.search", async ({ query, offset, limit }) => access((current, pages) => {
    const needle = query.toLocaleLowerCase("zh-CN");
    const hits = pages.flatMap((page) => {
      const title = titles.get(page.ref.id) ?? "已释放题解";
      const text = page.blocks.map((block) => block.type === "image" ? block.alt : block.text).join("\n");
      const searchable = `${page.ref.id} ${title} ${text}`.toLocaleLowerCase("zh-CN");
      if (!searchable.includes(needle)) {
        return [];
      }
      const position = text.toLocaleLowerCase("zh-CN").indexOf(needle);
      const start = Math.max(0, position - 40);
      return [{
        ref: page.ref,
        title,
        snippet: text.slice(start, start + 160),
        origin: page.origin,
      }];
    });
    const selected = hits.slice(offset, offset + limit);
    while (Buffer.byteLength(JSON.stringify(selected)) > TEXT_BYTES - 64) {
      selected.pop();
    }
    return {
      result: { hits: selected, nextOffset: offset + selected.length < hits.length ? offset + selected.length : null },
      viewed: selected.flatMap((hit) => viewed(current, find(pages, hit.ref))),
    };
  }));
  const read = register("content.read", async ({ refs, offset, limit }) => access((current, pages) => {
    const selected: ContentPage[] = [];
    const events: Viewed[] = [];
    for (const ref of refs) {
      const source = find(pages, ref);
      const page = { ...source, offset, blocks: source.blocks.slice(offset, offset + limit) };
      while (page.blocks.length && Buffer.byteLength(JSON.stringify([...selected, page])) > TEXT_BYTES) {
        page.blocks.pop();
      }
      if (offset < source.total && page.blocks.length === 0) {
        if (selected.length) {
          break;
        }
        throw new RepaFault("content_block_too_large", "单块内容超过读取预算，请缩短课程内容块");
      }
      selected.push(page);
      events.push(...viewed(current, source));
    }
    return { result: selected, viewed: events };
  }, refs));
  register("content.open", async ({ ref }) => access((current, pages) => ({
    result: { openedAt: clock() },
    viewed: viewed(current, find(pages, ref)),
  }), [ref]));
  const TaskParametersSchema = object({
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 3000 })),
  });
  const tools: Tool[] = [
    {
      name: "learning_task",
      description: "读取当前任务画面、练习的公开题面、已接受原答及已释放反馈。text 是 JSON 的片段，offset/limit 按 Unicode 字符计数；默认 2000、最多 3000 字符，按 total 继续读取，version 变化后重新从 0 开始。",
      parameters: TaskParametersSchema,
      async execute(raw) {
        const { offset = 0, limit = 2000 } = parse(TaskParametersSchema, raw);
        let text = "";
        await observe(async (stored) => {
          const current = requireReferenceAccess(stored);
          const task = current.state.task;
          const delivery = currentDelivery(task);
          const submission = task?.submissions.find((entry) => entry.deliveryId === delivery?.deliveryId);
          const focus = {
            taskId: task?.taskId ?? null,
            kind: task?.kind ?? null,
            phase: task?.phase ?? null,
            delivery: delivery ?? null,
            submission: submission ?? null,
          };
          const serialized = Array.from(JSON.stringify(focus));
          text = JSON.stringify({
            version: await contentVersion(focus),
            offset,
            total: serialized.length,
            text: serialized.slice(offset, offset + limit).join(""),
          });
          const ref = index.find((entry) => entry.ref.kind === "kp" && entry.ref.kpId === delivery?.kpId)?.ref;
          return ref ? help(current, ref) : [];
        });
        return { text };
      },
    },
    {
      name: "learning_search",
      description: "搜索当前任务与已学内容，返回可用于即时回顾的版本引用和原学习位置；默认 10 项，最多 20 项。",
      parameters: SearchParametersSchema,
      async execute(raw) {
        const input = parse(SearchParametersSchema, raw);
        const result = await search.invoke({ offset: 0, limit: 10, ...input }, {});
        return { text: JSON.stringify(result) };
      },
    },
    {
      name: "learning_read",
      description: "按版本引用批取讲解、例题、KP、概念卡或已开放题解。最多 8 个引用；offset/limit 指定内容块范围，实际返回可能受 16 KiB 预算缩短。",
      parameters: ReadParametersSchema,
      async execute(raw) {
        const input = parse(ReadParametersSchema, raw);
        const result = await read.invoke({ offset: 0, limit: 8, ...input }, {});
        return { text: JSON.stringify(result) };
      },
    },
  ];
  return {
    methods,
    tools: () => tools,
    agents: () => [{
      id: TUTOR_AGENT,
      direct: true,
      description: "围绕当前学习任务讲解，并即时回顾已学知识",
      tools: tools.map((tool) => tool.name),
      instructions: () => "你是学习辅导老师。围绕当前任务帮助学习者理解知识，使用学习读取工具核对细节。提到概念时附上工具返回的 ref 与 origin，便于即时回顾；教学推进和正式判分由程序负责。",
      async beforeMessage() {
        try {
          await observe(async (stored) => {
            const current = requireReferenceAccess(stored);
            if (!current.state.restrictions.tutorAllowed) {
              throw new RepaFault("restricted", "当前任务暂时不能求助");
            }
            const delivery = currentDelivery(current.state.task);
            const ref = index.find((entry) => entry.ref.kpId === delivery?.kpId && entry.ref.kind === "kp")?.ref;
            return ref ? help(current, ref) : [];
          });
        } catch (error) {
          if (error instanceof RepaFault && error.code === "restricted") {
            return {
              status: "rejected",
              reason: "restricted",
              message: error.message,
              ...(error.details === undefined ? {} : { data: error.details }),
            };
          }
          throw error;
        }
      },
      async beforeRun() {
        try {
          requireReferenceAccess(records.current());
        } catch (error) {
          if (error instanceof RepaFault && error.code === "restricted") {
            return {
              status: "rejected",
              reason: "restricted",
              message: error.message,
              ...(error.details === undefined ? {} : { data: error.details }),
            };
          }
          throw error;
        }
      },
      async view() {
        const current = records.current();
        if (!current) throw new RepaFault("service_failed", "学习状态尚未初始化");
        const task = current.state.task;
        const delivery = currentDelivery(task ?? null);
        const topic = course.topics.find((entry) => entry.id === task?.topicIds[0]);
        const phase = task?.phase;
        const shownKp = phase?.stage === "explanation" || phase?.stage === "example" ? phase.page.ref.kpId : undefined;
        const kpId = shownKp ?? delivery?.kpId ?? task?.kps.find((entry) => !entry.completed)?.kpId;
        const weak = (topic?.prerequisites ?? []).flatMap((id) => {
          const state = current.student[id];
          return state ? [{ id, memory: memoryAt(state, current.state.serverNow / 86_400_000) }] : [];
        }).sort((left, right) => left.memory - right.memory || left.id.localeCompare(right.id)).slice(0, 3);
        const submission = task?.submissions.at(-1);
        return JSON.stringify({
          task: task ? { id: task.taskId, kind: task.kind, topics: task.topicIds } : null,
          kp: task?.kps.find((entry) => entry.kpId === kpId) ?? null,
          stage: task?.phase.stage ?? null,
          submission: submission ? { id: submission.submissionId, status: submission.processing.status } : null,
          weakPrerequisites: weak.map((entry) => entry.id),
        });
      },
    }],
  };
}
