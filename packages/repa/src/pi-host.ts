import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getCurrentSystemMessage, type Api, type Model, type ImageContent } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  loadProjectContextFiles,
  type AgentSession,
  type AgentSessionEvent,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
  ModelRuntime,
  type SessionManager,
  type ToolDefinition,
  SettingsManager,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { SerialQueue } from "./storage/atomic.js";
import { sessionSettings } from "./agent/settings.js";
import { compactWithPrompts } from "./agent/summary.js";
import type { SummaryPrompts } from "./agent/summary-settings.js";
import type { AssembledPrompt } from "./configuration/runtime.js";
import type { RunOptions } from "./requests/schema.js";
import type { PreparedInput } from "./requests/input.js";
import { historyView, messageView, type Resources } from "./messages.js";
import type {
  Change,
  Interaction,
  Message,
  Notice,
  Reply,
  Run,
} from "./protocol.js";
import { RepaFault } from "./protocol.js";
import { describePrompt } from "./agent/context.js";
import { projectBackgrounds, withModelBackgrounds, type BackgroundSource, type BackgroundState, type WorkingMessage } from "./agent/background.js";
import { createContentTools } from "./agent/tools.js";
import { ToolResults } from "./agent/tool-results.js";
import { FileChanges } from "./agent/file-changes.js";
import type { PromptSettings } from "./configuration/schema.js";
import type { ContentStore } from "./content/store.js";

export interface PiModelOverride {
  modelRuntime: ModelRuntime;
  model: Model<Api>;
}
export type Dialog = Pick<
  Interaction,
  "kind" | "title" | "message" | "options" | "initialValue" | "execution"
>;
export interface DialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}
export interface ConversationRuntime {
  send(
    text: string,
    settings: PromptSettings,
    input?: { requestId: string; images: ImageContent[]; options?: RunOptions },
  ): Promise<{ status: "completed" | "cancelled" | "failed"; error?: string }>;
  steer(requestId: string, input: Pick<PreparedInput, "text" | "images">): Promise<boolean>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}
export type HostEvent =
  | { type: "prompt"; prompt: AssembledPrompt }
  | { type: "entered"; requestId: string; messageId: string }
  | { type: "title"; title: string | undefined }
  | { type: "message"; message: Message; replaces?: string }
  | {
      type: "delta";
      messageId: string;
      index: number;
      kind: "text" | "thinking";
      text: string;
    }
  | { type: "phase"; phase: Run["phase"] }
  | { type: "notice"; notice: Notice }
  | Pick<
      Extract<Change, { type: "tool" }>,
      "type" | "callId" | "name" | "status"
    >;
export interface OpenPiHostOptions {
  learnerSpace: string;
  agentDir?: string;
  sessionManager: SessionManager;
  trustExtensions: boolean;
  modelOverride?: PiModelOverride;
  resources: Resources;
  content: ContentStore;
  backgroundSources?: readonly BackgroundSource[];
  resourceSettings?: SettingsManager;
  applicationTools?: readonly ToolDefinition[];
  additionalExtensions?: readonly string[];
  additionalSkills?: readonly string[];
  additionalPrompts?: readonly string[];
  onEvent: (event: HostEvent) => void;
  ask: (dialog: Dialog, options?: DialogOptions) => Promise<Reply>;
}

export class PiConversationHost implements ConversationRuntime {
  readonly #session: AgentSession;
  readonly #settings: SettingsManager;
  readonly #options: OpenPiHostOptions;
  readonly #loader: DefaultResourceLoader;
  readonly #agentDir: string;
  readonly #fileChanges: FileChanges;
  readonly #unsubscribe: () => void;
  readonly #inputQueue = new SerialQueue();
  readonly #pendingInputs: string[] = [];
  readonly #defaultTools: string[];
  #inputRequest: string | undefined;
  #ready: Promise<void> = Promise.resolve();
  #resolveReady: (() => void) | undefined;
  #liveId: string | undefined;
  #lastResult: {
    status: "completed" | "cancelled" | "failed";
    error?: string;
  } = { status: "completed" };
  #closed = false;
  #cancelled = false;
  #sending = false;
  #runSettings: PromptSettings | undefined;
  #runPrompt = "";
  #promptDescription: AssembledPrompt | undefined;
  #summaryPrompts: SummaryPrompts = { system: null, instructions: null };
  #compactionFailure: string | undefined;
  #backgroundStates: BackgroundState[] = [];

  private constructor(
    session: AgentSession,
    settings: SettingsManager,
    options: OpenPiHostOptions,
    loader: DefaultResourceLoader,
    agentDir: string,
    fileChanges: FileChanges,
  ) {
    this.#session = session;
    this.#settings = settings;
    this.#options = options;
    this.#loader = loader;
    this.#agentDir = agentDir;
    this.#fileChanges = fileChanges;
    this.#defaultTools = session.getActiveToolNames();
    this.#backgroundStates = (options.backgroundSources ?? []).map(source => ({ codec: source.codec, enabled: false }));
    this.#unsubscribe = session.subscribe((event) => this.#onEvent(event));
  }

  static async open(options: OpenPiHostOptions): Promise<PiConversationHost> {
    const agentDir = path.resolve(options.agentDir ?? getAgentDir());
    await mkdir(agentDir, { recursive: true });
    const settings = options.resourceSettings ?? sessionSettings(options.learnerSpace, agentDir, options.trustExtensions);
    let host: PiConversationHost | undefined;
    const toolResults = new ToolResults();
    let onCompact: (event: SessionBeforeCompactEvent) => Promise<SessionBeforeCompactResult | undefined>;
    const loader = new DefaultResourceLoader({
      cwd: options.learnerSpace,
      agentDir,
      settingsManager: settings,
      noExtensions: !options.trustExtensions,
      noSkills: !options.trustExtensions,
      noPromptTemplates: !options.trustExtensions,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [...options.additionalExtensions ?? []],
      additionalSkillPaths: [...options.additionalSkills ?? []],
      additionalPromptTemplatePaths: [...options.additionalPrompts ?? []],
      systemPrompt: "",
      appendSystemPrompt: [],
      // Pi 将 inline factories 放在磁盘扩展之后，确保 Repa 的来源开关最后生效。
      extensionFactories: [{
        name: "repa-context",
        factory(pi) {
          pi.on("tool_result", event => toolResults.finish(event.toolCallId));
          pi.on("input", (event) => {
            if (event.source === "rpc" && host && host.#inputRequest) host.#pendingInputs.push(host.#inputRequest);
          });
          pi.on("before_agent_start", () => ({ systemPrompt: host ? host.#runPrompt : "" }));
          pi.on("context", async (event) => ({
            messages: host ? await host.#prepareContext(event.messages) : event.messages,
          }));
          pi.on("context_with_system", (event) => {
            // 扩展命令也能直接发起模型请求；它们不一定经过 before_agent_start。
            const current = getCurrentSystemMessage(event.messages);
            return { messages: [{
              role: "system" as const,
              content: host ? host.#runPrompt : "",
              ...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
              timestamp: current?.timestamp ?? 0,
            }, ...event.messages.filter((message) => message.role !== "system")] };
          });
          onCompact = async (event) => {
            const currentHost = host;
            if (!currentHost) return;
            // Pi 的摘要调用不经过 context hook，同样排除已经关闭的自动来源。
            event.preparation.messagesToSummarize = currentHost.#projectMessages(event.preparation.messagesToSummarize);
            event.preparation.turnPrefixMessages = currentHost.#projectMessages(event.preparation.turnPrefixMessages);
            const externalHandler = loader.getExtensions().extensions.some(extension =>
              extension.handlers.get("session_before_compact")?.some(handler => handler !== onCompact));
            if (externalHandler && currentHost.#summaryPrompts.system === null && currentHost.#summaryPrompts.instructions === null) return;
            try {
              const model = currentHost.#session.model;
              if (!model) throw new RepaFault("configuration", "压缩前需要选择模型。");
              const compaction = await compactWithPrompts({
                preparation: event.preparation,
                model,
                customInstructions: event.customInstructions,
                signal: event.signal,
                thinkingLevel: currentHost.#session.thinkingLevel,
                streamFn: (selected, context, requestOptions) => currentHost.#session.modelRuntime.streamSimple(selected, context, requestOptions),
                retry: settings.getRetrySettings(),
                prompts: currentHost.#summaryPrompts,
                onPrompt: (summary) => {
                  const prompt = currentHost.#promptDescription;
                  if (!prompt) return;
                  const systemId = `summary.${summary.kind}.system`;
                  const instructionsId = `summary.${summary.kind}.instructions`;
                  prompt.sources = prompt.sources.filter(source => source.id !== systemId && source.id !== instructionsId);
                  prompt.sources.push(
                    { id: systemId, enabled: true, content: summary.system },
                    { id: instructionsId, enabled: true, content: summary.instructions },
                  );
                  currentHost.#options.onEvent({ type: "prompt", prompt: structuredClone(prompt) });
                },
              });
              return { compaction };
            } catch (error) {
              // Pi 会吞掉扩展异常并继续默认摘要；返回 cancel 才能保证覆盖失败后不换回旧指令。
              if (!event.signal.aborted) {
                currentHost.#compactionFailure = error instanceof Error ? error.message : String(error);
                currentHost.#notice("compaction", currentHost.#compactionFailure, "error");
              }
              return { cancel: true };
            }
          };
          pi.on("session_before_compact", onCompact);
        },
      }],
    });
    await loader.reload({
      resolveProjectTrust: async () => options.trustExtensions,
    });
    const fileChanges = new FileChanges(options.content);
    const tools = await createContentTools(options.learnerSpace, options.content, loader, fileChanges);
    for (const tool of options.applicationTools ?? []) {
      if (tools.some(existing => existing.name === tool.name)) throw new RepaFault("capability_tool_conflict", "应用工具名称与已接入工具重复。", { name: tool.name });
      tools.push(tool);
    }
    const created = await createAgentSession({
      cwd: options.learnerSpace,
      agentDir,
      model: options.modelOverride?.model,
      modelRuntime: options.modelOverride?.modelRuntime,
      resourceLoader: loader,
      sessionManager: withModelBackgrounds(options.sessionManager, () => ({
        backgrounds: host ? host.#backgroundStates : (options.backgroundSources ?? []).map(source => ({ codec: source.codec, enabled: false })),
        fileChanges: host ? host.#runSettings?.fileChanges ?? "on-demand" : "on-demand",
      })),
      settingsManager: settings,
      noTools: "builtin",
      customTools: tools.map(tool => toolResults.wrap(tool)),
    });
    host = new PiConversationHost(created.session, settings, options, loader, agentDir, fileChanges);
    try {
      await created.session.bindExtensions({
        mode: "rpc",
        uiContext: {
          ...created.session.extensionRunner.getUIContext(),
          select: async (title, choices, opts) => {
            const value = await options.ask(
              { kind: "select", title, options: choices },
              opts,
            );
            return typeof value === "string" ? value : undefined;
          },
          confirm: async (title, message, opts) =>
            (await options.ask({ kind: "confirm", title, message }, opts)) ===
            true,
          input: async (title, placeholder, opts) => {
            const value = await options.ask(
              { kind: "input", title, initialValue: placeholder },
              opts,
            );
            return typeof value === "string" ? value : undefined;
          },
          editor: async (title, prefill) => {
            const value = await options.ask({
              kind: "editor",
              title,
              initialValue: prefill,
            });
            return typeof value === "string" ? value : undefined;
          },
          notify: (message, level = "info") =>
            host.#notice("extension", message, level),
          setStatus: (key, value) =>
            host.#notice(`status:${key}`, value ?? "", "info", `status:${key}`),
          setWidget: (key, value) => {
            if (Array.isArray(value))
              host.#notice(
                `widget:${key}`,
                value.join("\n"),
                "info",
                `widget:${key}`,
              );
          },
          setEditorText: (value) =>
            host.#notice("editor_suggestion", value, "info"),
        },
        abortHandler: () => {
          void host.cancel();
        },
        onError: (error) =>
          host.#notice(
            "extension",
            `${error.extensionPath} (${error.event}): ${error.error}`,
            "error",
          ),
      });
      if (options.trustExtensions)
        host.#notice(
          "extension_trust",
          "已启用受信任的 Pi Package/Extension；代码以宿主进程权限运行。",
          "warning",
        );
      for (const error of created.extensionsResult.errors)
        host.#notice(
          "extension",
          `${error.path}: ${String(error.error)}`,
          "error",
        );
      for (const diagnostic of [
        ...loader.getSkills().diagnostics,
        ...loader.getPrompts().diagnostics,
      ])
        host.#notice("resource", diagnostic.message, "warning");
      if (created.modelFallbackMessage)
        host.#notice(
          created.session.model ? "model_fallback" : "configuration",
          created.modelFallbackMessage,
          "warning",
        );
      return host;
    } catch (error) {
      await host.close();
      throw error;
    }
  }

  #notice(
    code: string,
    message: string,
    level: Notice["level"],
    id: string = randomUUID(),
  ): void {
    this.#options.onEvent({
      type: "notice",
      notice: { id, code, message, level },
    });
  }

  async send(
    text: string,
    settings: PromptSettings,
    input?: { requestId: string; images: ImageContent[]; options?: RunOptions },
  ): Promise<{ status: "completed" | "cancelled" | "failed"; error?: string }> {
    if (this.#closed) throw new Error("会话运行实例已关闭。");
    if (this.#sending || !this.#session.isIdle)
      throw new RepaFault("busy", "会话已有正在处理的运行。");
    this.#lastResult = { status: "completed" };
    this.#compactionFailure = undefined;
    this.#cancelled = false;
    this.#sending = true;
    this.#ready = new Promise(resolve => { this.#resolveReady = resolve; });
    try {
      if (input?.options?.model) {
        const selection = input.options.model;
        const model = this.#session.modelRuntime.getModel(selection.provider, selection.id);
        if (!model || (selection.baseUrl !== undefined && model.baseUrl !== selection.baseUrl))
          throw new RepaFault("configuration", "受理时选择的模型或端点已不可用。");
        if (this.#session.model !== model) await this.#session.setModel(model);
      }
      if (input?.options?.thinkingLevel !== undefined) {
        if (!this.#session.getAvailableThinkingLevels().includes(input.options.thinkingLevel))
          throw new RepaFault("configuration", "所选模型不支持该思考强度。");
        this.#session.setThinkingLevel(input.options.thinkingLevel);
      }
      const selectedTools = input?.options?.tools ?? this.#defaultTools;
      // noTools 只停用默认选择；Repa 的配置只能启用实际接入的内容工具和可信扩展。
      const available = new Set(this.#session.getAllTools().filter(tool => tool.sourceInfo.source !== "builtin").map(tool => tool.name));
      if (selectedTools.some(name => !available.has(name))) throw new RepaFault("configuration", "选择的工具尚未启用或不存在。");
      this.#session.setActiveToolsByName(selectedTools);
      const compaction = input?.options?.compaction;
      const modelKey = this.#session.model ? `${this.#session.model.provider}/${this.#session.model.id}` : undefined;
      this.#settings.applyOverrides({
        ...(compaction ? { compaction: {
          ...compaction,
          ...(modelKey ? { modelOverrides: { [modelKey]: {
            reserveTokens: compaction.reserveTokens, keepRecentTokens: compaction.keepRecentTokens,
          } } } : {}),
        } } : {}),
        ...(input?.options?.retry ? { retry: input.options.retry } : {}),
      });
      this.#summaryPrompts = input?.options?.summaryPrompts ?? { system: null, instructions: null };
      if (!this.#session.model)
        throw new RepaFault(
          "configuration",
          "没有可用模型，请配置模型连接后重试。",
        );
      if (input?.images.length && !this.#session.model.input.includes("image"))
        throw new RepaFault("unsupported_input", "所选模型不支持图片输入，请选择视觉模型或先取得文本表示。");
      const selected = structuredClone(settings);
      const sources = this.#options.backgroundSources ?? [];
      this.#backgroundStates = sources.map(source => ({ codec: source.codec, enabled: source.enabled(selected) }));
      const prepared = await Promise.all(sources.map((source, index) => this.#backgroundStates[index]?.enabled ? source.prepare() : undefined));
      if (this.#cancelled || this.#closed) return { status: "cancelled" };
      const contextFiles = selected.projectInstructions && this.#options.trustExtensions
        ? loadProjectContextFiles({ cwd: this.#options.learnerSpace, agentDir: this.#agentDir })
        : [];
      this.#runSettings = selected;
      const prompt = describePrompt({
        cwd: this.#options.learnerSpace,
        contextFiles,
        skills: this.#loader.getSkills().skills,
        selectedTools: this.#session.getActiveToolNames(),
      }, selected);
      prompt.sources.push(...sources.map((source, index) => ({
        id: source.codec.id, enabled: this.#backgroundStates[index]?.enabled ?? false, dynamic: true,
        reference: source.codec.customType,
        ...(prepared[index] ? { revision: prepared[index].revision } : {}),
      })));
      this.#runPrompt = prompt.system;
      prompt.sources.push({ id: "toolDefinitions", enabled: selectedTools.length > 0,
        content: JSON.stringify(this.#session.getAllTools().filter(tool => selectedTools.includes(tool.name))) });
      this.#promptDescription = prompt;
      this.#options.onEvent({ type: "prompt", prompt });
      this.#session.refreshContext();
      for (const [index, source] of sources.entries()) {
        const message = prepared[index]?.message;
        if (!message || message.role !== "custom") continue;
        const latest = this.#session.messages.findLast(item => source.codec.snapshot(item) !== undefined);
        if (!latest || !isDeepStrictEqual(source.codec.snapshot(latest), source.codec.snapshot(message)))
          await this.#session.sendCustomMessage(message, { triggerTurn: false });
      }
      this.#inputRequest = input?.requestId;
      const running = this.#session.prompt(text, { expandPromptTemplates: true, images: input?.images, source: "rpc" });
      await running;
      await this.#session.waitForIdle();
      if (this.#cancelled) return { status: "cancelled" };
      if (this.#compactionFailure) return { status: "failed", error: this.#compactionFailure };
      return this.#lastResult;
    } finally {
      this.#sending = false;
      this.#resolveReady?.();
      await this.#inputQueue.settled();
      this.#session.clearQueue();
      this.#pendingInputs.length = 0;
      this.#inputRequest = undefined;
    }
  }

  async steer(requestId: string, input: Pick<PreparedInput, "text" | "images">): Promise<boolean> {
    await this.#ready;
    return this.#inputQueue.run(async () => {
      if (!this.#sending || this.#cancelled || this.#session.isIdle) return false;
      this.#inputRequest = requestId;
      try {
        await this.#session.steer(input.text, input.images, { source: "rpc" });
        return true;
      } finally { this.#inputRequest = undefined; }
    });
  }

  #projectMessages(messages: WorkingMessage[]): WorkingMessage[] {
    const projected = projectBackgrounds(messages, this.#options.sessionManager, this.#backgroundStates);
    return this.#runSettings?.fileChanges === "on-demand" || !this.#runSettings
      ? projected.filter((message) => message.role !== "custom" || message.customType !== "repa.file-changes")
      : projected;
  }

  async #prepareContext(messages: WorkingMessage[]): Promise<WorkingMessage[]> {
    const change = await this.#fileChanges.prepare(this.#runSettings?.fileChanges ?? "on-demand");
    if (change) {
      // 此入口位于模型请求前，工具调用与结果已经配对。直接追加避免 SDK 将流中消息延后到本轮结束。
      const manager = this.#options.sessionManager;
      const id = manager.appendCustomMessageEntry("repa.file-changes", change.text, false, change.details);
      messages = [...messages, ...sessionEntryToContextMessages(manager.getEntry(id)!)];
      this.#session.refreshContext();
    }
    return this.#projectMessages(messages);
  }

  async cancel(): Promise<void> {
    if (this.#sending || !this.#session.isIdle) this.#cancelled = true;
    await this.#session.abort();
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#session.abort();
      await this.#session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
    } finally {
      this.#unsubscribe();
      this.#session.dispose();
      await this.#settings.flush();
    }
  }

  #onEvent(event: AgentSessionEvent): void {
    const emit = this.#options.onEvent;
    if (event.type === "message_start" && event.message.role === "user") {
      const requestId = this.#pendingInputs.shift();
      if (requestId) Object.assign(event.message, { repaRequestId: requestId });
      this.#inputRequest = undefined;
      this.#resolveReady?.();
    }
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.#liveId = `live-${randomUUID()}`;
      emit({ type: "phase", phase: "model" });
      emit({
        type: "message",
        message: {
          ...messageView(this.#liveId, event.message, this.#options.resources),
          streaming: true,
        },
      });
    } else if (event.type === "message_update" && this.#liveId) {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta" || update.type === "thinking_delta") {
        emit({
          type: "delta",
          messageId: this.#liveId,
          index: update.contentIndex,
          kind: update.type === "text_delta" ? "text" : "thinking",
          text: update.delta,
        });
      } else if (update.type.startsWith("toolcall_")) {
        emit({
          type: "message",
          message: {
            ...messageView(
              this.#liveId,
              event.message,
              this.#options.resources,
            ),
            streaming: true,
          },
        });
      }
    } else if (event.type === "message_end") {
      const replaces =
        event.message.role === "assistant" ? this.#liveId : undefined;
      if (event.message.role === "assistant") {
        this.#liveId = undefined;
        this.#lastResult =
          event.message.stopReason === "aborted"
            ? { status: "cancelled" }
            : event.message.stopReason === "error"
              ? {
                  status: "failed",
                  error: event.message.errorMessage ?? "Provider 请求失败。",
                }
              : { status: "completed" };
      }
      // Pi emits message_end before appending its entry. Reconcile the live message with that persisted identity.
      queueMicrotask(() => {
        const entries = this.#options.sessionManager.getEntries();
        const entry = entries.findLast(
          (x) =>
            (x.type === "message" && x.message === event.message) ||
            (x.type === "custom_message" &&
              event.message.role === "custom" &&
              x.content === event.message.content),
        );
        if (entry) {
          const message = historyView([entry], this.#options.resources)[0];
          if (message?.requestId) emit({ type: "entered", requestId: message.requestId, messageId: message.id });
          if (message)
            emit({
              type: "message",
              message,
              ...(replaces ? { replaces } : {}),
            });
        }
      });
    } else if (event.type === "session_info_changed") {
      emit({ type: "title", title: event.name });
    } else if (event.type === "entry_appended") {
      for (const message of historyView([event.entry], this.#options.resources))
        emit({ type: "message", message });
    } else if (
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_end"
    ) {
      emit({ type: "phase", phase: "tool" });
      emit({
        type: "tool",
        callId: event.toolCallId,
        name: event.toolName,
        status:
          event.type === "tool_execution_start"
            ? "running"
            : event.isError
              ? "failed"
              : "completed",
      });
    } else if (event.type === "auto_retry_start") {
      emit({ type: "phase", phase: "retry" });
      this.#notice("retry", event.errorMessage, "info");
    } else if (event.type === "compaction_start") {
      emit({ type: "phase", phase: "compaction" });
    } else if (event.type === "compaction_end") {
      if (event.errorMessage)
        this.#notice("compaction", event.errorMessage, "error");
      emit({ type: "phase", phase: "model" });
      for (const message of historyView(
        this.#options.sessionManager.getBranch(),
        this.#options.resources,
      ).filter((x) => x.role === "context"))
        emit({ type: "message", message });
    }
  }
}
