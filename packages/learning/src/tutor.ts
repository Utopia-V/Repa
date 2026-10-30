import { isDeepStrictEqual } from "node:util";
import { RepaFault } from "@repa/base";
import type { PluginInstance, PluginMethod, Tool } from "@repa/base/plugin";
import { contentVersion, object, parse } from "@repa/base/protocol";
import { memoryAt } from "@repa/learning-model";
import { Type } from "typebox";
import {
  learningMethods,
  type ContentPage,
  type ContentRef,
  type LearningInput,
  type LearningMethod,
  type LearningResult,
} from "./protocol.js";
import type { FactBody } from "./records-schema.js";
import type { LearningSession, LearningView } from "./session.js";
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

export async function connectTutor(
  session: LearningSession,
): Promise<Pick<PluginInstance, "methods" | "tools" | "agents">> {
  const index = await referenceContent(session.course.course);
  const titles = new Map(index.map((entry) => [entry.ref.id, entry.title]));
  const methods: Record<string, PluginMethod> = {};
  /**
   * 在串行入口里读当前状态，再决定是否记下求助：action 返回 true 表示学习者确实得到了帮助（提问、读到了内容）。
   * 求助只在课内、题目还没作答时记，每道题记一次。
   */
  async function observe(action: (view: LearningView) => Promise<boolean> | boolean) {
    await session.write(async () => (await action(await session.view()) ? help() : []));
  }
  function help(): FactBody[] {
    const evidence = session.replay.currentEvidence();
    if (!evidence || evidence.task.kind !== "lesson") {
      return [];
    }
    const position = session.position(evidence);
    if (position.stage !== "awaiting_answer" || position.delivery.help || position.delivery.answer) {
      return [];
    }
    return [{ type: "help", delivery: position.delivery.seq }];
  }
  async function access<T>(action: (pages: ContentPage[]) => { result: T; read: boolean }) {
    let result: T | undefined;
    await observe(async (view) => {
      requireReferenceAccess(view);
      const value = action(await visibleContent(session, view, index));
      result = value.result;
      return value.read;
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
  const search = register("content.search", async ({ query, offset, limit }) => access((pages) => {
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
      read: selected.length > 0,
    };
  }));
  const read = register("content.read", async ({ refs, offset, limit }) => access((pages) => {
    const selected: ContentPage[] = [];
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
    }
    return { result: selected, read: true };
  }));
  register("content.open", async ({ ref }) => access((pages) => {
    find(pages, ref);
    return { result: { openedAt: session.clock() }, read: true };
  }));
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
        await observe(async (view) => {
          requireReferenceAccess(view);
          const task = view.state.task;
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
          return true;
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
  const rejected = (error: unknown) => {
    if (error instanceof RepaFault && error.code === "restricted") {
      return {
        status: "rejected" as const,
        reason: "restricted",
        message: error.message,
        ...(error.details === undefined ? {} : { data: error.details }),
      };
    }
    throw error;
  };
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
          await observe((view) => {
            if (!view.state.restrictions.tutorAllowed) {
              throw new RepaFault("restricted", "当前任务暂时不能求助");
            }
            return true;
          });
        } catch (error) {
          return rejected(error);
        }
      },
      async beforeRun() {
        try {
          requireReferenceAccess(await session.view());
        } catch (error) {
          return rejected(error);
        }
      },
      async view() {
        const view = await session.view();
        const task = view.state.task;
        const delivery = currentDelivery(task ?? null);
        const topic = session.course.topics.get(task?.topicIds[0] ?? "");
        const phase = task?.phase;
        const shownKp = phase?.stage === "explanation" || phase?.stage === "example" ? phase.page.ref.kpId : undefined;
        const kpId = shownKp ?? delivery?.kpId ?? task?.kps.find((entry) => !entry.completed)?.kpId;
        // 先修排序用最后一条事实的时间，状态不变时视图文本不变，不打乱提示缓存。
        const day = (session.records.facts.at(-1)?.at ?? view.state.serverNow) / 86_400_000;
        const weak = (topic?.prerequisites ?? []).flatMap((id) => {
          const state = view.student[id];
          return state ? [{ id, memory: memoryAt(state, day) }] : [];
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
