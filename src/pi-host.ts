import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getCurrentSystemMessage, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  loadProjectContextFiles,
  type AgentSession,
  type AgentSessionEvent,
  ModelRuntime,
  type SessionManager,
  SettingsManager,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
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
import {
  assembleSystemPrompt,
  contextSnapshot,
  makeContextMessage,
  projectContext,
  withModelContext,
  type WorkingMessage,
} from "./agent/context.js";
import { createContentTools } from "./agent/tools.js";
import { FileChanges } from "./agent/file-changes.js";
import type { PromptSettings } from "./configuration/schema.js";
import type { ContentStore } from "./content/store.js";

export { DEFAULT_BASE_PROMPT as REPA_BASE_PROMPT } from "./configuration/schema.js";
export interface PiModelOverride {
  modelRuntime: ModelRuntime;
  model: Model<any>;
}
export type Dialog = Pick<
  Interaction,
  "kind" | "title" | "message" | "options" | "initialValue"
>;
export interface DialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}
export interface ConversationRuntime {
  send(
    text: string,
    settings: PromptSettings,
  ): Promise<{ status: "completed" | "cancelled" | "failed"; error?: string }>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}
export type HostEvent =
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
    this.#unsubscribe = session.subscribe((event) => this.#onEvent(event));
  }

  static async open(options: OpenPiHostOptions): Promise<PiConversationHost> {
    const agentDir = path.resolve(options.agentDir ?? getAgentDir());
    await mkdir(agentDir, { recursive: true });
    const settings = SettingsManager.create(options.learnerSpace, agentDir, {
      projectTrusted: options.trustExtensions,
    });
    let host: PiConversationHost | undefined;
    const loader = new DefaultResourceLoader({
      cwd: options.learnerSpace,
      agentDir,
      settingsManager: settings,
      noExtensions: !options.trustExtensions,
      noSkills: !options.trustExtensions,
      noPromptTemplates: !options.trustExtensions,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "",
      appendSystemPrompt: [],
      // Pi 将 inline factories 放在磁盘扩展之后，确保 Repa 的来源开关最后生效。
      extensionFactories: [{
        name: "repa-context",
        factory(pi) {
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
          pi.on("session_before_compact", (event) => {
            if (!host) return;
            // Pi 的摘要调用不经过 context hook，同样排除已经关闭的自动来源。
            event.preparation.messagesToSummarize = host.#projectMessages(event.preparation.messagesToSummarize);
            event.preparation.turnPrefixMessages = host.#projectMessages(event.preparation.turnPrefixMessages);
          });
        },
      }],
    });
    await loader.reload({
      resolveProjectTrust: async () => options.trustExtensions,
    });
    const fileChanges = new FileChanges(options.content);
    const tools = await createContentTools(options.learnerSpace, options.content, loader, fileChanges);
    const created = await createAgentSession({
      cwd: options.learnerSpace,
      agentDir,
      model: options.modelOverride?.model,
      modelRuntime: options.modelOverride?.modelRuntime,
      resourceLoader: loader,
      sessionManager: withModelContext(options.sessionManager, () => ({
        learningContext: host ? host.#runSettings?.learningContext ?? false : false,
        fileChanges: host ? host.#runSettings?.fileChanges ?? "on-demand" : "on-demand",
      })),
      settingsManager: settings,
      noTools: "builtin",
      customTools: tools,
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
  ): Promise<{ status: "completed" | "cancelled" | "failed"; error?: string }> {
    if (this.#closed) throw new Error("会话运行实例已关闭。");
    if (this.#sending || !this.#session.isIdle)
      throw new RepaFault("busy", "会话已有正在处理的运行。");
    if (!this.#session.model)
      throw new RepaFault(
        "configuration",
        "没有可用模型，请配置模型连接后重试。",
      );
    this.#lastResult = { status: "completed" };
    this.#cancelled = false;
    this.#sending = true;
    try {
      const selected = structuredClone(settings);
      const view = selected.learningContext ? await this.#options.content.contextView() : undefined;
      if (this.#cancelled || this.#closed) return { status: "cancelled" };
      const contextFiles = selected.projectInstructions && this.#options.trustExtensions
        ? loadProjectContextFiles({ cwd: this.#options.learnerSpace, agentDir: this.#agentDir })
        : [];
      this.#runSettings = selected;
      this.#runPrompt = assembleSystemPrompt({
        cwd: this.#options.learnerSpace,
        contextFiles,
        skills: this.#loader.getSkills().skills,
        selectedTools: this.#session.getActiveToolNames(),
      }, selected);
      this.#session.refreshContext();
      if (view) {
        const latest = this.#session.messages.findLast((message) => contextSnapshot(message) !== undefined);
        if (!latest || !isDeepStrictEqual(contextSnapshot(latest), view)) {
          const message = makeContextMessage(view) as Extract<WorkingMessage, { role: "custom" }>;
          await this.#session.sendCustomMessage(message, { triggerTurn: false });
        }
      }
      await this.#session.prompt(text, { expandPromptTemplates: true });
      await this.#session.waitForIdle();
      return this.#cancelled ? { status: "cancelled" } : this.#lastResult;
    } finally {
      this.#sending = false;
    }
  }

  #projectMessages(messages: WorkingMessage[]): WorkingMessage[] {
    const projected = projectContext(messages, this.#options.sessionManager, this.#runSettings?.learningContext ?? false);
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
