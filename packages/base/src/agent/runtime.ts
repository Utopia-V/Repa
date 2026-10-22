import { randomUUID } from "node:crypto";
import { closeSync, createReadStream, openSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
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
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { AgentRuntime, AgentRuntimeOptions, AgentSession, AgentSpace, AgentSpaceOptions, AgentTool } from "../agent.js";
import { ASK_USER_TOOL, BUILTIN_TOOLS, RESERVED_TOOL_NAMES, type AgentDefinition, type AgentTask, type AgentWork, type BuiltinTool, type CompletionRequest } from "../plugin.js";
import { withRun } from "../run-context.js";
import { MessageDecisionSchema, RepaFault, type AgentInfo, type Confirm, type Confirmation, type ModelRef, type SessionInfo, type SessionParent, type PromptSection, type ProviderInfo } from "../schema.js";
import { askUserTool } from "./ask-user.js";
import { convertEvent, entryToPublic, textContent } from "./events.js";
import { credentialValues } from "../feedback/redact.js";
import { FileScope, generalFileTools, ReadState, spaceFileTools } from "./files.js";
import { limitToolText } from "./output.js";
import { readParent, saveParent } from "./parent.js";
import { applyPromptSections, BASE_INSTRUCTIONS, promptChangeNotice, promptSections } from "./prompts.js";
import { activeViews, changedViews, staleViewEdits, viewMessage, type ViewSnapshot } from "./views.js";

export interface AgentTestOptions extends AgentRuntimeOptions {
  modelRuntime: ModelRuntime;
  defaultModel?: ModelRef;
  settingsManager?: SettingsManager;
  now?: () => number;
  viewBatchSize?: number;
  cacheTtlMs?: number;
  extensionFactories?: ExtensionFactory[];
  toolNames?: string[];
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

const GENERAL_AGENT = "general";
const AGENT_ENTRY = "repa-agent";
const SUBAGENT_TOOL = "subagent";

// 没有空间写入路径时（只测运行时、不接空间历史的场合）直接写文件。
const DIRECT_WRITES = {
  lock: <T>(action: () => Promise<T>) => action(),
  commit: <T>(_file: string, action: () => Promise<T>) => action(),
};

// 这些工具会写到底座看不见的地方，带它们的运行是不透明写入者。
const OPAQUE_TOOLS = new Set(["bash", "powershell"]);

// 子 Agent 嵌套层数上限的默认值。这是 Repa 的假设：定义允许循环和重入，用层数挡住失控的递归，
// 以后按实际使用调整。
const SUBAGENT_DEPTH = 3;

// 通用 Agent 起自己时，subagent 工具里给它的说明，相当于 Claude Code 的通用子代理。
const GENERAL_SUBAGENT = "通用 Agent，工具与你相同，适合交给它独立完成的调研、修改和多步任务";

/** 子 Agent 的运行挂在父运行下；ancestorRunIds 是父运行自己的祖先链，从近到远。 */
interface ParentRun {
  runId: string;
  sessionId: string;
  ancestorRunIds: readonly string[];
}

/** 一个 Agent 在当前空间中的装配；会话初始化时取得，工具与 view 来源在会话内不变。 */
interface AgentProfile {
  id: string;
  general: boolean;
  builtins: BuiltinTool[];
  tools: AgentTool[];
  /** 是否带底座的 ask_user：通用 Agent 默认带上，插件 Agent 在定义里列出才有。 */
  askUser: boolean;
  subagents: string[];
  /** 本 Agent 自己的提示段：通用 Agent 为各插件说明，插件 Agent 为 agent:<id>。 */
  sections(): { id: string; text: string }[];
  views(): Promise<{ id: string; text: string }[]>;
  beforeMessage?: AgentDefinition["beforeMessage"];
}

function byId<T extends { id: string }>(left: T, right: T): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** 会话文件记下所属 Agent；改动前创建、没有这条记录的会话属于通用 Agent。 */
function sessionAgent(manager: SessionManager): string {
  const entry = manager.getEntries().find(item => item.type === "custom" && item.customType === AGENT_ENTRY);
  if (entry === undefined) return GENERAL_AGENT;
  const data: unknown = entry.type === "custom" ? entry.data : undefined;
  if (data !== null && typeof data === "object" && "agent" in data && typeof data.agent === "string" && data.agent.length > 0) return data.agent;
  // 记录损坏时不回退为通用 Agent，避免把受限的会话按完整权限打开。
  throw new RepaFault("invalid_session_agent", "会话的 Agent 记录无法读取", { id: manager.getSessionId() });
}

async function hasSessionId(file: string, id: string): Promise<boolean> {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const header: unknown = JSON.parse(line);
      return header !== null && typeof header === "object" && "type" in header
        && header.type === "session" && "id" in header && header.id === id;
    }
    return false;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  } finally {
    lines.close();
    input.destroy();
  }
}

function toolDefinition(tool: AgentTool): ToolDefinition {
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
    // 装配写错 Agent id 时立即报告，而不是让所有 Agent 都变得不能直接对话。
    const known = new Set([...(options.generalAgent === false ? [] : [GENERAL_AGENT]), ...(options.agents?.() ?? []).map(agent => agent.id)]);
    for (const agent of options.directAgents ?? []) {
      if (!known.has(agent)) throw new RepaFault("unknown_agent", "装配指定的直接对话 Agent 不存在或未启用", { agent });
    }
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

  async listProviders(): Promise<ProviderInfo[]> {
    this.assertOpen();
    const models = this.options.modelRuntime;
    const stored = new Set((await models.listCredentials()).map(entry => entry.providerId));
    // checkAuth 当场解析保存的凭据和环境变量；getProviderAuthStatus 读的是异步刷新的快照，登录后可能还没更新。
    const providers = await Promise.all(models.getProviders().map(async provider => {
      const methods: ProviderInfo["methods"] = [];
      if (provider.auth.oauth) methods.push({ type: "oauth", name: provider.auth.oauth.name, login: true });
      if (provider.auth.apiKey) methods.push({ type: "api_key", name: provider.auth.apiKey.name, login: provider.auth.apiKey.login !== undefined });
      const info: ProviderInfo = { id: provider.id, name: provider.name, methods, stored: stored.has(provider.id) };
      const check = await models.checkAuth(provider.id);
      if (check) info.configured = check.type;
      return info;
    }));
    return providers.sort((a, b) => a.name.localeCompare(b.name));
  }

  defaultModel(): ModelRef | undefined {
    this.assertOpen();
    const model = this.model();
    return model && { provider: model.provider, id: model.id };
  }

  async setDefaultModel(reference: ModelRef): Promise<void> {
    this.assertOpen();
    this.model(reference);
    // 沿用 Pi 自己的默认模型设置，与 Pi 会话切换模型时保存的是同一项。
    this.settings.setDefaultModelAndProvider(reference.provider, reference.id);
    await this.settings.flush();
    this.checkSettings();
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
    }, {
      getDeviceId: () => this.settings.getOrCreateDeviceId(),
      agentName: "Repa",
    });
    await Promise.all(notices);
    await this.settings.flush();
    this.checkSettings();
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

  /**
   * 反馈包脱敏用的凭据值。auth.json 里写的原值（含 OAuth 的 refresh token）直接读文件；
   * 原值可以是 `${VAR}` 或 `!命令`，真正发出去的密钥只有 Pi 解析后才知道，所以 api_key 再经 getAuth 取一遍。
   */
  async credentials(): Promise<string[]> {
    this.assertOpen();
    let stored: string[] = [];
    try {
      stored = credentialValues(JSON.parse(await readFile(path.join(this.options.agentDir, "auth.json"), "utf8")));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    // OAuth 的令牌原值已经在文件里；跳过它们，免得为脱敏去刷新令牌。
    const keys = (await this.options.modelRuntime.listCredentials()).filter(entry => entry.type === "api_key");
    const resolved = await Promise.all(keys.map(async ({ providerId }) => {
      const result = await this.options.modelRuntime.getAuth(providerId);
      if (result === undefined) return [];
      return [result.auth.apiKey, ...Object.values(result.auth.headers ?? {}), ...Object.values(result.env ?? {})]
        .filter((value): value is string => typeof value === "string");
    }));
    return [...stored, ...resolved.flat()];
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
  private closing?: Promise<void>;
  private scope?: Promise<FileScope>;

  constructor(readonly runtime: Runtime, readonly options: AgentSpaceOptions, private onClose: () => void) {}

  assertOpen(): void {
    this.runtime.assertOpen();
    if (this.closing !== undefined) throw new RepaFault("space_closed", "Agent 空间已经关闭");
  }

  /** 所有 Agent 的写入和编辑、插件 Agent 的全部文件工具共用一个范围：空间内，不含 .repa/。 */
  fileScope(): Promise<FileScope> {
    if (this.scope === undefined) {
      const created = FileScope.create(this.options.root);
      // 只缓存成功的结果；一次读取根目录失败后，下次建会话重新尝试。
      created.catch(() => {
        if (this.scope === created) this.scope = undefined;
      });
      this.scope = created;
    }
    return this.scope;
  }

  /** Agent 能否运行：关掉的通用 Agent、已经不存在的插件 Agent 都不能。 */
  available(id: string): boolean {
    if (id === GENERAL_AGENT) return this.options.generalAgent !== false;
    return this.options.agents?.().some(item => item.id === id) ?? false;
  }

  private direct(id: string, fallback: boolean): boolean {
    return this.options.directAgents === undefined ? fallback : this.options.directAgents.includes(id);
  }

  agents(): AgentInfo[] {
    this.assertOpen();
    const result: AgentInfo[] = [];
    if (this.options.generalAgent !== false) result.push({ id: GENERAL_AGENT, direct: this.direct(GENERAL_AGENT, true) });
    for (const definition of [...(this.options.agents?.() ?? [])].sort(byId)) {
      result.push({
        id: definition.id,
        ...(definition.description === undefined ? {} : { description: definition.description }),
        direct: this.direct(definition.id, definition.direct ?? false),
      });
    }
    return result;
  }

  profile(id: string): AgentProfile {
    if (id === GENERAL_AGENT && this.options.generalAgent !== false) {
      return {
        id,
        general: true,
        builtins: [...BUILTIN_TOOLS],
        tools: this.options.tools(),
        askUser: true,
        // 和 Claude Code 一样能起子 Agent：自己，以及空间里定义的任何插件 Agent。插件 Agent 的工具都在通用 Agent 的范围内。
        subagents: [GENERAL_AGENT, ...(this.options.agents?.() ?? []).map(item => item.id).sort()],
        sections: () => [...this.options.instructions()].sort(byId),
        views: () => this.options.views(),
      };
    }
    const definition = id === GENERAL_AGENT ? undefined : this.options.agents?.().find(item => item.id === id);
    if (definition === undefined) throw new RepaFault("agent_not_found", "Agent 不存在或未启用", { agent: id });
    const names = new Set(definition.tools);
    return {
      id,
      general: false,
      // 插件宿主在打开时已经拒绝列了 grep 的定义；这里也不把 Pi 的 grep 交给插件 Agent，它会越过 .repa/.ignore。
      builtins: BUILTIN_TOOLS.filter(name => names.has(name) && name !== "grep"),
      tools: this.options.tools().filter(tool => names.has(tool.name)),
      askUser: names.has(ASK_USER_TOOL),
      subagents: [...new Set(definition.subagents ?? [])],
      sections: () => [{ id: `agent:${id}`, text: definition.instructions() }],
      async views() {
        const text = await definition.view?.();
        return text === undefined ? [] : [{ id: `agent:${id}`, text }];
      },
      ...(definition.beforeMessage === undefined ? {} : { beforeMessage: message => definition.beforeMessage?.(message) ?? Promise.resolve() }),
    };
  }

  private async spaceSection(): Promise<{ id: string; text: string }> {
    let spaceInstructions = "";
    try {
      spaceInstructions = await readFile(path.join(this.options.root, "AGENTS.md"), "utf8");
    } catch (error) {
      if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    return { id: "space", text: [`当前空间：${this.options.root}`, spaceInstructions].filter(Boolean).join("\n\n") };
  }

  /**
   * 通用 Agent 沿用原有分段：基础说明、空间、Skill、工具与各插件说明。
   * 插件 Agent 只有空间说明和自己的职责：Skill 位于它的文件范围之外，工具清单已由 Pi 声明。
   */
  async promptSections(profile: AgentProfile): Promise<PromptSection[]> {
    const space = await this.spaceSection();
    if (!profile.general) return promptSections(this.options, [space, ...profile.sections()]);
    const skills = [
      ...loadSkillsFromDir({ dir: path.join(this.runtime.options.agentDir, "skills"), source: "repa" }).skills,
      ...loadSkillsFromDir({ dir: path.join(this.options.root, ".repa", "skills"), source: "repa-space" }).skills,
    ];
    const tools = [
      ...profile.builtins,
      ...profile.tools.map(tool => tool.name),
      ...(profile.subagents.length > 0 ? [SUBAGENT_TOOL] : []),
      ...(profile.askUser ? [ASK_USER_TOOL] : []),
    ];
    return promptSections(this.options, [
      { id: "base", text: BASE_INSTRUCTIONS },
      space,
      { id: "skills", text: formatSkillsForPrompt(skills, "read") },
      { id: "tools", text: `使用已声明的工具。edit 的 oldText 必须逐字匹配，保留原文标点和换行。可用工具：${tools.join("、")}` },
      ...profile.sections(),
    ]);
  }

  async preview(agent = GENERAL_AGENT) {
    this.assertOpen();
    const profile = this.profile(agent);
    return { sections: await this.promptSections(profile), views: await profile.views() };
  }

  async create(options: { agent?: string; model?: ModelRef; parent?: SessionParent } = {}): Promise<Session> {
    this.assertOpen();
    const agent = options.agent ?? GENERAL_AGENT;
    // 先确认 Agent 可用，不留下打不开的会话文件。
    this.profile(agent);
    const file = path.join(this.options.sessionsDir, `${randomUUID()}.jsonl`);
    // Pi 的会话入口同步建立 header；同步创建这个空文件使初始化立即登记，close 能拥有整个生命周期。
    const descriptor = openSync(file, "wx");
    closeSync(descriptor);
    // 已打开的文件会逐条保存，首个 assistant 前也不丢消息。
    const manager = SessionManager.open(file, this.options.sessionsDir, this.options.root);
    // 装配和运行之前保存父关联，runStart 只能看到已落盘的关联。
    if (options.parent !== undefined) await saveParent(this.options.sessionsDir, manager.getSessionId(), options.parent);
    // 所属 Agent 写在会话开头，不进入模型上下文；分支复制全部条目，也就沿用同一个 Agent。
    manager.appendCustomEntry(AGENT_ENTRY, { agent });
    return this.load(manager, options.model);
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

  private async findSessionPath(id: string): Promise<string | undefined> {
    const files = (await readdir(this.options.sessionsDir)).filter(file => file.endsWith(".jsonl"));
    // Pi 1.1.0 的 create/fork 使用 <时间戳>_<id>.jsonl；文件名只加速定位，正确性靠会话头核验。
    const matchesName = (file: string) => file.endsWith(`_${id}.jsonl`);
    const ordered = [...files.filter(matchesName), ...files.filter(file => !matchesName(file))];
    for (const file of ordered) {
      const sessionPath = path.join(this.options.sessionsDir, file);
      // 目录归当前空间所有；仅核对头部的 type/id，不按旧 cwd 过滤。
      if (await hasSessionId(sessionPath, id)) return sessionPath;
    }
    return undefined;
  }

  async sessionFile(id: string): Promise<string | undefined> {
    this.assertOpen();
    return this.findSessionPath(id);
  }

  async get(id: string): Promise<Session> {
    this.assertOpen();
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const sessionPath = await this.findSessionPath(id);
    if (sessionPath === undefined) throw new RepaFault("session_not_found", "会话不存在", { id });
    return this.load(SessionManager.open(sessionPath, this.options.sessionsDir, this.options.root));
  }

  async abortAgent(agent: string): Promise<void> {
    this.assertOpen();
    await Promise.all([...this.sessions.values()].map(async (pending) => {
      const session = await pending;
      if (session.info().agent === agent) {
        await session.abort();
      }
    }));
  }

  async list(): Promise<SessionInfo[]> {
    this.assertOpen();
    const infos = new Map<string, SessionInfo>();
    // 会话目录归当前空间所有；复制或移动空间后，header.cwd 仍是旧路径，不用于筛选。
    for (const entry of await SessionManager.listAll(this.options.sessionsDir)) {
      const manager = SessionManager.open(entry.path, this.options.sessionsDir, this.options.root);
      const model = manager.buildSessionProjection().model;
      const parent = await readParent(this.options.sessionsDir, entry.id);
      infos.set(entry.id, describeSession(manager, model ? { provider: model.provider, id: model.modelId } : undefined, sessionAgent(manager), parent));
    }
    for (const session of await Promise.all(this.sessions.values())) infos.set(session.info().id, session.info());
    return [...infos.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** 子 Agent 的会话用完即释放 Pi 会话；之后查看历史时再从文件打开。 */
  async release(session: Session): Promise<void> {
    const id = session.info().id;
    this.sessions.delete(id);
    await session.close();
  }

  async runAgent(task: AgentTask): Promise<AgentWork> {
    const session = await this.create({ agent: task.agent, model: task.model });
    const result = session.runTask(task.text);
    result.catch(() => undefined);
    return { id: session.info().id, result, cancel: () => session.abort() };
  }

  close(): Promise<void> {
    // 会话的创建和登记是同步的，关闭开始后不会再有新会话加入。
    this.closing ??= (async () => {
      await Promise.all([...this.sessions.values()].map(async pending => {
        const session = await pending.catch(() => undefined);
        await session?.close();
      }));
      this.sessions.clear();
      this.onClose();
    })();
    return this.closing;
  }
}

class Session implements AgentSession {
  readonly agent: string;
  private pi?: PiSession;
  private assembled?: AgentProfile;
  // 工具集里有命令行：整次运行持空间写锁独占，前后整体快照。由工具集推出，不由 Agent 自己声明。
  private opaque = false;
  // 整文件写入核对基线用的读取记录，属于这个会话。
  private readonly reads = new ReadState();
  // 同一会话的运行依次进行；后来的运行等前一个结束，不同会话之间互不等待。
  private turn: Promise<void> = Promise.resolve();
  private runId?: string;
  private runAncestors?: readonly string[];
  private abortController?: AbortController;
  private currentViews: ViewSnapshot[] = [];
  private currentSections: PromptSection[] = [];
  private lastRequestAt?: number;
  private closed = false;
  private pending = new Map<AbortController, Promise<void>>();
  private enqueuing = new Set<Promise<unknown>>();
  private cancelling?: Promise<void>;
  // 每次开始取消加一，插件判断期间发生过取消的消息不再投递。
  private cancellations = 0;
  private closing?: Promise<void>;

  private parent?: SessionParent;

  constructor(private space: Space, private manager: SessionManager) {
    this.agent = sessionAgent(manager);
  }

  get session(): PiSession {
    if (!this.pi) throw new RepaFault("session_unavailable", "会话尚未打开");
    return this.pi;
  }

  get profile(): AgentProfile {
    if (!this.assembled) throw new RepaFault("session_unavailable", "会话尚未打开");
    return this.assembled;
  }

  now(): number {
    return this.space.runtime.options.now?.() ?? Date.now();
  }

  async initialize(reference?: ModelRef): Promise<void> {
    this.parent = await readParent(this.space.options.sessionsDir, this.manager.getSessionId());
    // Agent 已关掉或不存在时只读打开：能列出和查看历史，不建 Pi 会话，也不能运行。
    if (!this.space.available(this.agent)) return;
    const { runtime, options } = this.space;
    const profile = this.space.profile(this.agent);
    this.assembled = profile;
    const reservedTools = new Set(RESERVED_TOOL_NAMES);
    const names = new Set<string>();
    for (const tool of profile.tools) {
      // Pi 1.1.0 将这些字符解释为工具选择规则，插件工具必须是字面名称。
      if (tool.name.includes("*") || /^[+-]/u.test(tool.name)) throw new RepaFault("invalid_tool_name", "插件工具名称不能包含选择规则", { name: tool.name });
      if (reservedTools.has(tool.name) || names.has(tool.name)) throw new RepaFault("tool_name_conflict", "插件工具名称重复或覆盖内置工具", { name: tool.name });
      names.add(tool.name);
    }
    const factory: ExtensionFactory = pi => {
      pi.on("tool_result", event => {
        const original = event.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        const text = limitToolText(original);
        // Pi 1.1.0 替换 content 会清除旧 structuredContent；details 留给界面，不能复制完整正文。
        // 升级时复核 extensions/runner 与 agent-loop 到模型 transcript 的这条路径。
        if (text !== original) return { content: [{ type: "text", text }, ...event.content.filter(part => part.type !== "text")] };
      });
      pi.on("before_agent_start", async event => {
        applyPromptSections(event.systemPromptOptions, this.currentSections);
        const notice = runtime.options.promptChangeNotice === false ? undefined : promptChangeNotice(this.session.messages, this.currentSections);
        if (notice) {
          await this.session.sendCustomMessage({
            customType: "repa-prompt-change", content: notice, display: false,
          }, { deliverAs: "nextTurn", triggerTurn: false });
        }
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
      extensionFactories: [factory, ...(runtime.options.extensionFactories ?? [])],
    });
    await loader.reload();
    const saved = this.manager.buildSessionProjection().model;
    const model = runtime.model(reference ?? (saved ? { provider: saved.provider, id: saved.modelId } : undefined));
    // 工具清单在创建时固定；插件 Agent 的内置文件工具换成限在空间内、不进 .repa/ 的实现。
    // 所有 Agent 的写入和编辑都经过空间的写入路径，只记这次碰到的文件。
    const scope = await this.space.fileScope();
    const files = { scope, writes: options.writes ?? DIRECT_WRITES, reads: this.reads };
    const fileTools = profile.general
      ? generalFileTools(files, (target, signal) => this.approveOutsideWrite(target, signal))
      : spaceFileTools(files, profile.builtins);
    const toolNames = [
      ...profile.builtins,
      ...profile.tools.map(tool => tool.name),
      ...(profile.subagents.length > 0 ? [SUBAGENT_TOOL] : []),
      ...(profile.askUser ? [ASK_USER_TOOL] : []),
      ...(profile.general ? runtime.options.toolNames ?? [] : []),
    ];
    this.opaque = toolNames.some(name => OPAQUE_TOOLS.has(name));
    const result = await createAgentSession({
      cwd: options.root,
      agentDir: runtime.options.agentDir,
      modelRuntime: runtime.options.modelRuntime,
      model,
      sessionManager: this.manager,
      settingsManager: runtime.settings,
      resourceLoader: loader,
      tools: toolNames,
      customTools: [
        ...fileTools,
        ...profile.tools.map(toolDefinition),
        ...(profile.subagents.length > 0 ? [this.subagentTool(profile)] : []),
        ...(profile.askUser ? [askUserTool(options.ask)] : []),
      ],
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
    return describeSession(this.manager, this.model(), this.agent, this.parent);
  }

  private model(): ModelRef | undefined {
    if (this.pi !== undefined) {
      const current = this.pi.model;
      return current ? { provider: current.provider, id: current.id } : undefined;
    }
    // 只读打开的会话没有 Pi 会话，沿用记录里最后选用的模型。
    const saved = this.manager.buildSessionProjection().model;
    return saved ? { provider: saved.provider, id: saved.modelId } : undefined;
  }

  private assertRunnable(): void {
    if (this.pi === undefined) throw new RepaFault("agent_not_found", "这个会话的 Agent 已关掉或不存在，只能查看历史", { agent: this.agent });
  }

  history() {
    return this.manager.getBranch().flatMap(entry => {
      const converted = entryToPublic(entry);
      return converted ? [converted] : [];
    });
  }

  async send(text: string): Promise<void> {
    this.assertRunnable();
    // 没有判断的 Agent 不经过 admit，同步进入 run：多一次 await 会让紧随其后的取消拿不到这次运行。
    if (this.profile.beforeMessage !== undefined) {
      this.assertAccepting();
      await this.admit("send", text);
    }
    await this.run(text);
  }

  /** 插件程序交给后台 Agent 的任务，不是用户消息，不经过插件的消息判断。 */
  async runTask(text: string): Promise<void> {
    await this.run(text);
  }

  private assertAccepting(): void {
    this.assertRunnable();
    this.space.assertOpen();
    if (this.closed) throw new RepaFault("session_closed", "会话已关闭");
    if (this.cancelling) throw new RepaFault("cancelled", "会话运行正在取消");
  }

  /** 插件 Agent 的会话收到用户消息前先交给插件判断；拒收或判断失败时消息不进入会话。 */
  private async admit(mode: "send" | "steer" | "followUp", text: string): Promise<void> {
    const decide = this.profile.beforeMessage;
    if (decide === undefined) return;
    const cancellations = this.cancellations;
    const message = { sessionId: this.manager.getSessionId(), agent: this.agent, mode, text, ...(this.runId === undefined ? {} : { runId: this.runId }) };
    let decision: unknown;
    try {
      decision = await decide(message);
    } catch {
      // 判断失败也不放行，前端得到可处理的错误码，不暴露插件内部的错误细节。
      throw new RepaFault("message_check_failed", "插件未能判断这条消息，消息没有发送", { agent: this.agent });
    }
    if (decision !== undefined && !Value.Check(MessageDecisionSchema, decision)) {
      throw new RepaFault("invalid_message_decision", "插件对消息的判断不符合接口要求", { agent: this.agent });
    }
    if (decision?.status === "rejected") {
      throw new RepaFault("message_rejected", decision.message, {
        agent: this.agent,
        reason: decision.reason,
        ...(decision.data === undefined ? {} : { data: decision.data }),
      });
    }
    // 判断期间用户取消过运行：这条消息发生在取消之前，不在取消之后补投。
    if (this.cancellations !== cancellations) throw new RepaFault("cancelled", "会话运行已取消");
    this.assertAccepting();
  }

  /** 子 Agent 的一次运行；取消或失败都抛错，交给父 Agent 作为工具结果。 */
  async runChild(text: string, parent: ParentRun): Promise<{ runId: string; text: string }> {
    const outcome = await this.run(text, parent);
    if (outcome.status === "aborted") throw new RepaFault("cancelled", "子 Agent 运行已取消");
    return { runId: outcome.runId, text: outcome.text };
  }

  private async run(text: string, parent?: ParentRun): Promise<{ runId: string; status: "completed" | "aborted"; text: string }> {
    this.assertAccepting();
    const runId = randomUUID();
    const controller = new AbortController();
    let finish: () => void = () => undefined;
    const settled = new Promise<void>(resolve => { finish = resolve; });
    this.pending.set(controller, settled);
    const previous = this.turn;
    this.turn = settled;
    // 状态在 execute 闭包内更新；断言避免 TypeScript 按初值收窄。
    let status = "completed" as "completed" | "failed" | "aborted";
    let started = false;
    let reply = "";
    const link = parent === undefined ? undefined : { parentRunId: parent.runId, parentSessionId: parent.sessionId };
    const ancestorRunIds = parent === undefined ? [] : [parent.runId, ...parent.ancestorRunIds];
    const execute = async () => {
      if (controller.signal.aborted) throw new RepaFault("cancelled", "排队中的会话运行已取消");
      if (this.closed) throw new RepaFault("session_closed", "会话已关闭");
      this.runId = runId;
      this.runAncestors = ancestorRunIds;
      this.abortController = controller;
      started = true;
      this.space.options.onEvent({ sessionId: this.manager.getSessionId(), runId, type: "runStart", ...(this.parent === undefined ? {} : { parent: this.parent }), ...(link === undefined ? {} : { data: link }) });
      try {
        // view、工具和文件写入都在运行上下文内执行，能读到本次 runId 与祖先链。
        await withRun({ runId, ancestorRunIds, sessionId: this.manager.getSessionId(), agent: this.agent }, async () => {
          // 外部提示和 view 的失败在 Pi preflight 之外传播，不被扩展错误容错吞掉。
          this.currentSections = await this.space.promptSections(this.profile);
          this.currentViews = await this.profile.views();
          controller.signal.throwIfAborted();
          this.manager.appendCustomEntry("repa-run", { runId, ...link });
          await this.session.prompt(text);
        });
        const last = this.session.messages.findLast(message => message.role === "assistant");
        if (last?.role === "assistant" && last.stopReason === "aborted") status = "aborted";
        if (last?.role === "assistant" && last.stopReason === "error") throw new RepaFault("model_error", last.errorMessage ?? "模型请求失败");
        if (last?.role === "assistant") reply = textContent(last.content);
      } catch (error) {
        if (controller.signal.aborted) throw new RepaFault("cancelled", "会话运行已取消");
        throw error;
      } finally {
        this.runId = undefined;
        this.runAncestors = undefined;
        this.abortController = undefined;
      }
    };
    try {
      await previous;
      // 只有带命令行的运行整次进 record，持空间写锁独占；其余运行的写入各自按路径记账，可以并行。
      // 子 Agent 不另进：不透明父运行的窗口里它直接写文件，算在父运行的快照里，否则会和等它结果的父运行互相等待。
      if (parent === undefined && this.opaque) await this.space.options.record(runId, execute);
      else await execute();
    } catch (error) {
      status = error instanceof RepaFault && error.code === "cancelled" ? "aborted" : "failed";
      this.space.options.onEvent({ sessionId: this.manager.getSessionId(), runId, type: "error", text: error instanceof RepaFault ? error.message : "Agent 运行失败", data: { code: error instanceof RepaFault ? error.code : "agent_error" } });
      throw error;
    } finally {
      // 不透明运行的结束包含空间快照提交；不能把 Pi 的模型循环结束当作整个运行结束。
      this.pending.delete(controller);
      finish();
      if (started) this.space.options.onEvent({ sessionId: this.manager.getSessionId(), runId, type: "runEnd", data: { status } });
    }
    return { runId, status: status === "aborted" ? "aborted" : "completed", text: reply };
  }

  /**
   * 通用 Agent 写空间外的文件：和命令一样先问发起这次运行的连接，Full Access 时不问。
   * 这次写入不经过空间的写入路径，不进历史，也就不能撤回，确认里要说清楚。
   */
  private async approveOutsideWrite(target: string, signal: AbortSignal | undefined): Promise<void> {
    const options = this.space.options;
    if (options.commandPolicy() === "fullAccess") return;
    const answer = await options.confirm({
      kind: "command",
      title: "允许写入空间外的文件？",
      message: `${target}\n这次写入不会进入空间的历史，之后不能撤回。`,
    }, signal ?? this.abortController?.signal);
    if (answer !== true) throw new RepaFault("write_not_allowed", `用户没有允许写入空间外的文件：${target}`, { path: target });
  }

  /**
   * 父 Agent 的 subagent 工具；只能启动定义中列出的子 Agent。Pi 默认并行执行同一条回复里的工具调用，
   * 这个工具不标 sequential，一条回复里起的几个子 Agent 就同时运行。
   */
  private subagentTool(profile: AgentProfile): ToolDefinition {
    const lines = profile.subagents.map(id => {
      const description = id === GENERAL_AGENT ? GENERAL_SUBAGENT : this.space.options.agents?.().find(item => item.id === id)?.description;
      return description === undefined ? `- ${id}` : `- ${id}：${description}`;
    });
    return defineTool({
      name: SUBAGENT_TOOL,
      label: SUBAGENT_TOOL,
      description: `启动一个子 Agent 独立完成任务，返回它的最终回复。子 Agent 看不到当前对话，task 里要写清它需要的信息。一条回复里起的几个子 Agent 同时运行。可以启动的子 Agent：\n${lines.join("\n")}`,
      parameters: Type.Object({
        agent: Type.Union(profile.subagents.map(id => Type.Literal(id))),
        task: Type.String({ minLength: 1, description: "交给子 Agent 的完整任务" }),
      }, { additionalProperties: false }),
      execute: async (callId, input, signal) => {
        const result = await this.startSubagent(input.agent, input.task, callId, signal);
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: { sessionId: result.sessionId, runId: result.runId, agent: input.agent },
        };
      },
    });
  }

  /**
   * 子 Agent 在父运行内启动，父运行取消时一起取消，结束后释放会话。工具不超过父 Agent 已在插件打开时检查；
   * 这里限制嵌套层数，超过上限的请求作为工具错误交回父 Agent。
   */
  private async startSubagent(agent: string, task: string, callId: string, signal: AbortSignal | undefined): Promise<{ sessionId: string; runId: string; text: string }> {
    const parentRunId = this.runId;
    const ancestors = this.runAncestors;
    if (parentRunId === undefined || ancestors === undefined) throw new RepaFault("run_not_active", "子 Agent 只能在运行中启动");
    if (!this.profile.subagents.includes(agent)) throw new RepaFault("subagent_not_allowed", "当前 Agent 不能启动这个子 Agent", { agent });
    // 子运行的祖先链比父运行多一层，链长就是它所在的嵌套层数。
    const limit = this.space.runtime.options.maxSubagentDepth ?? SUBAGENT_DEPTH;
    if (ancestors.length + 1 > limit) throw new RepaFault("subagent_depth_exceeded", `子 Agent 最多嵌套 ${limit} 层，不能再启动`, { agent, limit });
    signal?.throwIfAborted();
    const model = this.session.model;
    const child = await this.space.create({ agent, parent: { sessionId: this.manager.getSessionId(), runId: parentRunId, callId }, ...(model === undefined ? {} : { model: { provider: model.provider, id: model.id } }) });
    const cancel = () => { child.abort().catch(() => undefined); };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      signal?.throwIfAborted();
      const outcome = await child.runChild(task, { runId: parentRunId, sessionId: this.manager.getSessionId(), ancestorRunIds: ancestors });
      return { sessionId: child.info().id, ...outcome };
    } finally {
      signal?.removeEventListener("abort", cancel);
      await this.space.release(child);
    }
  }

  async steer(text: string): Promise<void> {
    await this.queueMessage(text, "steer");
  }

  async followUp(text: string): Promise<void> {
    await this.queueMessage(text, "followUp");
  }

  private async queueMessage(text: string, mode: "steer" | "followUp"): Promise<void> {
    this.assertAccepting();
    if (this.profile.beforeMessage !== undefined) await this.admit(mode, text);
    if (!this.session.isStreaming) {
      await this.run(text);
      return;
    }
    // Pi 的输入钩子在入队前可以 await；取消必须拥有这段尚未入队的操作。
    const operation = this.session[mode](text);
    this.enqueuing.add(operation);
    try {
      await operation;
    } finally {
      this.enqueuing.delete(operation);
    }
  }

  abort(): Promise<void> {
    // 只读打开的会话没有在运行的工作。
    if (this.pi === undefined) return Promise.resolve();
    if (this.cancelling) return this.cancelling;
    this.cancellations++;
    let resolve: () => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const cancelling = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    this.cancelling = cancelling;
    const pending = [...this.pending.entries()];
    const enqueuing = [...this.enqueuing];
    const finished = async () => {
      try {
        for (const [controller] of pending) controller.abort();
        // 立即中止运行并移除已有队列；输入钩子完成后再清理它们迟到的入队结果。
        this.session.clearQueue();
        const settled = await Promise.allSettled([
          this.session.abort(),
          ...enqueuing,
          ...pending.map(([, completed]) => completed),
        ]);
        const aborted = settled[0];
        if (aborted?.status === "rejected") throw aborted.reason;
      } finally {
        this.session.clearQueue();
        this.cancelling = undefined;
      }
    };
    void finished().then(resolve, reject);
    return cancelling;
  }

  async setModel(reference: ModelRef): Promise<void> {
    this.assertRunnable();
    this.space.assertOpen();
    const model = this.space.runtime.model(reference);
    if (!model) throw new RepaFault("model_not_found", "模型不存在");
    await this.session.setModel(model);
  }

  async compact(): Promise<void> {
    this.assertRunnable();
    this.space.assertOpen();
    this.currentViews = await this.profile.views();
    await this.session.compact();
  }

  async fork(entryId: string): Promise<AgentSession> {
    this.assertRunnable();
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

  close(): Promise<void> {
    // 多个持有者可能同时关闭同一会话，都等待同一次取消与释放。
    this.closing ??= (async () => {
      this.closed = true;
      await this.abort();
      this.pi?.dispose();
    })();
    return this.closing;
  }
}

export function cacheStatusForTest(session: AgentSession) {
  if (!(session instanceof Session)) throw new Error("不是当前运行时的会话");
  return session.session.cacheWarmingStatus;
}

/** 列表用的会话摘要。时间和第一条用户消息与 Pi 的 SessionManager.list 取法一致，已打开的会话也能即时算出。 */
function describeSession(manager: SessionManager, model: ModelRef | undefined, agent: string, parent: SessionParent | undefined): SessionInfo {
  const createdAt = manager.getHeader()?.timestamp ?? new Date().toISOString();
  let updatedAt = createdAt;
  let preview: string | undefined;
  for (const entry of manager.getEntries()) {
    if (entry.type !== "message") continue;
    if (entry.timestamp > updatedAt) updatedAt = entry.timestamp;
    if (preview === undefined && entry.message.role === "user") {
      const text = textContent(entry.message.content).replace(/\s+/gu, " ").trim();
      if (text) preview = text.slice(0, 200);
    }
  }
  const name = manager.getSessionName();
  return {
    id: manager.getSessionId(), createdAt, updatedAt,
    ...(name ? { name } : {}),
    ...(preview ? { preview } : {}),
    ...(model ? { model } : {}),
    agent,
    ...(parent === undefined ? {} : { parent }),
  };
}
