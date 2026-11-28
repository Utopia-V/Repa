// Repa 以一个 Pi 扩展接入每段对话：五个工具、每轮的地图与模式、随消息附带的上下文、写前留旧版本、保住 id、确认开关。
import { stat } from "node:fs/promises";
import path from "node:path";

import { isToolCallEventType, type ExtensionAPI, type ExtensionFactory, type ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { changeOf, ensureId, idOf, inside, readOptional, resolvePage, saveVersion, setId, writeAtomic, type Page } from "../kb.js";
import { appendLog, QuestionSchema, ResultSchema } from "../log.js";
import { buildMap, formatPractices, folderListing, loadState, readMode, readSettings, RESULT_LABEL, type State } from "../map.js";
import type { PendingReply, PendingRequest } from "../protocol.js";

/** 扩展从所在的对话取得的东西。folder 是对话所在的文件夹；ask 弹出一张卡片，等学习者回应。 */
export interface Host {
  root: string;
  folder: string;
  mode(): string;
  takeAttachment(): { content: string; details?: unknown } | undefined;
  ask(toolCallId: string, request: PendingRequest, signal: AbortSignal | undefined): Promise<PendingReply>;
}

/** 换掉 Pi 自带的“编程助手”提示：写明这是学习助手、文件头的约定、资料在哪类文件夹里、各个工具什么时候用。怎样教由学习者的 AGENTS.md 和模式决定。 */
export function systemPrompt(root: string): string {
  return [
    `你是学习者的学习助手，在 Repa 里工作。知识库是文件夹 ${root}，当前目录就是这段对话所在的文件夹。`,
    "每个 Markdown 文件是一张卡片，文件名就是标题。AGENTS.md 是学习者对这个文件夹和上级文件夹的要求，以它为准。",
    "卡片之间用 [[标题]] 链接，也可以写成 [[标题|显示文字]]。文件头各项都可以不写：summary 是二三十字的概括；keep: true 表示纳入复习；requires 是先修，只写不会就学不下去的；review 是学习者定的复习日期（YYYY-MM-DD）；moc: true 的页面是专题（MOC），用链接把别处的卡片列进它所在的文件夹。",
    "文件头的 id 由程序管理，不要写、改或删。keep、requires 和专题先向学习者提议，同意后再写；review 只在学习者说了日期时写。",
    "卡片正文是学习者的文字。补充时加在合适的位置，不改写、不删去学习者写的段落；确实要改，先说明改什么。",
    "名字以 _ 开头的文件夹和克隆下来的仓库是资料（讲义、转写稿、作业），可以读，但不是卡片。",
    "想考学习者时用 quiz，出题前先用 practice_history 查这张卡片以前的题和结果；复习时这些已经附在消息里，不必再查。作答交回以后，用 grade 如实记下结果和一句讲评：作答前向你要过提示的最多记为部分正确，只是问清题干的不算。不经题目卡片的练习（例如学习者在编辑器里做完的题）也用 grade 记，给出卡片。",
    "需要别的文件夹的内容时，用 kb_search 按标题和概括检索整个知识库，用 kb_browse 浏览一个文件夹，再用 read 读原文。",
    "<repa_map> 是这个文件夹的地图，<repa_review> 是这个文件夹里到期的复习和最近没答好的练习，<repa_mode> 是现在的任务模式。学习者的消息后面可能附有一条上下文，写着正在看的卡片或复习的材料；学习者说“这里”“这一段”时，指的就是这张卡片。",
    "用中文回答。公式用 $…$ 或 $$…$$。",
  ].join("\n");
}

const QuizParams = Type.Object({
  card: Type.Optional(Type.String({ description: "所考的卡片：标题，或相对知识库的路径。还没有卡片的概念可以不给" })),
  questions: Type.Array(QuestionSchema, { minItems: 1, description: "一道或几道小题" }),
});
const GradeParams = Type.Object({
  quiz: Type.Optional(Type.String({ description: "判定的那次练习的 id（quiz 返回的），改记结果时给原来那次的 id" })),
  card: Type.Optional(Type.String({ description: "不经题目卡片的练习所属的卡片：标题或路径" })),
  result: ResultSchema,
  note: Type.String({ description: "一句讲评，例如漏了什么" }),
  external: Type.Optional(Type.String({ description: "外部评测的摘要，例如本机测试脚本的输出" })),
});
const CardParams = Type.Object({ card: Type.String({ description: "卡片的标题或相对知识库的路径" }) });
const SearchParams = Type.Object({ query: Type.String({ description: "几个关键词，用空格分开" }) });
const BrowseParams = Type.Object({ folder: Type.Optional(Type.String({ description: "相对知识库的文件夹，例如 CSAPP/第9章；不给就是知识库的根" })) });

function text(value: string, details?: unknown) {
  return { content: [{ type: "text" as const, text: value }], details };
}

function findCard(state: State, folder: string, ref: string): Page {
  const page = resolvePage(state.kb, folder, ref);
  if (!page || page.moc) throw new Error(`找不到卡片「${ref}」。可以先用 kb_search 查它的标题。`);
  return page;
}

/** 生成 Repa 扩展。Pi 重新加载时会再次调用它，所以状态都放在 host 里。 */
export function createRepaExtension(host: Host): ExtensionFactory {
  const { root } = host;
  // Agent 上次读到或写下每个文件时的修改时间。整篇 write 一个已有的文件之前，它必须读过当前的内容：
  // 否则学习者在编辑器里刚写的段落会被 Agent 凭旧印象写回去的全文悄悄盖掉（走查时实际出现过）。
  const known = new Map<string, number>();
  const mtimeOf = async (file: string) => (await stat(file).catch(() => undefined))?.mtimeMs;
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "quiz",
      label: "出题",
      description: "在对话里弹出一张题目卡片，等学习者作答。题目和作答记入练习记录，返回练习的 id 和作答；学习者关掉卡片或直接回话时返回“没有作答”。",
      parameters: QuizParams,
      async execute(toolCallId, params: Static<typeof QuizParams>, signal) {
        const state = await loadState(root);
        const card = params.card === undefined ? undefined : findCard(state, host.folder, params.card);
        const cardId = card ? await ensureId(root, card) : undefined;
        // 模型给开放题也常带一个空的 options，这里统一成没有选项。
        const questions = params.questions.map((question) => (question.options?.length ? question : { text: question.text }));
        const reply = await host.ask(toolCallId, { kind: "quiz", questions, ...(card ? { card: card.path } : {}) }, signal);
        const answers = reply.answers ?? null;
        const entry = await appendLog(root, { kind: "quiz", ...(cardId ? { card: cardId } : { folder: host.folder }), questions, answers });
        const details = { quiz: entry.id, card: card?.path, answers };
        if (answers === null) return text(`练习 ${entry.id}：学习者没有作答。`, details);
        return text(`练习 ${entry.id} 的作答：\n${answers.map((answer, index) => `${index + 1}. ${answer || "（空）"}`).join("\n")}`, details);
      },
    });

    pi.registerTool({
      name: "grade",
      label: "判定",
      description: "记下一次练习的结果（pass 正确、partial 部分正确、fail 错误）和一句讲评。经题目卡片的练习给出 quiz；不经题目卡片的给出 card。改记就再调用一次，给出原来那次的 id。",
      parameters: GradeParams,
      async execute(_toolCallId, params: Static<typeof GradeParams>) {
        if (params.quiz === undefined && params.card === undefined) throw new Error("grade 要给出 quiz（判定的那次练习）或 card（不经题目卡片的练习所属的卡片）。");
        const state = await loadState(root);
        if (params.quiz !== undefined && !state.practices.some((practice) => practice.id === params.quiz)) throw new Error(`没有 id 为 ${params.quiz} 的练习。`);
        const card = params.card === undefined ? undefined : findCard(state, host.folder, params.card);
        const cardId = card ? await ensureId(root, card) : undefined;
        const entry = await appendLog(root, {
          kind: "grade",
          ...(params.quiz === undefined ? {} : { quiz: params.quiz }),
          ...(cardId === undefined ? {} : { card: cardId }),
          result: params.result,
          note: params.note,
          ...(params.external === undefined ? {} : { external: params.external }),
        });
        return text(`已记下：${RESULT_LABEL[params.result]}。`, { quiz: params.quiz ?? entry.id, result: params.result, note: params.note });
      },
    });

    pi.registerTool({
      name: "practice_history",
      label: "以前的练习",
      description: "取出一张卡片以前的题目、作答和结果，最近的在前。出题前用它查旧题，可以重用，也可以换一道。",
      parameters: CardParams,
      async execute(_toolCallId, params: Static<typeof CardParams>) {
        const state = await loadState(root);
        const card = findCard(state, host.folder, params.card);
        return text(`${card.path}\n${formatPractices(state, card.id, 10)}`);
      },
    });

    pi.registerTool({
      name: "kb_search",
      label: "检索知识库",
      description: "按标题和概括检索整个知识库，返回最相关的页面路径和概括。读原文用 read。",
      parameters: SearchParams,
      async execute(_toolCallId, params: Static<typeof SearchParams>) {
        const { kb } = await loadState(root);
        const terms = params.query.toLowerCase().split(/\s+/u).filter(Boolean);
        const scored = kb.pages
          .map((page) => {
            const haystack = `${page.title} ${page.summary}`.toLowerCase();
            return { page, score: terms.filter((term) => haystack.includes(term)).length };
          })
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 20);
        if (!scored.length) return text("没有标题或概括含这些词的页面。");
        return text(scored.map(({ page }) => `- ${page.path}${page.moc ? "（专题）" : ""}：${page.summary}`).join("\n"));
      },
    });

    pi.registerTool({
      name: "kb_browse",
      label: "浏览文件夹",
      description: "列出知识库某个文件夹的卡片和概括、专题列进来的卡片、先修和子文件夹。",
      parameters: BrowseParams,
      async execute(_toolCallId, params: Static<typeof BrowseParams>) {
        const state = await loadState(root);
        const folder = (params.folder ?? "").replace(/^\/+|\/+$/gu, "");
        if (!state.kb.folders.includes(folder)) throw new Error(`知识库里没有 ${folder} 这个文件夹。`);
        return text([`【${folder || "知识库"}】`, ...folderListing(state, folder)].join("\n"));
      },
    });

    pi.on("before_agent_start", async (event) => {
      const state = await loadState(root);
      const map = buildMap(state, host.folder);
      event.systemPromptOptions.sections.repa_map = map.map;
      event.systemPromptOptions.sections.repa_review = map.review;
      event.systemPromptOptions.sections.repa_mode = await readMode(root, host.mode());
      const attachment = host.takeAttachment();
      return attachment === undefined ? undefined : { message: { customType: "repa-context", ...attachment, display: false } };
    });

    // Pi 依次等待 tool_call 的处理完成才运行工具，所以确认和留旧版本都在改写之前。
    pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
      const settings = await readSettings(root);
      if (isToolCallEventType("bash", event)) {
        return settings.confirmCommands ? confirm(event.toolCallId, "bash", event.input.command, ctx.signal) : undefined;
      }
      const target = isToolCallEventType("write", event) || isToolCallEventType("edit", event) ? event.input.path : undefined;
      if (target === undefined) return undefined;
      const file = path.resolve(ctx.cwd, target);
      const rel = inside(root, file) ? path.relative(root, file) : undefined;
      if (settings.confirmEdits) {
        const blocked = await confirm(event.toolCallId, event.toolName, rel ?? file, ctx.signal);
        if (blocked) return blocked;
      }
      const current = await mtimeOf(file);
      if (isToolCallEventType("write", event) && current !== undefined && known.get(file) !== current) {
        return { block: true, reason: `${target} 在你上次读过以后被改过，或者你还没有读过它。先用 read 读当前的内容，再整篇写入。` };
      }
      if (rel !== undefined) await saveVersion(root, rel, event.toolCallId);
      return undefined;
    });

    // id 归程序所有：改写把它丢了或改了，就在改写完成以后写回，练习记录不会悄悄断开。
    pi.on("tool_result", async (event, ctx) => {
      if (!["read", "write", "edit"].includes(event.toolName) || event.isError) return undefined;
      const file = path.resolve(ctx.cwd, String(event.input.path));
      const result = event.toolName === "read" ? undefined : await restoreId(file, event.toolCallId);
      const mtime = await mtimeOf(file);
      if (mtime !== undefined) known.set(file, mtime);
      return result;
    });
  };

  async function restoreId(file: string, toolCallId: string) {
    if (!inside(root, file) || !file.endsWith(".md")) return undefined;
    const { before } = await changeOf(root, path.relative(root, file), toolCallId);
    const id = before === undefined ? undefined : idOf(before);
    const now = await readOptional(file);
    if (id === undefined || now === undefined || idOf(now) === id) return undefined;
    await writeAtomic(file, setId(now, id));
    return { content: [{ type: "text" as const, text: `已写入。文件头的 id 由程序管理，已恢复为 ${id}。` }] };
  }

  async function confirm(toolCallId: string, tool: string, target: string, signal: AbortSignal | undefined): Promise<ToolCallEventResult | undefined> {
    const reply = await host.ask(toolCallId, { kind: "confirm", tool, target }, signal);
    if (reply.approve) return undefined;
    return { block: true, reason: reply.reason ? `学习者没有同意，理由是：${reply.reason}` : "学习者没有同意。" };
  }
}
