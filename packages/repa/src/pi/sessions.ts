// 对话：每段对话一个 Pi 会话，以所在的文件夹为工作目录；学习对话存在 .repa/sessions/<文件夹>/，复习对话存在 .repa/reviews/<文件夹>/。
// Pi 的类型只出现在 src/pi/ 里，知识库、练习记录、复习、地图和 HTTP 层都不导入它们。
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type AgentSessionEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";

import { configDir } from "../config.js";
import { inside, RepaFault, resolveIn, type Page } from "../kb.js";
import { buildMap, LEARN_MODE, loadState, readMode, readSettings, REVIEW_MODE, reviewMaterial, updateSettings } from "../map.js";
import { applyEvent, type Conversation, type Item, type PendingReply, type PendingRequest, type SessionInfo, type SessionStatus, type UiEvent } from "../protocol.js";
import { createRepaExtension, systemPrompt } from "./extension.js";

type Kind = SessionInfo["kind"];
type ThinkingLevel = Parameters<AgentSession["setThinkingLevel"]>[0];

// 内存里的一段对话。conversation 用界面同一个 applyEvent 更新，之后连上的界面直接取它作快照。
interface Live {
  info: SessionInfo;
  session: AgentSession;
  conversation: Conversation;
  resolvers: Map<string, (reply: PendingReply) => void>;
  listeners: Set<(event: UiEvent) => void>;
  attachment?: { content: string; details?: unknown };
  quote?: string;
  agentsStamp: string;
}

/** 对话列表里的一项。running 是正在回复，waiting 是有题目卡片或确认卡片在等回应。 */
export interface SessionSummary {
  id: string;
  folder: string;
  kind: Kind;
  title: string;
  created: string;
  modified: string;
  running: boolean;
  waiting: boolean;
}

/** 列对话的条件：不给 folder 就是全部文件夹；q 按标题和全文筛；reviews 为真时包含复习对话。 */
export interface ListOptions {
  folder?: string;
  q?: string;
  reviews?: boolean;
  sort?: "recent" | "oldest" | "folder";
}

const MODE_ENTRY = "repa-mode";

/** 本进程里打开的全部对话。切走的对话留在内存里继续运行，切回去还能看到。 */
export class Sessions {
  private readonly live = new Map<string, Live>();
  private readonly byToolCall = new Map<string, Live>();
  private readonly watchers = new Set<(status: SessionStatus) => void>();

  private constructor(private readonly root: string, private readonly runtime: ModelRuntime, private readonly agentDir: string) {}

  /**
   * 凭据、models.json 和模型目录的缓存（models-store.json）都在 Repa 自己的配置目录里，交给 Pi 的 agentDir 也是它，
   * 所以不读 Pi 的 ~/.pi/agent。测试传入自己的 runtime 和目录。
   */
  static async create(root: string, options: { runtime?: ModelRuntime; agentDir?: string } = {}): Promise<Sessions> {
    const agentDir = options.agentDir ?? configDir();
    const runtime = options.runtime ?? await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
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

  /** 列对话，缺省是全部文件夹的学习对话，最近的在前。 */
  async list(options: ListOptions): Promise<SessionSummary[]> {
    const kinds: Kind[] = options.reviews ? ["learn", "review"] : ["learn"];
    const q = options.q?.trim().toLowerCase();
    const found: SessionSummary[] = [];
    for (const kind of kinds) {
      const folders = options.folder === undefined ? await this.foldersWithSessions(kind) : [options.folder];
      for (const folder of folders) {
        for (const info of await this.saved(kind, folder)) {
          if (q && !`${info.name ?? ""}\n${info.allMessagesText}`.toLowerCase().includes(q)) continue;
          const live = this.live.get(info.id);
          found.push({
            id: info.id, folder, kind, title: info.name ?? info.firstMessage.slice(0, 40),
            created: info.created.toISOString(), modified: info.modified.toISOString(),
            running: live?.session.isStreaming ?? false, waiting: (live?.resolvers.size ?? 0) > 0,
          });
        }
      }
    }
    const byTime = (a: SessionSummary, b: SessionSummary) => b.modified.localeCompare(a.modified);
    if (options.sort === "oldest") return found.sort((a, b) => a.created.localeCompare(b.created));
    if (options.sort === "folder") return found.sort((a, b) => a.folder.localeCompare(b.folder, "zh-CN") || byTime(a, b));
    return found.sort(byTime);
  }

  // 存过对话的文件夹：会话目录按文件夹分开存放，有 .jsonl 文件的目录就是。
  private async foldersWithSessions(kind: Kind): Promise<string[]> {
    const base = this.dir(kind, "");
    const names = (await readdir(base, { recursive: true }).catch(() => [])).filter((name) => name.endsWith(".jsonl"));
    return [...new Set(names.map((name) => path.dirname(name).replace(/^\.$/u, "")))];
  }

  /** 最近用过的几个文件夹，按学习对话文件的修改时间排。 */
  async recentFolders(limit = 6): Promise<string[]> {
    const base = path.join(this.root, ".repa", "sessions");
    const names = (await readdir(base, { recursive: true }).catch(() => [])).filter((name) => name.endsWith(".jsonl"));
    const files = await Promise.all(names.map(async (name) => ({ name, mtime: (await stat(path.join(base, name))).mtimeMs })));
    const folders = files.sort((a, b) => b.mtime - a.mtime).map((file) => path.dirname(file.name).replace(/^\.$/u, ""));
    return [...new Set(folders)].slice(0, limit);
  }

  /** 打开一段对话：给了 id 就打开它，fresh 就新开一段，否则接着这个文件夹最近的学习对话，没有就新开。 */
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

  /** 新开一段复习对话：卡片所在的文件夹、复习模式，发出“复习「标题」”，卡片全文和最近的练习附在这条消息里。 */
  async review(page: Page): Promise<SessionInfo> {
    const manager = SessionManager.create(resolveIn(this.root, page.folder), this.dir("review", page.folder));
    const live = await this.start("review", page.folder, manager, REVIEW_MODE);
    live.attachment = { content: await reviewMaterial(await loadState(this.root), page) };
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
    // Pi 的设置只放在内存里，不读也不改 Pi 全局目录的设置。Repa 记下的 thinking 级别作为 Pi 的缺省级别交进去：
    // 新对话、换模型时由 Pi 按它取级别，并按模型支持的级别收窄；没记过时用 Pi 的缺省。
    const { thinking } = await readSettings(this.root);
    const settingsManager = SettingsManager.inMemory(thinking ? { defaultThinkingLevel: thinking as ThinkingLevel } : {});
    const { session } = await createAgentSession({ cwd, agentDir: this.agentDir, modelRuntime: this.runtime, resourceLoader: loader, sessionManager: manager, settingsManager, ...(model ? { model } : {}) });
    await session.bindExtensions({});
    live.session = session;
    Object.assign(live.info, modelInfo(session));
    session.subscribe((event) => {
      const ui = uiEventOf(event, this.root, cwd);
      if (ui?.type === "item" && ui.item.type === "user" && live.quote) {
        ui.item.quote = live.quote;
        delete live.quote;
      }
      if (ui) this.emit(live, ui);
    });
    this.live.set(info.id, live);
    return live;
  }

  // 新对话的模型：记下的默认模型现在有凭据就用它，否则用第一个有凭据的；一个都没有时是 undefined
  private async defaultModel() {
    const available = await this.runtime.getAvailable();
    const saved = (await readSettings(this.root)).model;
    return available.find((model) => `${model.provider}/${model.id}` === saved) ?? available[0];
  }

  // 这个文件夹到知识库根的 AGENTS.md 的修改时间；变了就在下一条消息前让 Pi 重新加载。
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
   * 发一条消息，viewing 是学习者正在看的卡片，quote 是学习者在卡片或回复里选中、就它提问的一段话。还在等回应的卡片按“没有作答”“没有同意”交回。Agent 正在回复时，
   * 这条消息在当前的工具调用结束后插进去；否则开始新的一轮，这个文件夹到根的 AGENTS.md 变了就先让 Pi 重新加载。
   */
  async prompt(id: string, message: string, viewing: string | undefined, quote: string | undefined): Promise<void> {
    const live = this.get(id);
    for (const toolCallId of [...live.resolvers.keys()]) this.answer(toolCallId, { answers: null, approve: false, reason: "学习者没有回应这张卡片，直接回了话。" });
    // 插进正在进行的一轮的消息不经 before_agent_start，没有附带的上下文，所以引文直接写进消息里。
    if (live.session.isStreaming) return live.session.prompt(quote ? `${quoteBlock(quote)}\n\n${message}` : message, { streamingBehavior: "steer" });
    // 对话在登录以前就开着，或者它的模型已经登出：换成现在有凭据的默认模型。凭据由 Pi 每次从 auth.json 重读，
    // 所以在终端里 repa login 以后不必重启后端
    const current = live.session.model;
    if (!current || !(await this.runtime.getAvailable()).some((model) => model.provider === current.provider && model.id === current.id)) {
      const model = await this.defaultModel();
      if (model) {
        await live.session.setModel(model);
        this.update(live, modelInfo(live.session));
      }
    }
    const stamp = await this.agentsStamp(live.info.folder);
    if (stamp !== live.agentsStamp) await live.session.reload();
    live.agentsStamp = stamp;
    const parts = [viewing ? `学习者正在看：${viewing}` : undefined, quote ? `学习者引用了这段话：\n${quoteBlock(quote)}` : undefined, live.attachment?.content];
    if (viewing || quote) live.attachment = { content: parts.filter(Boolean).join("\n\n"), ...(quote ? { details: { quote } } : {}) };
    live.quote = quote;
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
    this.update(live, modelInfo(live.session));
  }

  /** 换 thinking 级别；它同时成为以后新对话的默认。模型不支持的级别由 Pi 收窄到它支持的，记下的仍是选的那一级，与 Pi 一致。 */
  async setThinking(id: string, level: string): Promise<void> {
    const live = this.get(id);
    // persist 只写进这段对话在内存里的 Pi 设置，之后换模型时 Pi 按它重新取级别。
    live.session.setThinkingLevel(level as ThinkingLevel, { persist: true });
    await updateSettings(this.root, { thinking: level });
    this.update(live, modelInfo(live.session));
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
    if (event.type === "running" || event.type === "pending" || event.type === "resolved") for (const watcher of this.watchers) watcher(statusOf(live));
  }

  /** 订阅全部对话的状态：先同步收到每段打开着的对话的当前状态，之后是变化。返回取消订阅的函数。 */
  watch(watcher: (status: SessionStatus) => void): () => void {
    for (const live of this.live.values()) watcher(statusOf(live));
    this.watchers.add(watcher);
    return () => this.watchers.delete(watcher);
  }
}

function statusOf(live: Live): SessionStatus {
  const { id, folder, kind } = live.info;
  return { id, folder, kind, running: live.conversation.running, waiting: live.conversation.pending.length > 0 };
}

// 界面要显示的模型与 thinking 级别，以及当前模型可选的级别。
function modelInfo(session: AgentSession): Pick<SessionInfo, "model" | "thinking" | "thinkingLevels"> {
  return {
    ...(session.model ? { model: `${session.model.provider}/${session.model.id}` } : {}),
    thinking: session.thinkingLevel,
    thinkingLevels: session.getAvailableThinkingLevels(),
  };
}

function quoteBlock(quote: string): string {
  return quote.split("\n").map((line) => `> ${line}`).join("\n");
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
    const last = items.at(-1);
    const details = entry.type === "custom_message" ? (entry.details as { quote?: unknown } | undefined) : undefined;
    if (last?.type === "user" && typeof details?.quote === "string") items[items.length - 1] = { ...last, quote: details.quote };
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
