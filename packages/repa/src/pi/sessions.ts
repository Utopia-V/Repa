// 对话：每段对话一个 Pi 会话，以所在层的文件夹为工作目录；学习对话存在 .repa/sessions/<层>/，复习对话存在 .repa/reviews/<层>/。
// Pi 的类型只出现在 src/pi/ 里，知识库、练习记录、复习、地图和 HTTP 层都不导入它们。
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type AgentSessionEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";

import { inside, RepaFault, resolveIn, type Page } from "../kb.js";
import { buildMap, LEARN_MODE, loadState, readMode, readSettings, REVIEW_MODE, reviewMaterial, updateSettings } from "../map.js";
import { applyEvent, type Conversation, type Item, type PendingReply, type PendingRequest, type SessionInfo, type UiEvent } from "../protocol.js";
import { createRepaExtension, systemPrompt } from "./extension.js";

type Kind = SessionInfo["kind"];

// 内存里的一段对话。conversation 用界面同一个 applyEvent 更新，之后连上的界面直接取它作快照。
interface Live {
  info: SessionInfo;
  session: AgentSession;
  conversation: Conversation;
  resolvers: Map<string, (reply: PendingReply) => void>;
  listeners: Set<(event: UiEvent) => void>;
  attachment?: string;
  agentsStamp: string;
}

/** 对话列表里的一项。 */
export interface SessionSummary {
  id: string;
  title: string;
  modified: string;
}

const MODE_ENTRY = "repa-mode";

/** 本进程里打开的全部对话。切走的对话留在内存里继续运行，切回去还能看到。 */
export class Sessions {
  private readonly live = new Map<string, Live>();
  private readonly byToolCall = new Map<string, Live>();

  private constructor(private readonly root: string, private readonly runtime: ModelRuntime, private readonly agentDir: string) {}

  /** 模型与登录沿用 Pi：凭据在 Pi 全局目录的 auth.json。modelsStorePath 只供开发时把模型缓存写到别处；测试传入自己的 runtime 和 agentDir。 */
  static async create(root: string, options: { runtime?: ModelRuntime; agentDir?: string; modelsStorePath?: string } = {}): Promise<Sessions> {
    const agentDir = options.agentDir ?? getAgentDir();
    const runtime = options.runtime ?? await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      ...(options.modelsStorePath ? { modelsStorePath: options.modelsStorePath } : {}),
    });
    return new Sessions(root, runtime, agentDir);
  }

  /** 有凭据的模型。 */
  async models(): Promise<Array<{ provider: string; id: string; name: string }>> {
    return (await this.runtime.getAvailable()).map((model) => ({ provider: model.provider, id: model.id, name: model.name }));
  }

  private dir(kind: Kind, folder: string): string {
    return path.join(this.root, ".repa", kind === "learn" ? "sessions" : "reviews", folder);
  }

  private async saved(kind: Kind, folder: string) {
    const infos = await SessionManager.list(resolveIn(this.root, folder), this.dir(kind, folder));
    return infos.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  }

  /** 一层的学习对话和复习对话，最近的在前。 */
  async list(folder: string): Promise<Record<"learn" | "reviews", SessionSummary[]>> {
    const summarize = (infos: Awaited<ReturnType<Sessions["saved"]>>) => infos.map((info) => ({ id: info.id, title: info.name ?? info.firstMessage.slice(0, 40), modified: info.modified.toISOString() }));
    return { learn: summarize(await this.saved("learn", folder)), reviews: summarize(await this.saved("review", folder)) };
  }

  /** 最近用过的几层，按学习对话文件的修改时间排；第一项就是启动时接着的那一层。 */
  async recentFolders(limit = 6): Promise<string[]> {
    const base = path.join(this.root, ".repa", "sessions");
    const names = (await readdir(base, { recursive: true }).catch(() => [])).filter((name) => name.endsWith(".jsonl"));
    const files = await Promise.all(names.map(async (name) => ({ name, mtime: (await stat(path.join(base, name))).mtimeMs })));
    const folders = files.sort((a, b) => b.mtime - a.mtime).map((file) => path.dirname(file.name).replace(/^\.$/u, ""));
    return [...new Set(folders)].slice(0, limit);
  }

  /** 打开一段对话：给了 id 就打开它，fresh 就新开一段，否则接着这一层最近的学习对话，没有就新开。 */
  async open(request: { folder: string; id?: string; fresh?: boolean }): Promise<SessionInfo> {
    const { folder, id } = request;
    if (id !== undefined && this.live.has(id)) return this.get(id).info;
    const cwd = resolveIn(this.root, folder);
    if (!request.fresh) {
      for (const kind of ["learn", "review"] as const) {
        const infos = await this.saved(kind, folder);
        const found = id === undefined ? (kind === "learn" ? infos[0] : undefined) : infos.find((info) => info.id === id);
        if (found) return this.live.get(found.id)?.info ?? (await this.start(kind, folder, SessionManager.open(found.path, this.dir(kind, folder), cwd))).info;
      }
      if (id !== undefined) throw new RepaFault("not_found", "没有这段对话。");
    }
    return (await this.start("learn", folder, SessionManager.create(cwd, this.dir("learn", folder)))).info;
  }

  /** 新开一段复习对话：卡片所在的层、抽查复习模式，发出“复习「标题」”，卡片全文和最近的练习附在这条消息里。 */
  async review(page: Page): Promise<SessionInfo> {
    const manager = SessionManager.create(resolveIn(this.root, page.folder), this.dir("review", page.folder));
    const live = await this.start("review", page.folder, manager, REVIEW_MODE);
    live.attachment = await reviewMaterial(await loadState(this.root), page);
    this.run(live, `复习「${page.title}」`);
    return live.info;
  }

  private async start(kind: Kind, folder: string, manager: SessionManager, mode?: string): Promise<Live> {
    const cwd = resolveIn(this.root, folder);
    const savedMode = manager.getEntries().flatMap((entry) => (entry.type === "custom" && entry.customType === MODE_ENTRY && typeof entry.data === "string" ? [entry.data] : [])).at(-1);
    const info: SessionInfo = { id: manager.getSessionId(), folder, kind, mode: mode ?? savedMode ?? (kind === "learn" ? LEARN_MODE : REVIEW_MODE) };
    const partial: Omit<Live, "session"> = {
      info,
      conversation: { session: info, items: itemsOf(manager.getBranch(), this.root, cwd), pending: [], running: false },
      resolvers: new Map(),
      listeners: new Set(),
      agentsStamp: await this.agentsStamp(folder),
    };
    const live = partial as Live;
    const extension = createRepaExtension({
      root: this.root,
      folder,
      mode: () => live.info.mode,
      takeAttachment: () => {
        const attachment = live.attachment;
        delete live.attachment;
        return attachment;
      },
      ask: (toolCallId, request, signal) => this.ask(live, toolCallId, request, signal),
    });
    // 只读知识库之内的 AGENTS.md 和技能：知识库外层恰好有一份时不混进来，Pi 全局目录里的也一并排除。
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      extensionFactories: [extension],
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: systemPrompt(this.root),
      appendSystemPromptOverride: () => [],
      agentsFilesOverride: ({ agentsFiles }) => ({ agentsFiles: agentsFiles.filter((file) => inside(this.root, file.path)) }),
      skillsOverride: (base) => ({ ...base, skills: base.skills.filter((skill) => inside(this.root, skill.filePath)) }),
    });
    await loader.reload();
    const model = manager.getEntries().length === 0 ? await this.defaultModel() : undefined;
    // 设置只放在内存里：Repa 的设置在 .repa/settings.json，不写 Pi 的全局设置。
    const settingsManager = SettingsManager.inMemory();
    const { session } = await createAgentSession({ cwd, agentDir: this.agentDir, modelRuntime: this.runtime, resourceLoader: loader, sessionManager: manager, settingsManager, ...(model ? { model } : {}) });
    await session.bindExtensions({});
    live.session = session;
    if (session.model) live.info.model = `${session.model.provider}/${session.model.id}`;
    session.subscribe((event) => {
      const ui = uiEventOf(event, this.root, cwd);
      if (ui) this.emit(live, ui);
    });
    this.live.set(info.id, live);
    return live;
  }

  private async defaultModel() {
    const [provider = "", ...rest] = (await readSettings(this.root)).model?.split("/") ?? [];
    return this.runtime.getModel(provider, rest.join("/")) ?? (await this.runtime.getAvailable())[0];
  }

  // 这一层到知识库根的 AGENTS.md 的修改时间；变了就在下一条消息前让 Pi 重新加载。
  private async agentsStamp(folder: string): Promise<string> {
    const parts = folder === "" ? [] : folder.split("/");
    const chain = ["", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))];
    const stamps = await Promise.all(chain.map(async (item) => (await stat(path.join(this.root, item, "AGENTS.md")).catch(() => undefined))?.mtimeMs ?? 0));
    return stamps.join(",");
  }

  private ask(live: Live, toolCallId: string, request: PendingRequest, signal: AbortSignal | undefined): Promise<PendingReply> {
    return new Promise((resolve) => {
      live.resolvers.set(toolCallId, (reply) => {
        if (!live.resolvers.delete(toolCallId)) return;
        this.byToolCall.delete(toolCallId);
        this.emit(live, { type: "resolved", id: toolCallId });
        resolve(reply);
      });
      this.byToolCall.set(toolCallId, live);
      this.emit(live, { type: "pending", pending: { ...request, id: toolCallId } });
      signal?.addEventListener("abort", () => this.answer(toolCallId, { answers: null, approve: false, reason: "学习者停止了这一轮。" }), { once: true });
    });
  }

  /** 交上题目卡片的作答，或回应一张确认卡片。 */
  answer(toolCallId: string, reply: PendingReply): void {
    const resolve = this.byToolCall.get(toolCallId)?.resolvers.get(toolCallId);
    if (!resolve) throw new RepaFault("not_found", "这张卡片已经不在等待回应了。");
    resolve(reply);
  }

  private get(id: string): Live {
    const live = this.live.get(id);
    if (!live) throw new RepaFault("not_found", "这段对话没有打开。");
    return live;
  }

  /** 订阅一段对话：先同步收到一份快照，之后是增量。返回取消订阅的函数。 */
  subscribe(id: string, listener: (event: UiEvent) => void): () => void {
    const live = this.get(id);
    const { items, pending } = live.conversation;
    listener({ type: "snapshot", session: live.info, items, pending, running: live.session.isStreaming });
    live.listeners.add(listener);
    return () => live.listeners.delete(listener);
  }

  /**
   * 发一条消息，viewing 是学习者正在看的卡片。还在等回应的卡片按“没有作答”“没有同意”交回。Agent 正在回复时，
   * 这条消息在当前的工具调用结束后插进去；否则开始新的一轮，这一层的 AGENTS.md 变了就先让 Pi 重新加载。
   */
  async prompt(id: string, message: string, viewing: string | undefined): Promise<void> {
    const live = this.get(id);
    for (const toolCallId of [...live.resolvers.keys()]) this.answer(toolCallId, { answers: null, approve: false, reason: "学习者没有回应这张卡片，直接回了话。" });
    if (live.session.isStreaming) return live.session.prompt(message, { streamingBehavior: "steer" });
    const stamp = await this.agentsStamp(live.info.folder);
    if (stamp !== live.agentsStamp) await live.session.reload();
    live.agentsStamp = stamp;
    if (viewing) live.attachment = [`学习者正在看：${viewing}`, live.attachment].filter(Boolean).join("\n\n");
    this.run(live, message);
  }

  // 一轮可能持续很久，不等它结束就回应请求；出错时作为一条错误显示在对话里。
  private run(live: Live, message: string): void {
    live.session.prompt(message).catch((error: unknown) => this.emit(live, { type: "item", item: { type: "error", text: error instanceof Error ? error.message : String(error) } }));
  }

  /** 停止这一轮。 */
  async abort(id: string): Promise<void> {
    await this.get(id).session.abort();
  }

  /**
   * 手动压缩。对话还短时 Pi 不压缩：它保留最近约 2 万 token 原样不动，没有更早的内容可压。Pi 对这种情况和其他失败
   * （没有模型、刚压缩过、被取消、模型出错）都只抛出一个普通的 Error，判断“够不够压”的 prepareCompaction 也不在公开导出里，
   * 所以压缩失败一律作为“没有压缩”连同 Pi 给出的原因返回，不靠匹配报错文字。
   */
  async compact(id: string): Promise<{ compacted: true } | { compacted: false; reason: string }> {
    try {
      await this.get(id).session.compact();
      return { compacted: true };
    } catch (error) {
      if (error instanceof RepaFault) throw error;
      return { compacted: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 换模型；它同时成为以后新对话的默认模型。 */
  async setModel(id: string, provider: string, modelId: string): Promise<void> {
    const live = this.get(id);
    const model = this.runtime.getModel(provider, modelId);
    if (!model) throw new RepaFault("not_found", `没有模型 ${provider}/${modelId}。`);
    await live.session.setModel(model);
    await updateSettings(this.root, { model: `${provider}/${modelId}` });
    this.update(live, { model: `${provider}/${modelId}` });
  }

  /** 换模式：从下一轮起，Pi 只追加模式这一段。 */
  setMode(id: string, mode: string): void {
    const live = this.get(id);
    live.session.sessionManager.appendCustomEntry(MODE_ENTRY, mode);
    this.update(live, { mode });
  }

  private update(live: Live, change: Partial<SessionInfo>): void {
    live.info = { ...live.info, ...change };
    this.emit(live, { type: "session", session: live.info });
  }

  /** 上下文占比与注入的内容：读到的 AGENTS.md、当前模式、地图全文，以及最近随消息附带的上下文。 */
  async context(id: string) {
    const live = this.get(id);
    const usage = live.session.getContextUsage();
    const attachments = live.session.sessionManager.getBranch()
      .flatMap((entry) => (entry.type === "custom_message" && entry.customType === "repa-context" ? [textOf(entry.content)] : []));
    return {
      usage: usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } : null,
      agentsFiles: live.session.resourceLoader.getAgentsFiles().agentsFiles.map((file) => path.relative(this.root, file.path)),
      mode: await readMode(this.root, live.info.mode),
      ...buildMap(await loadState(this.root), live.info.folder),
      attachments: attachments.slice(-3),
    };
  }

  private emit(live: Live, event: UiEvent): void {
    live.conversation = applyEvent(live.conversation, event);
    for (const listener of live.listeners) listener(event);
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  const parts = Array.isArray(content) ? content.flatMap((part: { type?: unknown; text?: unknown }) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])) : [];
  const text = parts.join("\n");
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

// write/edit 改的若是知识库里的文件，记下它相对知识库的路径，界面据此显示改动与撤回。
function toolItem(id: string, name: string, args: unknown, root: string, cwd: string): Item {
  const record = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const target = (name === "write" || name === "edit") && typeof record.path === "string" ? path.resolve(cwd, record.path) : undefined;
  const change = target !== undefined && inside(root, target) ? { change: path.relative(root, target) } : {};
  return { type: "tool", id, name, args: record, done: false, isError: false, output: "", ...change };
}

// 把 Pi 的事件换成界面用的几种；其余的事件界面不需要。
function uiEventOf(event: AgentSessionEvent, root: string, cwd: string): UiEvent | undefined {
  switch (event.type) {
    case "message_start":
      if (event.message.role === "user") return { type: "item", item: { type: "user", text: textOf(event.message.content) } };
      return event.message.role === "assistant" ? { type: "item", item: { type: "assistant", text: "" } } : undefined;
    case "message_update":
      return event.assistantMessageEvent.type === "text_delta" ? { type: "delta", text: event.assistantMessageEvent.delta } : undefined;
    case "message_end":
      return event.message.role === "assistant" && event.message.stopReason === "error" ? { type: "item", item: { type: "error", text: event.message.errorMessage ?? "模型调用出错。" } } : undefined;
    case "tool_execution_start":
      return { type: "item", item: toolItem(event.toolCallId, event.toolName, event.args, root, cwd) };
    case "tool_execution_end": {
      const result = event.result as { content?: unknown; details?: unknown };
      return { type: "tool_end", id: event.toolCallId, isError: event.isError, output: textOf(result.content), details: result.details };
    }
    case "agent_start":
    case "agent_settled":
      return { type: "running", running: event.type === "agent_start" };
    case "compaction_end":
      return event.result ? { type: "item", item: { type: "compaction" } } : undefined;
    default:
      return undefined;
  }
}

// 从会话文件重建对话：不显示的附带上下文不列出，工具结果接到对应的调用上。
function itemsOf(entries: SessionEntry[], root: string, cwd: string): Item[] {
  let items: Item[] = [];
  for (const entry of entries) {
    if (entry.type === "compaction") items.push({ type: "compaction" });
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") items.push({ type: "user", text: textOf(message.content) });
    if (message.role === "assistant") {
      const text = textOf(message.content);
      if (text) items.push({ type: "assistant", text });
      for (const part of message.content) if (part.type === "toolCall") items.push(toolItem(part.id, part.name, part.arguments, root, cwd));
      if (message.stopReason === "error") items.push({ type: "error", text: message.errorMessage ?? "模型调用出错。" });
    }
    if (message.role === "toolResult") {
      const end: UiEvent = { type: "tool_end", id: message.toolCallId, isError: message.isError, output: textOf(message.content), details: message.details };
      items = applyEvent({ items, pending: [], running: false }, end).items;
    }
  }
  return items;
}
