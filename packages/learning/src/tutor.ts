import { isDeepStrictEqual } from "node:util";
import { RepaFault } from "@repa/base";
import type { AgentDefinition, MessageDecision, PluginMethod, Tool } from "@repa/base/plugin";
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
import type { LearningSession } from "./session.js";
import { topicMemory } from "./student-model.js";
import { currentDelivery, referenceContent, requireReferenceAccess, visibleContent } from "./tutor-content.js";
import { pagedText, pagesText, searchText, taskText, viewText } from "./tutor-text.js";

export const TUTOR_AGENT = "learning-tutor";
/** 前端的 content.search 与 content.read 一次返回的上限；给模型的工具输出由底座的上限约束，不用它。 */
const TEXT_BYTES = 16 * 1024;
const line = Type.Optional(Type.Integer({ minimum: 1, description: "从第几行开始交回，默认 1；文字太长时上一次的末尾会写明接着读的 line" }));
const TaskParametersSchema = object({ line });
const SearchParametersSchema = object({
  query: Type.String({ maxLength: 200, description: "要找的词：概念名、代码片段或知识点编号；空字符串列出全部可读的内容" }),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "从第几条结果开始，默认 0" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "最多返回几条，默认 10" })),
  line,
});
const ReadParametersSchema = object({
  ids: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
    minItems: 1, maxItems: 8, description: "learning_search 结果里的内容编号",
  }),
  line,
});

/** 辅导的三项工具：名称、说明与参数固定，执行时交给当前课程的会话。 */
export const TUTOR_TOOLS = [
  {
    name: "learning_task",
    description: "读取学习者当前的任务：正在读的讲解或例题，或者正在做的题，连同学习者的作答、判分结果和题解。",
    parameters: TaskParametersSchema,
  },
  {
    name: "learning_search",
    description: "在当前任务和学过的内容里搜索讲解、例题、知识点、概念卡和已开放的题解。每条结果给出内容编号、名称和一段摘录，用 learning_read 按编号读取全文。",
    parameters: SearchParametersSchema,
  },
  {
    name: "learning_read",
    description: "按 learning_search 给出的内容编号读取全文，一次最多 8 个。",
    parameters: ReadParametersSchema,
  },
] as const;

/** 辅导 Agent 随学习状态变化的部分：提问前的判断与视图。 */
export type TutorHooks = Required<Pick<AgentDefinition, "beforeMessage" | "beforeRun" | "view">>;

/** 一门课的辅导：前端读内容的方法、辅导工具的执行和辅导 Agent 的判断，都绑在这门课的会话上。 */
export interface Tutor {
  methods: Record<string, PluginMethod>;
  tools: Tool[];
  hooks: TutorHooks;
}

/**
 * 辅导 Agent 的定义。工具与职责说明固定；提问前的判断和视图交给 hooks() 给出的当前课程，
 * 换用课程以后不必重建 Agent，已有的辅导会话照常可用。
 */
export function tutorAgent(hooks: () => TutorHooks): AgentDefinition {
  return {
    id: TUTOR_AGENT,
    direct: true,
    description: "围绕当前学习任务讲解，并即时回顾已学知识",
    // 没有 read：空间里写到一半的 course/ 有复习和测验题的答案，辅导读得到就可能在作答期间说出来。
    // 辅导工具的输出自己分批，不靠底座截断以后用 read 续取，见 tutor-text.ts。
    tools: TUTOR_TOOLS.map((tool) => tool.name),
    instructions: () => [
      "你是学习辅导老师，在学习者卡住时帮助其弄懂当前的题目和相关知识。",
      "先用 learning_task 看当前的题目、学习者的作答和判分结果；需要讲解、例题或概念卡时，用 learning_search 查找，再用 learning_read 按编号读取。",
      "提到学过的知识点时写成 [名称](repa:concept/知识点编号) 链接，便于学习者即时回顾；教学推进和正式判分由程序负责。",
      "回答像老师当面说话：先直接回答学习者问的那一点，通常几句话就够，答错时指出这一次具体错在哪里；不用客套话开头，只在确实需要对照时才用表格或分节。只讲当前题目和已经学过的内容，不提前讲还没学到的东西，学习者要的是弄懂眼前这一步。",
    ].join(""),
    beforeMessage: (message) => hooks().beforeMessage(message),
    beforeRun: () => hooks().beforeRun(),
    view: () => hooks().view(),
  };
}

export async function connectTutor(session: LearningSession): Promise<Tutor> {
  const index = await referenceContent(session.course.course);
  const titles = new Map(index.map((entry) => [entry.ref.id, entry.title]));
  const methods: Record<string, PluginMethod> = {};
  /**
   * 按当前状态授权以后读内容。授权和取内容与学习记录的写入走同一个串行入口，
   * 所以读取进行到一半时出题，读到的仍是出题之前允许看的内容，不会跨进作答期间。
   */
  async function access<T>(action: (pages: ContentPage[]) => T): Promise<T> {
    return session.records.serial(async () => {
      const view = requireReferenceAccess(await session.view());
      return action(await visibleContent(session, view, index));
    });
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
    return { hits: selected, nextOffset: offset + selected.length < hits.length ? offset + selected.length : null };
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
    return selected;
  }));
  register("content.open", async ({ ref }) => access((pages) => {
    find(pages, ref);
    return { openedAt: session.clock() };
  }));
  // 工具与前端方法共用授权（access），只是给模型写成分行文字：不带前端的字段与编号。
  // 辅导没有 read，长文字不交给底座截断，按行分批交回（tutor-text.ts 的 pagedText），模型带上 line 接着读。
  const tools: Tool[] = [
    {
      ...TUTOR_TOOLS[0],
      async execute(raw) {
        const { line: from = 1 } = parse(TaskParametersSchema, raw);
        return session.records.serial(async () => {
          const view = requireReferenceAccess(await session.view());
          return { text: pagedText(taskText(view.state.task, session.course), from, TUTOR_TOOLS[0].name) };
        });
      },
    },
    {
      ...TUTOR_TOOLS[1],
      async execute(raw) {
        const { line: from = 1, ...input } = { offset: 0, limit: 10, ...parse(SearchParametersSchema, raw) };
        const result = await search(input);
        return { text: pagedText(searchText(input.query, input.offset, result ?? { hits: [], nextOffset: null }, titles, session.course), from, TUTOR_TOOLS[1].name) };
      },
    },
    {
      ...TUTOR_TOOLS[2],
      async execute(raw) {
        const { ids: requested, line: from = 1 } = parse(ReadParametersSchema, raw);
        const ids = [...new Set(requested)];
        const pages = await access((visible) => {
          const missing = ids.filter((id) => !visible.some((page) => page.ref.id === id));
          if (missing.length) {
            throw new RepaFault("invalid_input", `没有编号为 ${missing.join("、")} 的内容，或者还没学到；用 learning_search 查找能读的内容`);
          }
          return ids.flatMap((id) => visible.filter((page) => page.ref.id === id));
        });
        return { text: pagedText(pagesText(pages, titles, session.course), from, TUTOR_TOOLS[2].name) };
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
    tools,
    hooks: {
      async beforeMessage(): Promise<MessageDecision | void> {
        try {
          if (!(await session.view()).state.restrictions.tutorAllowed) {
            throw new RepaFault("restricted", "作答期间不能提问，答完以后再问");
          }
        } catch (error) {
          return rejected(error);
        }
      },
      async beforeRun(): Promise<MessageDecision | void> {
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
    },
  };
}
