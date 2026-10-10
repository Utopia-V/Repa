import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { type AuthEvent, type AuthPrompt, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  formatSkillsForPrompt,
  loadSkillsFromDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  defineTool,
  type AgentSession as PiSession,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { AgentRuntime, AgentRuntimeOptions, AgentSession, AgentSpace, AgentSpaceOptions } from "../agent.js";
import type { AgentTask, AgentWork, CompletionRequest, Tool } from "../plugin.js";
import { RepaFault, type Confirm, type Confirmation, type ModelRef, type SessionInfo, type PromptSection } from "../schema.js";
import { exactEditTool } from "./edit.js";
import { convertEvent, entryToPublic, textContent } from "./events.js";
import { applyPromptSections, promptSections } from "./prompts.js";
import { activeViews, changedViews, staleViewEdits, viewMessage, type ViewSnapshot } from "./views.js";

export interface AgentTestOptions extends AgentRuntimeOptions {
  modelRuntime: ModelRuntime;
  defaultModel?: ModelRef;
  settingsManager?: SettingsManager;
  now?: () => number;
  viewBatchSize?: number;
  cacheTtlMs?: number;
}

export async function createAgentRuntime(options: AgentRuntimeOptions): Promise<AgentRuntime> {
  await mkdir(options.agentDir, { recursive: true });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(options.agentDir, "auth.json"),
    modelsPath: path.join(options.agentDir, "models.json"),
    allowModelNetwork: false,
  });
  return createAgentRuntimeForTest({ ...options, modelRuntime });
}

export async function createAgentRuntimeForTest(options: AgentTestOptions): Promise<AgentRuntime> {
  return new Runtime(options);
}

function toolDefinition(tool: Tool): ToolDefinition {
  return defineTool({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    async execute(callId, input, signal) {
      const activeSignal = signal ?? new AbortController().signal;
      activeSignal.throwIfAborted();
      const result = await tool.execute(input, { signal: activeSignal, callId });
      return { content: [{ type: "text", text: result.text }], details: result.data };
    },
  });
}

class Runtime implements AgentRuntime {
  readonly settings: SettingsManager;
  private spaces = new Set<Space>();
  private closed = false;

  constructor(readonly options: AgentTestOptions) {
    // 项目设置只由 Repa 持有；Pi 不读取空间中的 .pi/settings.json。
    this.settings = options.settingsManager ?? SettingsManager.create(options.agentDir, options.agentDir, { projectTrusted: false });
    if (options.settingsManager === undefined && this.settings.getGlobalSettings().cacheWarming === undefined) this.settings.setCacheWarmingMode("idle");
    this.checkSettings();
  }

  checkSettings(): void {
    const errors = this.settings.drainErrors();
    if (errors.length > 0) throw new RepaFault("agent_settings", "Agent 设置读取或保存失败", errors.map(entry => ({ scope: entry.scope, message: entry.error.message })));
  }

  assertOpen(): void {
    if (this.closed) throw new RepaFault("runtime_closed", "Agent 运行时已经关闭");
  }

  model(reference?: ModelRef): Model<string> | undefined {
    if (reference) {
      const model = this.options.modelRuntime.getModel(reference.provider, reference.id);
      if (!model) throw new RepaFault("model_not_found", "模型不存在", reference);
      return model;
    }
    const fallback = this.options.defaultModel;
    if (fallback) return this.model(fallback);
    const provider = this.settings.getDefaultProvider();
    const id = this.settings.getDefaultModel();
    if (provider && id) {
      const model = this.options.modelRuntime.getModel(provider, id);
      if (model) return model;
    }
    return this.options.modelRuntime.getAvailableSnapshot()[0];
  }

  async openSpace(options: AgentSpaceOptions): Promise<AgentSpace> {
    this.assertOpen();
    await mkdir(options.sessionsDir, { recursive: true });
    const space = new Space(this, options, () => this.spaces.delete(space));
    this.spaces.add(space);
    return space;
  }

  async listModels() {
    this.assertOpen();
    const available = await this.options.modelRuntime.getAvailable();
    const keys = new Set(available.map(model => `${model.provider}/${model.id}`));
    return this.options.modelRuntime.getModels().map(model => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      available: keys.has(`${model.provider}/${model.id}`),
    }));
  }

  async login(provider: string, type: string, confirm: Confirm, signal?: AbortSignal): Promise<void> {
    this.assertOpen();
    if (type !== "api_key" && type !== "oauth") throw new RepaFault("invalid_auth_type", "登录类型不受支持");
    const notices: Promise<unknown>[] = [];
    await this.options.modelRuntime.login(provider, type, {
      signal,
      async prompt(prompt: AuthPrompt) {
        const request: Confirmation = { kind: "input", title: prompt.message };
        if (prompt.type === "secret") request.secret = true;
        if (prompt.type === "select") {
          request.kind = "select";
          request.options = prompt.options.map(option => option.id);
          request.message = prompt.options.map(option => {
            const description = option.description ? ` — ${option.description}` : "";
            return `${option.id}：${option.label}${description}`;
          }).join("\n");
        }
        const promptSignal = prompt.signal && signal ? AbortSignal.any([prompt.signal, signal]) : prompt.signal ?? signal;
        const answer = await confirm(request, promptSignal);
        if (typeof answer !== "string") throw new RepaFault("auth_cancelled", "登录已取消");
        return answer;
      },
      notify(event: AuthEvent) {
        let title: string;
        let url: string | undefined;
        if (event.type === "auth_url") {
          title = event.instructions ?? "打开链接完成登录";
          url = event.url;
        } else if (event.type === "device_code") {
          title = `输入设备码：${event.userCode}`;
          url = event.verificationUri;
        } else {
          title = event.message;
          if (event.type === "info") url = event.links?.[0]?.url;
        }
        // Pi 的通知回调同步，但前端发送链仍在 login 完成前收尾。
        const notice = confirm({ kind: "display", title, ...(url ? { url } : {}) }, signal);
        notices.push(notice);
        notice.catch(() => undefined);
      },
    });
    await Promise.all(notices);
  }

  async setKey(provider: string, key: string): Promise<void> {
    this.assertOpen();
    let supplied = false;
    await this.options.modelRuntime.login(provider, "api_key", {
      async prompt(prompt) {
        if (supplied || (prompt.type !== "secret" && prompt.type !== "text")) throw new RepaFault("requires_interactive_login", "此提供方需要额外登录信息，请使用交互登录");
        supplied = true;
        return key;
      },
      notify() {},
    });
  }

  async logout(provider: string): Promise<void> {
    this.assertOpen();
    await this.options.modelRuntime.logout(provider);
  }

  async complete(request: CompletionRequest): Promise<string> {
    this.assertOpen();
    const model = this.model(request.model);
    if (!model) throw new RepaFault("model_required", "请选择可用模型");
    const timestamp = Date.now();
    const message = await this.options.modelRuntime.completeSimple(model, {
      messages: [
        ...(request.system ? [{ role: "system" as const, content: request.system, timestamp }] : []),
        { role: "user", content: request.prompt, timestamp },
      ],
    }, { signal: request.signal });
    if (message.stopReason === "error") throw new RepaFault("model_error", message.errorMessage ?? "模型请求失败");
    if (message.stopReason === "aborted") throw new RepaFault("cancelled", "模型请求已取消");
    return textContent(message.content);
  }

  async completeStructured<S extends TSchema>(request: CompletionRequest, schema: S): Promise<Static<S>> {
    const instruction = `请只返回符合此 JSON Schema 的 JSON：\n${JSON.stringify(schema)}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const text = await this.complete({
        ...request,
        system: [request.system, instruction].filter(Boolean).join("\n\n"),
        prompt: attempt === 0 ? request.prompt : `${request.prompt}\n\n上次输出不符合 JSON Schema，请修正。`,
      });
      let value: unknown;
      try {
        value = JSON.parse(text.replace(/^\s*```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, ""));
      } catch {
        continue;
      }
      if (Value.Check(schema, value)) return value as Static<S>;
    }
    throw new RepaFault("invalid_model_output", "模型连续三次返回了不符合 schema 的内容");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.spaces].map(space => space.close()));
    await this.settings.flush();
    this.checkSettings();
  }
}

class Space implements AgentSpace {
  private sessions = new Map<string, Promise<Session>>();
  private closed = false;

  constructor(readonly runtime: Runtime, readonly options: AgentSpaceOptions, private onClose: () => void) {}

  assertOpen(): void {
    this.runtime.assertOpen();
    if (this.closed) throw new RepaFault("space_closed", "Agent 空间已经关闭");
  }

  async defaults(): Promise<{ id: string; text: string }[]> {
    const skills = [
      ...loadSkillsFromDir({ dir: path.join(this.runtime.options.agentDir, "skills"), source: "repa" }).skills,
      ...loadSkillsFromDir({ dir: path.join(this.options.root, ".repa", "skills"), source: "repa-space" }).skills,
    ];
    let spaceInstructions = "";
    try {
      spaceInstructions = await readFile(path.join(this.options.root, "AGENTS.md"), "utf8");
    } catch (error) {
      if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    const tools = ["read", "bash", "edit", "write", "grep", "find", "ls", ...this.options.tools().map(tool => tool.name)];
    return [
      { id: "space", text: [`当前空间：${this.options.root}`, spaceInstructions].filter(Boolean).join("\n\n") },
      { id: "skills", text: formatSkillsForPrompt(skills, "read") },
      { id: "tools", text: `使用已声明的工具。edit 的 oldText 必须逐字匹配，保留原文标点和换行。可用工具：${tools.join("、")}` },
    ];
  }

  async preview() {
    this.assertOpen();
    return { sections: await promptSections(this.options, await this.defaults()), views: await this.options.views() };
  }

  async create(reference?: ModelRef): Promise<AgentSession> {
    this.assertOpen();
    const file = path.join(this.options.sessionsDir, `${randomUUID()}.jsonl`);
    // Pi 的会话入口同步建立 header；同步创建这个空文件使初始化立即登记，close 能拥有整个生命周期。
    const descriptor = openSync(file, "wx");
    closeSync(descriptor);
    // 已打开的文件会逐条保存，首个 assistant 前也不丢消息。
    const manager = SessionManager.open(file, this.options.sessionsDir, this.options.root);
    return this.load(manager, reference);
  }

  load(manager: SessionManager, reference?: ModelRef): Promise<Session> {
    this.assertOpen();
    const id = manager.getSessionId();
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const session = new Session(this, manager);
    const loading = session.initialize(reference).then(() => session);
    this.sessions.set(id, loading);
    loading.catch(() => {
      if (this.sessions.get(id) === loading) this.sessions.delete(id);
    });
    return loading;
  }

  async get(id: string): Promise<AgentSession> {
    this.assertOpen();
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const file = SessionManager.findById(this.options.root, id, this.options.sessionsDir);
    if (!file) throw new RepaFault("session_not_found", "会话不存在", { id });
    return this.load(SessionManager.open(file, this.options.sessionsDir, this.options.root));
  }

  async list(): Promise<SessionInfo[]> {
    this.assertOpen();
    const infos = new Map<string, SessionInfo>();
    for (const entry of await SessionManager.list(this.options.root, this.options.sessionsDir)) {
      const manager = SessionManager.open(entry.path, this.options.sessionsDir, this.options.root);
      const model = manager.buildSessionProjection().model;
      infos.set(entry.id, { id: entry.id, createdAt: entry.created.toISOString(), ...(entry.name ? { name: entry.name } : {}), ...(model ? { model: { provider: model.provider, id: model.modelId } } : {}) });
    }
    for (const session of await Promise.all(this.sessions.values())) infos.set(session.info().id, session.info());
    return [...infos.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async runAgent(task: AgentTask): Promise<AgentWork> {
    const session = await this.create(task.model);
    const result = session.send(task.text);
    result.catch(() => undefined);
    return { id: session.info().id, result, cancel: () => session.abort() };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.sessions.values()].map(async pending => {
      const session = await pending.catch(() => undefined);
      await session?.close();
    }));
    this.sessions.clear();
    this.onClose();
  }
}

class Session implements AgentSession {
  private pi?: PiSession;
  private runId?: string;
  private abortController?: AbortController;
  private currentViews: ViewSnapshot[] = [];
  private currentSections: PromptSection[] = [];
  private lastRequestAt?: number;
  private closed = false;
  private pending = new Map<AbortController, Promise<void>>();

  constructor(private space: Space, private manager: SessionManager) {}

  get session(): PiSession {
    if (!this.pi) throw new RepaFault("session_unavailable", "会话尚未打开");
    return this.pi;
  }

  now(): number {
    return this.space.runtime.options.now?.() ?? Date.now();
  }

  async initialize(reference?: ModelRef): Promise<void> {
    const { runtime, options } = this.space;
    const reservedTools = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"]);
    const names = new Set<string>();
    for (const tool of options.tools()) {
      if (reservedTools.has(tool.name) || names.has(tool.name)) throw new RepaFault("tool_name_conflict", "插件工具名称重复或覆盖内置工具", { name: tool.name });
      names.add(tool.name);
    }
    const factory: ExtensionFactory = pi => {
      pi.on("before_agent_start", async event => {
        applyPromptSections(event.systemPromptOptions, this.currentSections);
        const shortTtl = this.session.model?.promptCache?.short;
        const ttl = runtime.options.cacheTtlMs ?? (shortTtl === undefined ? undefined : shortTtl * 1000);
        const cacheExpired = ttl !== undefined && this.lastRequestAt !== undefined && this.now() - this.lastRequestAt >= ttl;
        const updates = changedViews(this.manager, this.currentViews);
        const retainedIds = new Set(this.currentViews.map(view => view.id));
        // 缓存过期时，新版即将进入请求；先清除这些来源的全部旧版，其余来源保留最新版本。
        if (cacheExpired) {
          for (const view of updates) retainedIds.delete(view.id);
        }
        this.cleanViews(cacheExpired, retainedIds);
        for (const view of updates) {
          // Pi 在本钩子之后先写入 system，再写入 user 与 nextTurn 消息，保持首项的提示和工具声明。
          await this.session.sendCustomMessage(viewMessage(view), { deliverAs: "nextTurn", triggerTurn: false });
        }
      });
      pi.on("agent_before_settle", () => ({ entries: staleViewEdits(this.manager, new Set(this.currentViews.map(view => view.id)), runtime.options.viewBatchSize ?? 3) }));
      pi.on("session_before_compact", event => {
        // 视图是当前状态而非对话事实；默认压缩不将旧状态写进摘要。
        const isView = (message: { role: string; customType?: string }) => message.role === "custom" && message.customType === "repa-view";
        event.preparation.messagesToSummarize = event.preparation.messagesToSummarize.filter(message => !isView(message));
        event.preparation.turnPrefixMessages = event.preparation.turnPrefixMessages.filter(message => !isView(message));
        this.cleanViews(true);
      });
      pi.on("session_compact", () => {
        // Pi 在保存压缩条目后 await 本钩子，再发出压缩完成并执行 overflow retry。
        // 这里用公开 append/refresh 补回当前状态，自动重试的第一份请求也能读到。
        for (const entry of activeViews(this.manager)) this.manager.appendContextEdit(entry.id, null);
        for (const view of this.currentViews) {
          const message = viewMessage(view);
          this.manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
        }
        this.session.refreshContext();
      });
      pi.on("tool_call", async event => {
        if (event.toolName !== "bash" || options.commandPolicy() === "fullAccess") return;
        const input: unknown = event.input;
        const command = input !== null && typeof input === "object" && "command" in input && typeof input.command === "string" ? input.command : "";
        const answer = await options.confirm({ kind: "command", title: "允许执行命令？", message: command }, this.abortController?.signal);
        if (answer !== true) return { block: true, reason: "用户拒绝执行命令" };
      });
    };
    const loader = new DefaultResourceLoader({
      cwd: options.root,
      agentDir: runtime.options.agentDir,
      settingsManager: runtime.settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "Repa",
      extensionFactories: [factory],
    });
    await loader.reload();
    const saved = this.manager.buildSessionProjection().model;
    const model = runtime.model(reference ?? (saved ? { provider: saved.provider, id: saved.modelId } : undefined));
    const result = await createAgentSession({
      cwd: options.root,
      agentDir: runtime.options.agentDir,
      modelRuntime: runtime.options.modelRuntime,
      model,
      sessionManager: this.manager,
      settingsManager: runtime.settings,
      resourceLoader: loader,
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls", ...options.tools().map(tool => tool.name)],
      customTools: [exactEditTool(options.root), ...options.tools().map(toolDefinition)],
    });
    this.pi = result.session;
    const lastUsage = this.manager.getBranch().findLast(entry => {
      if (entry.type === "message" && entry.message.role === "assistant") {
        return entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted";
      }
      return entry.type === "usage" && entry.kind === "cache_warm";
    });
    if (lastUsage) this.lastRequestAt = Date.parse(lastUsage.timestamp);
    await this.pi.bindExtensions({
      mode: "rpc",
      onError: error => options.onEvent({ sessionId: this.manager.getSessionId(), type: "error", text: error.error }),
    });
    this.pi.subscribe(event => {
      if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason !== "error" && event.message.stopReason !== "aborted") this.lastRequestAt = this.now();
      if (event.type === "agent_start" && this.abortController?.signal.aborted) {
        this.session.abort().catch(() => options.onEvent({ sessionId: this.manager.getSessionId(), type: "error", text: "会话取消失败" }));
      }
      if (event.type === "entry_appended" && event.entry.type === "usage" && event.entry.kind === "cache_warm") this.lastRequestAt = this.now();
      for (const converted of convertEvent(this.manager.getSessionId(), event, this.runId)) options.onEvent(converted);
    });
  }

  cleanViews(force: boolean, currentIds = new Set(this.currentViews.map(view => view.id))): void {
    const edits = staleViewEdits(this.manager, currentIds, this.space.runtime.options.viewBatchSize ?? 3, force);
    for (const edit of edits) this.manager.appendContextEdit(edit.targetId, edit.replacement);
    if (edits.length > 0) this.session.refreshContext();
  }

  info(): SessionInfo {
    const header = this.manager.getHeader();
    const model = this.pi?.model;
    const name = this.manager.getSessionName();
    return {
      id: this.manager.getSessionId(),
      createdAt: header?.timestamp ?? new Date().toISOString(),
      ...(name ? { name } : {}),
      ...(model ? { model: { provider: model.provider, id: model.id } } : {}),
    };
  }

  history() {
    return this.manager.getBranch().flatMap(entry => {
      const converted = entryToPublic(entry);
      return converted ? [converted] : [];
    });
  }

  async send(text: string): Promise<void> {
    this.space.assertOpen();
    if (this.closed) throw new RepaFault("session_closed", "会话已关闭");
    const runId = randomUUID();
    const controller = new AbortController();
    let finish: () => void = () => undefined;
    const settled = new Promise<void>(resolve => { finish = resolve; });
    this.pending.set(controller, settled);
    let status: "completed" | "failed" | "aborted" = "completed";
    let started = false;
    try {
      await this.space.options.record(runId, async () => {
        if (controller.signal.aborted) throw new RepaFault("cancelled", "排队中的会话运行已取消");
        if (this.closed) throw new RepaFault("session_closed", "会话已关闭");
        this.runId = runId;
        this.abortController = controller;
        started = true;
        this.space.options.onEvent({ sessionId: this.manager.getSessionId(), runId, type: "runStart" });
        try {
          // 外部提示和 view 的失败在 Pi preflight 之外传播，不被扩展错误容错吞掉。
          this.currentSections = await promptSections(this.space.options, await this.space.defaults());
          this.currentViews = await this.space.options.views();
          controller.signal.throwIfAborted();
          this.manager.appendCustomEntry("repa-run", { runId });
          await this.session.prompt(text);
          const last = this.session.messages.findLast(message => message.role === "assistant");
          if (last?.role === "assistant" && last.stopReason === "aborted") status = "aborted";
          if (last?.role === "assistant" && last.stopReason === "error") throw new RepaFault("model_error", last.errorMessage ?? "模型请求失败");
        } catch (error) {
          if (this.abortController.signal.aborted) throw new RepaFault("cancelled", "会话运行已取消");
          throw error;
        } finally {
          this.runId = undefined;
          this.abortController = undefined;
        }
      });
    } catch (error) {
      status = error instanceof RepaFault && error.code === "cancelled" ? "aborted" : "failed";
      this.space.options.onEvent({ sessionId: this.manager.getSessionId(), runId, type: "error", text: error instanceof RepaFault ? error.message : "Agent 运行失败", data: { code: error instanceof RepaFault ? error.code : "agent_error" } });
      throw error;
    } finally {
      // Repa 的运行结束包含空间快照提交；不能把 Pi 的模型循环结束当作整个运行结束。
      this.pending.delete(controller);
      finish();
      if (started) this.space.options.onEvent({ sessionId: this.manager.getSessionId(), runId, type: "runEnd", data: { status } });
    }
  }

  async steer(text: string): Promise<void> {
    this.space.assertOpen();
    if (!this.session.isStreaming) return this.send(text);
    await this.session.steer(text);
  }

  async followUp(text: string): Promise<void> {
    this.space.assertOpen();
    if (!this.session.isStreaming) return this.send(text);
    await this.session.followUp(text);
  }

  async abort(): Promise<void> {
    const pending = [...this.pending.entries()];
    for (const [controller] of pending) controller.abort();
    await this.session.abort();
    await Promise.all(pending.map(([, settled]) => settled));
  }

  async setModel(reference: ModelRef): Promise<void> {
    this.space.assertOpen();
    const model = this.space.runtime.model(reference);
    if (!model) throw new RepaFault("model_not_found", "模型不存在");
    await this.session.setModel(model);
  }

  async compact(): Promise<void> {
    this.space.assertOpen();
    this.currentViews = await this.space.options.views();
    await this.session.compact();
  }

  async fork(entryId: string): Promise<AgentSession> {
    this.space.assertOpen();
    await this.session.waitForIdle();
    if (!this.manager.getBranch().some(entry => entry.id === entryId)) throw new RepaFault("entry_not_found", "会话条目不存在");
    const source = this.manager.getSessionFile();
    if (!source) throw new RepaFault("session_not_persisted", "会话尚未保存");
    const manager = SessionManager.forkFrom(source, this.space.options.root, this.space.options.sessionsDir);
    manager.branch(entryId);
    manager.appendCustomEntry("repa-fork", { entryId });
    return this.space.load(manager);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.abort();
    this.session.dispose();
  }
}

export function cacheStatusForTest(session: AgentSession) {
  if (!(session instanceof Session)) throw new Error("不是当前运行时的会话");
  return session.session.cacheWarmingStatus;
}
