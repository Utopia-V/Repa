import { createStore } from "zustand/vanilla";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { ConnectionError, RpcError, type RepaClient } from "@repa/base/client";
import {
  canRender,
  type AskClosed,
  type AskRequest,
  type Block,
  type Confirmation,
  type ItemResponse,
  type Method,
  type ModelRef,
  type Params,
  type Problem,
  type PromptOverride,
  type Result,
  type SessionInfo,
} from "@repa/base/protocol";

import { interactionCapabilities } from "@/lib/ask";
import { applyEvent, emptyConversation, historyItems, type Conversation } from "@/lib/conversation";
import { errorCode } from "@/lib/errors";

/** 一份从后端读取的数据；重新读取期间保留上一次的 data，界面不回到空白。 */
export type Resource<T> = {
  status: "idle" | "loading" | "ready" | "error";
  data?: T | undefined;
  error?: unknown;
};

/** ask 时 Agent 的每条命令都要用户允许，fullAccess 时直接运行。 */
export type CommandPolicy = Result<"settings.get">["commandPolicy"];

type ResourceData = {
  /** 最近打开的空间，最新的在前。 */
  spaces: Result<"space.list">;
  /** 模型提供方及其登录方式、凭据状态。 */
  providers: Result<"model.providers">;
  /** Pi 目录里的全部模型，available 表示提供方已经配置凭据。 */
  models: Result<"model.list">;
  /** 新会话使用的模型；没有可用模型时为 null。 */
  defaultModel: Result<"model.getDefault">;
  /** 当前空间的会话，最近有消息的在前；换空间时清空。 */
  sessions: Result<"session.list">;
  /** Agent 执行命令前是否询问；应用级设置，对所有空间生效。设置里的其他字段由各自的入口读取。 */
  commandPolicy: CommandPolicy;
  /** 当前空间最近的文件修改记录；换空间时清空。 */
  history: SpaceHistory;
  /** 当前空间的提示各段；换空间时清空。 */
  prompts: PromptSettings;
};

type ResourceName = keyof ResourceData;

export type Resources = { [N in ResourceName]: Resource<ResourceData[N]> };

/**
 * 提示各段的有效内容，以及应用级覆盖。空间级覆盖存在空间目录里，协议读不到，
 * 由有效内容与应用级、默认内容比较推出。
 */
export type PromptSettings = {
  sections: Result<"prompt.list">;
  app: Result<"settings.get">["prompts"];
};

export type PromptScope = Params<"prompt.set">["scope"];

/** 空间历史里的一次提交及其改动的文件。 */
export type HistoryRevision = Result<"history.changes">["revisions"][number];

/** 一次读取最多查看的历史提交数；没有文件变化的 Agent 运行也各占一条。 */
export const HISTORY_LIMIT = 200;

export type SpaceHistory = {
  /** 最新的在前。 */
  revisions: HistoryRevision[];
  /** 已经读到建立历史时的初始状态，没有更早的记录。 */
  complete: boolean;
};

/** 等待用户回答的命令授权，按到达顺序处理。 */
export type PendingConfirmation = { id: string; request: Confirmation };

/**
 * 正在进行的模型登录。后端经 confirm.request 发来的输入、选择和链接都属于这次登录：
 * display 只是展示，收到就回复，界面一直保留到登录结束；input 和 select 排队等用户回答。
 */
export type LoginState = {
  provider: string;
  notices: Confirmation[];
  prompts: PendingConfirmation[];
  /** 用户已经取消，之后到达的请求直接回复取消。 */
  cancelled: boolean;
};

/**
 * 对话里 Agent 或插件发来的询问。结束后留在原处显示作答和后端附的说明，换会话或空间时清掉；
 * 重新读取会话后，ask_user 的提问按会话记录显示（见 restoredAsk），其他询问只剩工具调用那一行。
 */
export type Ask = {
  request: AskRequest;
  /** 结束原因；disconnected 表示连接断开，后端已经结束询问，不再通知；unsupported 只出现在会话记录里，界面没能显示这张卡片。 */
  closed?: AskClosed["reason"] | "disconnected" | "unsupported" | undefined;
  submitting: boolean;
  /** 上一次提交被退回的原因，改好可以再交。 */
  problems: Problem[];
  /** 已经记下的作答。 */
  response?: ItemResponse | undefined;
  /** 没有按卡片作答，在输入框里回的话。 */
  declined?: string | undefined;
  /** 后端接受作答时附的内容块，例如“已记下本周打卡”。 */
  message?: Block[] | undefined;
  /** 提交或关闭没有送达的错误。 */
  error?: unknown;
};

/** 侧栏偏好；宽度未拖动过时为空，由侧栏组件使用默认值。 */
export type SidebarPreference = { open: boolean; width?: number | undefined };

export type AppState = {
  /** 当前连接；重连后换成新实例，读取函数执行时才取用。 */
  client?: RepaClient;
  connected: boolean;
  /**
   * 本页面打开的空间，和当前会话一起保存在浏览器里。后端不提供查询当前空间的方法，
   * 连上后端（包括刷新、重启后第一次连接）时重新打开它。
   */
  space?: string | undefined;
  /** 重新打开上次的空间失败时记下原因，选空间页显示；之后成功打开空间时清除。 */
  resumeFailure?: { root: string; error: unknown } | undefined;
  resources: Resources;
  /** 当前空间里正在查看的会话。 */
  conversation: Conversation;
  confirmations: PendingConfirmation[];
  /** 当前会话里的询问，按到达顺序。 */
  asks: Ask[];
  /** 正在进行的模型登录。 */
  activeLogin?: LoginState | undefined;
  setClient(client: RepaClient): void;
  setConnected(connected: boolean): void;
  loadSpaces(): Promise<void>;
  /** 重新读取已经读过的数据，用于重连和窗口切回。 */
  reloadLoaded(): Promise<void>;
  /** 运行中只能回到当前空间：后端打开另一个空间前会关闭当前空间，中止正在进行的运行。 */
  openSpace(root: string): Promise<void>;
  /**
   * 运行中不关闭：后端关闭空间会中止正在进行的运行。失败时抛给调用方并保留空间；
   * 后端报错时已经放下了这个空间，再关一次就能完成。
   */
  closeSpace(): Promise<void>;
  /** 浏览结果只属于当次选择，不进入共享状态。 */
  browseFolder(path?: string): Promise<Result<"space.browse">>;
  listRoots(): Promise<Result<"space.roots">>;
  /**
   * 读取会话列表，打开上次查看的会话；它不在列表里时打开最近有消息的会话。
   * 空间里还没有会话时等第一次发送再建立。
   */
  loadConversation(): Promise<void>;
  loadSessions(): Promise<void>;
  loadHistory(): Promise<void>;
  loadPrompts(): Promise<void>;
  /** 写入一级覆盖；没有内容时清除这一级。失败抛给调用方，完成或失败后都重新读取。 */
  savePrompt(scope: PromptScope, id: string, override: PromptOverride): Promise<void>;
  /** 预览只属于当次查看，不进入共享状态。 */
  previewPrompts(): Promise<Result<"prompt.preview">>;
  /** 撤回一次提交改动的文件；冲突的文件保持现状，列在结果里。完成或失败后都重新读取历史。 */
  undoRevision(revision: string): Promise<Result<"history.undo">>;
  /** 运行中不切换：运行状态只属于当前会话，切走后无法再查询。 */
  openSession(session: SessionInfo): Promise<void>;
  newConversation(): void;
  /** 从当前会话的一条记录分叉出新会话并打开它；运行中不分叉，失败抛给调用页面。 */
  forkSession(entryId: string): Promise<void>;
  /** 已建立的会话调用 session.setModel；还没建立的记下来，建立时使用。 */
  setConversationModel(model: ModelRef): Promise<void>;
  /**
   * 空闲时开始一次运行；运行中用 `session.steer` 排队，Agent 做完当前这一步后读到。
   * 有询问等待作答时，这句话代替作答交回 Agent。
   * 返回 false 表示消息没有发出去，错误放在 `conversation.sendError`。
   */
  sendMessage(text: string): Promise<boolean>;
  /** 返回随取消被后端丢弃、没送到 Agent 的排队消息，由调用方放回输入框。 */
  stopRun(): Promise<string[]>;
  replyConfirmation(id: string, allowed: boolean): Promise<void>;
  /** 交卷；格式不对时询问保持打开，问题记在 problems。 */
  submitAsk(id: string, response: ItemResponse): Promise<void>;
  /** 不作答，直接关掉询问。 */
  cancelAsk(id: string): Promise<void>;
  /** 读取设置页需要的提供方、模型和默认模型。 */
  loadModelSettings(): Promise<void>;
  setDefaultModel(model: Params<"model.setDefault">["model"]): Promise<void>;
  /** 失败时抛给调用方；需要更多信息的提供方抛出 requires_interactive_login，调用方改走 login。 */
  saveKey(provider: string, key: string): Promise<void>;
  logout(provider: string): Promise<void>;
  loadCommandPolicy(): Promise<void>;
  /** 失败时抛给调用方，界面保留原来的策略。 */
  setCommandPolicy(policy: CommandPolicy): Promise<void>;
  /** 交互登录，等后端完成整个流程才返回；用户取消时同样以失败结束。 */
  login(provider: string, type: "api_key" | "oauth"): Promise<void>;
  answerLoginPrompt(id: string, value: string | null): Promise<void>;
  cancelLogin(): void;
  /** 保存在浏览器里，刷新后保留。 */
  sidebar: SidebarPreference;
  setSidebarOpen(open: boolean): void;
  setSidebarWidth(width: number): void;
};

/** 无痕模式、禁用存储或配额已满时只放弃保存，不打断界面操作。 */
const browserStorage: StateStorage = {
  getItem(name) {
    try { return localStorage.getItem(name); } catch { return null; }
  },
  setItem(name, value) {
    try { localStorage.setItem(name, value); } catch { /* 下次打开回到默认值 */ }
  },
  removeItem(name) {
    try { localStorage.removeItem(name); } catch { /* 同上 */ }
  },
};

/** 存储内容可能被旧版本或手动修改过，逐项检查，不合格的回到默认值。 */
function restoreSidebar(saved: unknown, fallback: SidebarPreference): SidebarPreference {
  const value = typeof saved === "object" && saved !== null ? saved as Record<string, unknown> : {};
  return {
    open: typeof value.open === "boolean" ? value.open : fallback.open,
    width: typeof value.width === "number" && Number.isFinite(value.width) ? value.width : fallback.width,
  };
}

export type AppStore = ReturnType<typeof createAppStore>;

export function createAppStore() {
  // 同一份数据只保留一个进行中的读取；序号用于丢弃先发后到的旧结果。
  const pending = new Map<ResourceName, Promise<void>>();
  const sequence = new Map<ResourceName, number>();

  return createStore<AppState>()(persist((set, get) => {
    // 重新打开空间期间，依赖空间的请求等它结束再发，否则后端可能还没打开空间。
    let resuming: Promise<void> | undefined;

    async function call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
      if (resuming && (method.startsWith("session.") || method.startsWith("history.") || method.startsWith("prompt."))) await resuming;
      const client = get().client;
      if (!client) throw new ConnectionError("尚未连接后端。");
      return await client.call(method, params);
    }

    function update<N extends ResourceName>(name: N, resource: Resource<ResourceData[N]>): void {
      set((state) => ({ resources: { ...state.resources, [name]: resource } }));
    }

    function load<N extends ResourceName>(name: N, read: () => Promise<ResourceData[N]>): Promise<void> {
      const running = pending.get(name);
      if (running) return running;
      const id = (sequence.get(name) ?? 0) + 1;
      sequence.set(name, id);
      update(name, { ...get().resources[name], status: "loading", error: undefined });
      const promise = read().then(
        (data) => {
          if (sequence.get(name) === id) update(name, { status: "ready", data });
        },
        (error: unknown) => {
          if (sequence.get(name) === id) update(name, { status: "error", data: get().resources[name].data, error });
        },
      ).finally(() => {
        if (pending.get(name) === promise) pending.delete(name);
      });
      pending.set(name, promise);
      return promise;
    }

    const loaders: { [N in ResourceName]: () => Promise<void> } = {
      spaces: () => load("spaces", () => call("space.list", {})),
      providers: () => load("providers", () => call("model.providers", {})),
      models: () => load("models", () => call("model.list", {})),
      defaultModel: () => load("defaultModel", () => call("model.getDefault", {})),
      // 子 Agent 的会话带 parent，用户不能直接对话，不列出也不自动打开。
      sessions: () => load("sessions", async () => (await call("session.list", {})).filter((session) => session.parent === undefined)),
      commandPolicy: () => load("commandPolicy", async () => (await call("settings.get", {})).commandPolicy),
      history: () => load("history", readHistory),
      prompts: () => load("prompts", async () => {
        const [sections, settings] = await Promise.all([call("prompt.list", {}), call("settings.get", {})]);
        return { sections, app: settings.prompts };
      }),
    };

    /** list 只给出最近的提交，没有文件；从其中最早一条的父提交开始取变化，就得到同一段带文件的记录。 */
    async function readHistory(): Promise<SpaceHistory> {
      const recent = await call("history.list", { limit: HISTORY_LIMIT });
      const parent = recent.at(-1)?.parent;
      const feed = await call("history.changes", parent ? { since: parent } : {});
      return { revisions: [...feed.revisions].reverse(), complete: recent.length < HISTORY_LIMIT };
    }

    /** 换空间后丢弃旧空间的会话列表和修改历史，进行中的读取结果也作废。 */
    function resetSpaceData(): void {
      for (const name of ["sessions", "history", "prompts"] as const) {
        pending.delete(name);
        sequence.set(name, (sequence.get(name) ?? 0) + 1);
        update(name, { status: "idle" });
      }
    }

    /** 发送后会话的排序、预览可能变了；没读过时不读。 */
    async function reloadSessions(): Promise<void> {
      if (get().resources.sessions.status === "idle") return;
      pending.delete("sessions");
      await loaders.sessions();
    }

    /** 改过提示或重新打开空间后重新读取；没读过时不读。 */
    async function reloadPrompts(): Promise<void> {
      if (get().resources.prompts.status === "idle") return;
      pending.delete("prompts");
      await loaders.prompts();
    }

    /** 撤回或重新打开空间后历史可能变了；没读过时不读。 */
    async function reloadSpaceHistory(): Promise<void> {
      if (get().resources.history.status === "idle") return;
      pending.delete("history");
      await loaders.history();
    }

    /** 凭据或默认模型变了之后，丢弃进行中的旧读取并重新读取；没读过的等页面需要时再读。 */
    async function reloadModelState(): Promise<void> {
      const names = (["providers", "models", "defaultModel"] as const).filter((name) => get().resources[name].status !== "idle");
      for (const name of names) pending.delete(name);
      await Promise.all(names.map((name) => loaders[name]()));
    }

    function reply(id: string, value: string | boolean | null): Promise<void> {
      return call("confirm.reply", { id, value }).then(() => undefined, () => {
        // 请求可能已随取消或断线失效，后端那一侧会按取消处理。
      });
    }

    function updateAsk(id: string, change: Partial<Ask>): void {
      set((state) => ({ asks: state.asks.map((ask) => ask.request.id === id ? { ...ask, ...change } : ask) }));
    }

    function updateConversation(change: Partial<Conversation>): void {
      set((state) => ({ conversation: { ...state.conversation, ...change } }));
    }

    // 会话读取共用一个序号：切换会话、换空间或再次读取后，先发出的读取结果作废。
    let conversationRequest = 0;
    // 排队消息在本页面内的编号。
    let queuedCount = 0;

    /** 运行结束后用会话记录替换实时拼出的内容。运行中不替换，等 runEnd 再读。 */
    async function reloadHistory(): Promise<void> {
      const sessionId = get().conversation.sessionId;
      if (!sessionId) return;
      const id = ++conversationRequest;
      try {
        const entries = await call("session.history", { sessionId });
        const current = get().conversation;
        if (id !== conversationRequest || current.sessionId !== sessionId || current.run !== "idle") return;
        updateConversation({ status: "ready", error: undefined, items: historyItems(entries), streaming: undefined });
      } catch (error) {
        // 已经显示的内容仍然可用，只在还没有内容时显示读取失败。
        if (id === conversationRequest && get().conversation.status !== "ready") updateConversation({ status: "error", error });
      }
    }

    /** 换连接后后端可能已经重启，重新打开原来的空间；打开同一个空间时后端直接返回。 */
    async function resumeSpace(): Promise<void> {
      const root = get().space;
      if (!root) return;
      const opening = call("space.open", { root }).then(() => true, (error: unknown) => {
        // 连接中断时保留空间，重连后再打开一次。
        if (!(error instanceof ConnectionError) && get().space === root) {
          conversationRequest++;
          resetSpaceData();
          set({ space: undefined, resumeFailure: { root, error }, conversation: emptyConversation, asks: [] });
        }
        return false;
      });
      const done = opening.then(() => undefined);
      resuming = done;
      const opened = await opening;
      if (resuming === done) resuming = undefined;
      if (!opened || get().space !== root) return;
      // 会话列表、修改历史和提示依赖打开的空间，不随 reloadLoaded 在打开前读取。
      // 正在读取的会话由那次读取完成，这里只重读已经显示过的。
      const { status } = get().conversation;
      await Promise.all([reloadSessions(), reloadSpaceHistory(), reloadPrompts(), status === "ready" || status === "error" ? reloadHistory() : undefined]);
    }

    let unsubscribe: (() => void) | undefined;
    let loginRequest = 0;

    function subscribe(client: RepaClient): void {
      unsubscribe?.();
      const offEvent = client.on("session.event", (event) => {
        const conversation = get().conversation;
        if (event.sessionId !== conversation.sessionId) return;
        set({ conversation: applyEvent(conversation, event) });
        if (event.type === "runEnd") void reloadHistory();
      });
      const offConfirm = client.on("confirm.request", ({ id, request }) => {
        if (request.kind === "command") {
          set((state) => ({ confirmations: [...state.confirmations, { id, request }] }));
          return;
        }
        const login = get().activeLogin;
        if (login && !login.cancelled) {
          if (request.kind === "display") {
            set({ activeLogin: { ...login, notices: [...login.notices, request] } });
            void reply(id, true);
          } else {
            set({ activeLogin: { ...login, prompts: [...login.prompts, { id, request }] } });
          }
          return;
        }
        // 输入和选择只来自本页面发起的登录；没有进行中的登录时直接取消，不让后端停在等待上。
        void reply(id, null);
      });
      const offAsk = client.on("ask.request", (request) => {
        // 后端已按声明的能力筛过；宽松读取后仍有不认识的必需特性时，告诉 Agent 这里显示不了。
        if (!canRender(interactionCapabilities, request.item)) {
          void call("ask.reply", { id: request.id, action: "unsupported" }).catch(() => undefined);
          return;
        }
        set((state) => ({ asks: [...state.asks, { request, submitting: false, problems: [] }] }));
      });
      const offAskClosed = client.on("ask.closed", ({ id, reason }) => {
        updateAsk(id, { closed: reason });
      });
      unsubscribe = () => {
        offEvent();
        offConfirm();
        offAsk();
        offAskClosed();
      };
    }

    /** 已写进会话记录的失败，记录读回后在对话里显示，不再单独提示。 */
    function recordedInSession(error: unknown): boolean {
      if (!(error instanceof RpcError)) return false;
      const code = error.data !== null && typeof error.data === "object" && "code" in error.data ? error.data.code : undefined;
      return code === "model_error" || code === "cancelled";
    }

    /**
     * 运行中发出的消息先显示为排队，送达事件到来时移出。Pi 正在运行时 `session.steer` 入队即返回；
     * 后端发现运行已经结束时改为直接开始下一轮，要等那一轮结束才返回，期间同样由事件显示。
     */
    async function steer(sessionId: string, text: string): Promise<boolean> {
      const id = `queued:${++queuedCount}`;
      set((state) => ({ conversation: { ...state.conversation, sendError: undefined, queued: [...state.conversation.queued, { id, text }] } }));
      try {
        await call("session.steer", { sessionId, text });
        return true;
      } catch (error) {
        // 只有直接开始的那一轮会遇到模型错误，它已写进会话记录。
        if (errorCode(error) === "model_error") return true;
        if (get().conversation.sessionId === sessionId) {
          set((state) => ({ conversation: { ...state.conversation, sendError: error, queued: state.conversation.queued.filter((message) => message.id !== id) } }));
        }
        return false;
      }
    }

    return {
      connected: false,
      resources: {
        spaces: { status: "idle" },
        providers: { status: "idle" },
        models: { status: "idle" },
        defaultModel: { status: "idle" },
        sessions: { status: "idle" },
        commandPolicy: { status: "idle" },
        history: { status: "idle" },
        prompts: { status: "idle" },
      },
      conversation: emptyConversation,
      confirmations: [],
      asks: [],
      setClient(client) {
        // 旧连接上的授权请求已被后端取消；运行状态在新连接上无法查询，从空闲开始，收到事件再更新。
        set((state) => ({
          client,
          connected: true,
          confirmations: [],
          // 断线时后端已经结束旧连接上的询问。
          asks: state.asks.map((ask) => ask.closed === undefined ? { ...ask, closed: "disconnected" as const, submitting: false } : ask),
          // 登录随旧连接断开而失败，未回答的请求一并作废；auth.login 的调用会以连接中断结束。
          activeLogin: state.activeLogin && { ...state.activeLogin, prompts: [] },
          // 排队消息是否送到同样无法查询，重读的会话记录里能看到已经送到的。
          conversation: { ...state.conversation, run: "idle", streaming: undefined, queued: [] },
        }));
        subscribe(client);
        // 旧连接上的读取不再等待；它们晚到的结果会被序号丢弃。
        pending.clear();
        void get().reloadLoaded();
        void resumeSpace();
      },
      setConnected(connected) {
        set({ connected });
      },
      loadSpaces: loaders.spaces,
      async reloadLoaded() {
        const { resources } = get();
        const names = (Object.keys(loaders) as ResourceName[]).filter((name) => name !== "sessions" && name !== "history" && name !== "prompts" && resources[name].status !== "idle");
        await Promise.all(names.map((name) => loaders[name]()));
      },
      async openSpace(root) {
        if (get().conversation.run !== "idle" && root !== get().space) return;
        const opened = await call("space.open", { root });
        // 换了空间时，上一个空间的会话不再适用。
        if (opened.root !== get().space) {
          conversationRequest++;
          resetSpaceData();
          set({ space: opened.root, conversation: emptyConversation, asks: [] });
        }
        set({ resumeFailure: undefined });
        // 打开前发出的读取可能不含这次打开，重新读取。
        pending.delete("spaces");
        await loaders.spaces();
      },
      async closeSpace() {
        if (!get().space || get().conversation.run !== "idle") return;
        await call("space.close", {});
        conversationRequest++;
        resetSpaceData();
        set({ space: undefined, conversation: emptyConversation, confirmations: [], asks: [] });
      },
      browseFolder(path) {
        return call("space.browse", path === undefined ? {} : { path });
      },
      listRoots() {
        return call("space.roots", {});
      },
      async loadConversation() {
        const id = ++conversationRequest;
        updateConversation({ status: "loading", error: undefined });
        try {
          // 等空间重新打开后再读，读取不会被打开后的重新读取作废。
          if (resuming) await resuming;
          pending.delete("sessions");
          await loaders.sessions();
          const { sessions } = get().resources;
          if (sessions.status === "error") throw sessions.error;
          const list = sessions.data ?? [];
          const previous = get().conversation.sessionId;
          const target = list.find((session) => session.id === previous) ?? list.reduce<SessionInfo | undefined>(
            (found, session) => !found || session.updatedAt > found.updatedAt ? session : found,
            undefined,
          );
          const entries = target ? await call("session.history", { sessionId: target.id }) : [];
          if (id !== conversationRequest) return;
          set({ conversation: { ...emptyConversation, status: "ready", sessionId: target?.id, model: target?.model, items: historyItems(entries) } });
        } catch (error) {
          if (id === conversationRequest) updateConversation({ status: "error", error });
        }
      },
      loadSessions: loaders.sessions,
      loadHistory: loaders.history,
      loadPrompts: loaders.prompts,
      async savePrompt(scope, id, override) {
        try {
          if (override.text === undefined && override.enabled === undefined) await call("prompt.reset", { scope, id });
          else await call("prompt.set", { scope, id, override });
        } finally {
          pending.delete("prompts");
          await loaders.prompts();
        }
      },
      previewPrompts() {
        return call("prompt.preview", {});
      },
      async undoRevision(revision) {
        try {
          return await call("history.undo", { revision });
        } finally {
          // 失败时也可能已经恢复了一部分文件并记成一次撤回。
          await reloadSpaceHistory();
        }
      },
      async openSession(session) {
        const current = get().conversation;
        if (current.run !== "idle" || (current.sessionId === session.id && current.status === "ready")) return;
        const id = ++conversationRequest;
        set({ confirmations: [], asks: [], conversation: { ...emptyConversation, status: "loading", sessionId: session.id, model: session.model } });
        try {
          const entries = await call("session.history", { sessionId: session.id });
          if (id === conversationRequest) updateConversation({ status: "ready", items: historyItems(entries) });
        } catch (error) {
          if (id === conversationRequest) updateConversation({ status: "error", error });
        }
      },
      newConversation() {
        if (get().conversation.run !== "idle") return;
        conversationRequest++;
        set({ conversation: { ...emptyConversation, status: "ready" }, asks: [] });
      },
      async forkSession(entryId) {
        const { sessionId, run } = get().conversation;
        if (!sessionId || run !== "idle") return;
        const forked = await call("session.fork", { sessionId, entryId });
        // 新会话要出现在侧栏列表里。
        await Promise.all([get().openSession(forked), reloadSessions()]);
      },
      async setConversationModel(model) {
        const { sessionId } = get().conversation;
        if (sessionId) {
          await call("session.setModel", { sessionId, model });
          await reloadSessions();
        }
        if (get().conversation.sessionId === sessionId) updateConversation({ model });
      },
      async sendMessage(text) {
        // 等着作答的询问挡住了 Agent，排队的消息要等它结束才读到；不按卡片作答，把这句话直接交回去。
        const waiting = get().asks.findLast((ask) => ask.closed === undefined);
        if (waiting) {
          const id = waiting.request.id;
          updateConversation({ sendError: undefined });
          try {
            await call("ask.reply", { id, action: "decline", message: text });
            updateAsk(id, { declined: text, closed: "answered", error: undefined });
            return true;
          } catch (error) {
            updateConversation({ sendError: error });
            return false;
          }
        }
        const conversation = get().conversation;
        if (conversation.run === "running" && conversation.sessionId) return await steer(conversation.sessionId, text);
        if (conversation.run !== "idle") return false;
        // 上一次运行里没对上的排队消息（例如插件的输入钩子改写了文字）不会再送达，不再显示。
        updateConversation({ run: "sending", sendError: undefined, queued: [] });
        let sessionId = conversation.sessionId;
        try {
          if (!sessionId) {
            const created = await call("session.create", conversation.model ? { model: conversation.model } : {});
            sessionId = created.id;
            updateConversation({ sessionId, model: created.model });
          }
          // 后端等整次运行结束才返回，期间的内容由 session.event 送来。
          await call("session.send", { sessionId, text });
          return true;
        } catch (error) {
          if (recordedInSession(error)) return true;
          if (get().conversation.sessionId === sessionId) updateConversation({ sendError: error });
          return false;
        } finally {
          // 运行没有开始就失败时不会收到 runEnd；后端取消运行时也不会撤回发出的授权请求。
          set({ confirmations: [] });
          if (get().conversation.sessionId === sessionId) {
            updateConversation({ run: "idle", streaming: undefined });
            await Promise.all([reloadHistory(), reloadSessions()]);
          } else {
            await reloadSessions();
          }
        }
      },
      async stopRun() {
        const { sessionId, run } = get().conversation;
        if (!sessionId || (run !== "running" && run !== "sending")) return [];
        updateConversation({ run: "stopping" });
        try {
          await call("session.abort", { sessionId });
          // 取消完成时后端已清空队列；在这之前送到的消息已随事件移出 queued，剩下的都没有送到。
          if (get().conversation.sessionId !== sessionId) return [];
          const unsent = get().conversation.queued.map((message) => message.text);
          updateConversation({ queued: [] });
          return unsent;
        } catch (error) {
          updateConversation({ sendError: error });
          return [];
        } finally {
          if (get().conversation.sessionId === sessionId && get().conversation.run === "stopping") updateConversation({ run: "idle" });
        }
      },
      async replyConfirmation(id, allowed) {
        set((state) => ({ confirmations: state.confirmations.filter((item) => item.id !== id) }));
        try {
          await call("confirm.reply", { id, value: allowed });
        } catch {
          // 请求可能已随取消或断线失效；后端那一侧会按拒绝处理，界面不需要再提示。
        }
      },
      async submitAsk(id, response) {
        updateAsk(id, { submitting: true, problems: [], error: undefined });
        try {
          const result = await call("ask.reply", { id, action: "submit", response });
          if (result?.status === "invalid") updateAsk(id, { problems: result.problems });
          // ask.closed 在结果之前到达；没收到时也按已作答收起。
          else updateAsk(id, { response, message: result?.message, closed: get().asks.find((ask) => ask.request.id === id)?.closed ?? "answered" });
        } catch (error) {
          updateAsk(id, { error });
        } finally {
          updateAsk(id, { submitting: false });
        }
      },
      async cancelAsk(id) {
        updateAsk(id, { error: undefined });
        try {
          await call("ask.reply", { id, action: "cancel" });
          updateAsk(id, { closed: "cancelled" });
        } catch (error) {
          updateAsk(id, { error });
        }
      },
      async loadModelSettings() {
        await Promise.all([loaders.providers(), loaders.models(), loaders.defaultModel()]);
      },
      async setDefaultModel(model) {
        await call("model.setDefault", { model });
        pending.delete("defaultModel");
        await loaders.defaultModel();
      },
      async saveKey(provider, key) {
        await call("auth.setKey", { provider, key });
        await reloadModelState();
      },
      async logout(provider) {
        await call("auth.logout", { provider });
        await reloadModelState();
      },
      loadCommandPolicy: loaders.commandPolicy,
      async setCommandPolicy(policy) {
        const settings = await call("settings.set", { commandPolicy: policy });
        // settings.set 返回保存后的设置；进行中的旧读取作废，直接用这份结果。
        pending.delete("commandPolicy");
        sequence.set("commandPolicy", (sequence.get("commandPolicy") ?? 0) + 1);
        update("commandPolicy", { status: "ready", data: settings.commandPolicy });
      },
      async login(provider, type) {
        const id = ++loginRequest;
        set({ activeLogin: { provider, notices: [], prompts: [], cancelled: false } });
        try {
          await call("auth.login", { provider, type });
        } finally {
          // 取消后浏览器回调可能很晚才结束旧登录，不能清掉之后新发起的那一次。
          if (id === loginRequest) set({ activeLogin: undefined });
          await reloadModelState();
        }
      },
      async answerLoginPrompt(id, value) {
        const login = get().activeLogin;
        if (login) set({ activeLogin: { ...login, prompts: login.prompts.filter((item) => item.id !== id) } });
        await reply(id, value);
      },
      cancelLogin() {
        const login = get().activeLogin;
        if (!login) return;
        set({ activeLogin: { ...login, prompts: [], cancelled: true } });
        // 回答取消后 Pi 结束登录；只在浏览器里等待回调的步骤没有可回答的请求，要等后端自己结束。
        for (const prompt of login.prompts) void reply(prompt.id, null);
      },
      sidebar: { open: true },
      setSidebarOpen(open) {
        set((state) => ({ sidebar: { ...state.sidebar, open } }));
      },
      setSidebarWidth(width) {
        set((state) => ({ sidebar: { ...state.sidebar, width } }));
      },
    };
  }, {
    name: "repa.web.preferences",
    storage: createJSONStorage(() => browserStorage),
    partialize: (state) => ({ sidebar: state.sidebar, space: state.space, sessionId: state.conversation.sessionId }),
    merge: (saved, current) => {
      const value = (typeof saved === "object" && saved !== null ? saved : {}) as Record<string, unknown>;
      const space = typeof value.space === "string" && value.space ? value.space : undefined;
      const sessionId = space && typeof value.sessionId === "string" && value.sessionId ? value.sessionId : undefined;
      return {
        ...current,
        sidebar: restoreSidebar(value.sidebar, current.sidebar),
        space,
        // 会话内容在空间重新打开后由对话页读取。
        conversation: { ...current.conversation, sessionId },
      };
    },
  }));
}
