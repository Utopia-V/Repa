import { isDeepStrictEqual } from "node:util";
import { RepaFault } from "@repa/base";
import type { PluginInstance, PluginMethod, Tool } from "@repa/base/plugin";
import { object, parse } from "@repa/base/protocol";
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
import { topicMemory } from "./student-model.js";
import { currentDelivery, referenceContent, requireReferenceAccess, visibleContent } from "./tutor-content.js";
import { pagesText, searchText, taskText, viewText } from "./tutor-text.js";

export const TUTOR_AGENT = "learning-tutor";
/** 前端的 content.search 与 content.read 一次返回的上限；给模型的工具输出由底座的上限约束，不用它。 */
const TEXT_BYTES = 16 * 1024;
const TaskParametersSchema = object({});
const SearchParametersSchema = object({
  query: Type.String({ maxLength: 200, description: "要找的词：概念名、代码片段或知识点编号；空字符串列出全部可读的内容" }),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "从第几条结果开始，默认 0" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "最多返回几条，默认 10" })),
});
const ReadParametersSchema = object({
  ids: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
    minItems: 1, maxItems: 8, description: "learning_search 结果里的内容编号",
  }),
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
    methods[name] = {
      parameters: learningMethods[name].input,
      result: learningMethods[name].result,
      // schema 索引联合在这里丢失 M，parse 已按本方法校验。
      invoke: async (raw) => invoke(parse(learningMethods[name].input, raw) as LearningInput<M>),
    };
    return invoke;
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
  register("content.read", async ({ refs, offset, limit }) => access((pages) => {
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
  // 工具与前端方法共用授权和求助记录（access、observe），只是给模型写成分行文字：不带前端的字段与编号，也不分页，
  // 过长时由底座省略中间、保存全文，模型用 read 按行续取。
  const tools: Tool[] = [
    {
      name: "learning_task",
      description: "读取学习者当前的任务：正在读的讲解或例题，或者正在做的题，连同学习者的作答、判分结果和题解。",
      parameters: TaskParametersSchema,
      async execute(raw) {
        parse(TaskParametersSchema, raw);
        let text = "";
        await observe((view) => {
          requireReferenceAccess(view);
          text = taskText(view.state.task, session.course);
          return true;
        });
        return { text };
      },
    },
    {
      name: "learning_search",
      description: "在当前任务和学过的内容里搜索讲解、例题、知识点、概念卡和已开放的题解。每条结果给出内容编号、名称和一段摘录，用 learning_read 按编号读取全文。",
      parameters: SearchParametersSchema,
      async execute(raw) {
        const input = { offset: 0, limit: 10, ...parse(SearchParametersSchema, raw) };
        const result = await search(input);
        return { text: searchText(input.query, input.offset, result ?? { hits: [], nextOffset: null }, titles, session.course) };
      },
    },
    {
      name: "learning_read",
      description: "按 learning_search 给出的内容编号读取全文，一次最多 8 个。",
      parameters: ReadParametersSchema,
      async execute(raw) {
        const ids = [...new Set(parse(ReadParametersSchema, raw).ids)];
        const pages = await access((visible) => {
          const missing = ids.filter((id) => !visible.some((page) => page.ref.id === id));
          if (missing.length) {
            throw new RepaFault("invalid_input", `没有编号为 ${missing.join("、")} 的内容，或者还没学到；用 learning_search 查找能读的内容`);
          }
          return { result: ids.flatMap((id) => visible.filter((page) => page.ref.id === id)), read: true };
        });
        return { text: pagesText(pages ?? [], titles, session.course) };
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
      // read 只为续取被底座省略的长输出：工具结果超过上限时，全文存在 .repa/tool-output/，模型按提示用 read 按行读取。
      tools: [...tools.map((tool) => tool.name), "read"],
      instructions: () => [
        "你是学习辅导老师，在学习者卡住时帮助其弄懂当前的题目和相关知识。",
        "先用 learning_task 看当前的题目、学习者的作答和判分结果；需要讲解、例题或概念卡时，用 learning_search 查找，再用 learning_read 按编号读取。",
        "提到学过的知识点时写成 [名称](repa:concept/知识点编号) 链接，便于学习者即时回顾；教学推进和正式判分由程序负责。",
      ].join(""),
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
        const topic = session.course.topics.get(task?.topics[0]?.id ?? "");
        const phase = task?.phase;
        const shownKp = phase?.stage === "explanation" || phase?.stage === "example" ? phase.page.ref.kpId : undefined;
        const kpId = shownKp ?? delivery?.kpId ?? task?.kps.find((entry) => !entry.completed)?.kpId;
        // 只有课按知识点记进度；复习和测验的知识点计数恒为零，写出来反而误导。
        const kp = task?.kind === "lesson" ? task.kps.find((entry) => entry.kpId === kpId) : undefined;
        // 先修排序用最后一条事实的时间，状态不变时视图文本不变，不打乱提示缓存；时钟回拨时与学生模型一样不让时间倒退。
        const time = session.records.facts.at(-1)?.at ?? view.state.serverNow;
        const weak = (topic?.prerequisites ?? [])
          .filter((id) => view.student[id] !== undefined)
          .map((id) => ({ id, memory: topicMemory(view.student, id, time) }))
          .sort((left, right) => left.memory - right.memory || left.id.localeCompare(right.id))
          .slice(0, 3);
        return viewText(task ?? null, session.course, kp, weak.map((entry) => entry.id));
      },
    }],
  };
}
