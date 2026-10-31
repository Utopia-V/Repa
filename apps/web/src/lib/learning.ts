import { ConnectionError, RpcError } from "@repa/base/client";
import type { Method, Params, Problem, Result } from "@repa/base/protocol";
import {
  readLearningError,
  readLearningEvent,
  readLearningResult,
  type ContentPage,
  type ContentRef,
  type Delivery,
  type LearnerResponse,
  type LearningInput,
  type LearningMethod,
  type LearningResult,
  type LearningState,
} from "@repa/learning/protocol";

import { errorCode } from "@/lib/errors";

export const LEARNING_PLUGIN = "learning";
/** 学习插件的辅导 Agent；每个任务开一个它的会话，view 投影的就是这个任务。 */
export const TUTOR_AGENT = "learning-tutor";

/**
 * 已经点了提交、还没确认后端收下的作答，键是交付时预留的 submissionId。
 * sending：请求在路上；unknown：连接断了或超时，不知道收没收下，先查询再决定是否重交；
 * rejected：结构不合格，没有收下，改好可以再交；failed：其他失败，可以再交。
 */
export type Outgoing = {
  taskId: string;
  deliveryId: string;
  response: LearnerResponse;
  status: "sending" | "unknown" | "rejected" | "failed";
  problems?: Problem[] | undefined;
  error?: unknown;
};

/**
 * 学习页的状态。画面只按后端的 LearningState 显示，这里只多记两样前端自己的事：
 * 还没确认收下的作答，以及从菜单和内容搜索得来的 topic、KP 名称。
 */
export type LearningView = {
  /** 当前空间是否装了学习插件；还没查过时为 undefined。 */
  available?: boolean | undefined;
  status: "idle" | "loading" | "ready" | "error";
  state?: LearningState | undefined;
  /** 读到 state 时的本机时间，与 state.serverNow 一起把服务端时间换算成本机时间。 */
  readAt?: number | undefined;
  /** 读取状态失败的原因；已经有画面时仍显示旧画面。 */
  loadError?: unknown;
  /** 正在进行的任务操作，期间操作按钮不可用。 */
  busy?: "select" | "advance" | "resume" | "abort" | "retry" | undefined;
  /** 最近一次任务操作的失败，下一次操作开始时清除。 */
  actionError?: unknown;
  /** 操作时后端发现画面已经过时，换成了它给的当前状态；提示学习者看一眼再操作。 */
  replaced: boolean;
  outbox: Record<string, Outgoing>;
};

/** 打开空间后的首页：后端装了学习插件就进学习页，否则进对话页。 */
export function homePath(learning: LearningView): "/learn" | "/conversation" {
  return learning.available === true ? "/learn" : "/conversation";
}

export const emptyLearning: LearningView = { status: "idle", replaced: false, outbox: {} };

/** 学习插件方法错误的 details；不是学习插件的业务错误时为 undefined。 */
function learningDetails(error: unknown) {
  if (!(error instanceof RpcError)) return undefined;
  const data = error.data;
  if (data === null || typeof data !== "object" || !("details" in data)) return undefined;
  const read = readLearningError(data.details);
  return read.ok ? read.value : undefined;
}

/** 后端随 stale_state 交回的当前状态。 */
export function staleState(error: unknown): LearningState | undefined {
  if (errorCode(error) !== "stale_state") return undefined;
  const details = learningDetails(error);
  return details?.reason === "stale" ? details.state : undefined;
}

/** 新状态是否不比手里的旧：revision 更大，或者相同但读取得更晚（到期变化不写事实，revision 不变）。 */
function newer(next: LearningState, current: LearningState | undefined): boolean {
  if (!current) return true;
  return next.revision > current.revision || (next.revision === current.revision && next.serverNow >= current.serverNow);
}

type Call = <M extends Method>(method: M, params: Params<M>) => Promise<Result<M>>;
type Deps = {
  call: Call;
  get(): { learning: LearningView; connected: boolean };
  set(change: (learning: LearningView) => LearningView): void;
};

/** 学习页对后端的全部操作。状态都写进 learning，由页面读取；内容读取的结果只属于当次查看，直接返回。 */
export function createLearningActions({ call, get, set }: Deps) {
  async function learningCall<M extends LearningMethod>(method: M, input: LearningInput<M>): Promise<LearningResult<M>> {
    const raw = await call("plugin.call", { pluginId: LEARNING_PLUGIN, method, input });
    const read = readLearningResult(method, raw);
    if (!read.ok) throw new Error(`学习插件返回的内容这个版本读不懂（${method}${read.path}），请更新应用。`);
    return read.value;
  }

  function accept(state: LearningState): void {
    set((learning) => newer(state, learning.state) ? { ...learning, status: "ready", state, readAt: Date.now(), loadError: undefined } : learning);
  }

  function setOutbox(id: string, change: Outgoing | undefined): void {
    set((learning) => {
      const outbox = { ...learning.outbox };
      if (change) outbox[id] = change;
      else delete outbox[id];
      return { ...learning, outbox };
    });
  }

  async function refresh(): Promise<void> {
    if (!get().learning.available) return;
    set((learning) => ({ ...learning, status: learning.state ? learning.status : "loading" }));
    try {
      accept(await learningCall("state.get", {}));
    } catch (error) {
      set((learning) => ({ ...learning, status: learning.state ? "ready" : "error", loadError: error }));
    }
  }

  /** 任务操作共用的流程：画面过时就换成后端给的当前状态，其他失败留给页面显示。 */
  async function perform(busy: NonNullable<LearningView["busy"]>, run: () => Promise<LearningState>): Promise<void> {
    set((learning) => ({ ...learning, busy, actionError: undefined, replaced: false }));
    try {
      accept(await run());
    } catch (error) {
      const current = staleState(error);
      if (current) {
        accept(current);
        set((learning) => ({ ...learning, replaced: true }));
      } else {
        set((learning) => ({ ...learning, actionError: error }));
        // 连接断了或超时：操作可能已经执行，重新读取状态确认。
        if (error instanceof ConnectionError) void refresh();
      }
    } finally {
      set((learning) => ({ ...learning, busy: undefined }));
    }
  }

  /** 当前任务的守卫：阶段和 revision 都要对上，旧画面上的点击不会推进两次。 */
  function guard() {
    const state = get().learning.state;
    const task = state?.task;
    if (!state || !task) throw new Error("现在没有进行中的任务。");
    return { taskId: task.taskId, expectedStage: task.phase.stage, expectedRevision: state.revision };
  }

  /** confirm 为 false 时（确认过程中的重交）遇到连接问题只标为 unknown，不在这里再查一轮。 */
  async function submit(id: string, outgoing: Omit<Outgoing, "status">, confirm = true): Promise<void> {
    setOutbox(id, { ...outgoing, status: "sending" });
    try {
      const receipt = await learningCall("submission.submit", {
        taskId: outgoing.taskId,
        deliveryId: outgoing.deliveryId,
        submissionId: id,
        response: outgoing.response,
      });
      if (receipt.status === "rejected") {
        setOutbox(id, { ...outgoing, status: "rejected", problems: receipt.problems });
        return;
      }
      setOutbox(id, undefined);
      await refresh();
    } catch (error) {
      const current = staleState(error);
      if (current) {
        setOutbox(id, undefined);
        accept(current);
        set((learning) => ({ ...learning, replaced: true }));
      } else if (errorCode(error) === "submission_conflict") {
        // 这个编号已经收下了另一份作答，以后端记下的为准。
        setOutbox(id, undefined);
        await refresh();
      } else if (error instanceof ConnectionError) {
        setOutbox(id, { ...outgoing, status: "unknown" });
        if (confirm && get().connected) await settle();
      } else {
        setOutbox(id, { ...outgoing, status: "failed", error });
      }
    }
  }

  /**
   * 确认结果不明的作答：后端已经收下（found）就以它为准；absent 才用原答案和原编号再交一次。
   * 查询本身失败时保持 unknown，等下次连接再查。
   */
  async function settle(): Promise<void> {
    const waiting = Object.entries(get().learning.outbox).filter(([, item]) => item.status === "unknown");
    for (const [id, item] of waiting) {
      let found: boolean;
      try {
        found = (await learningCall("submission.get", { submissionId: id })).status === "found";
      } catch {
        // 仍然连不上或后端还没好；作答留在 unknown，重连后再查。
        continue;
      }
      if (found) setOutbox(id, undefined);
      else await submit(id, item, false);
    }
    await refresh();
  }

  /** 查学习插件在不在，在就读取状态，并确认结果不明的作答。 */
  async function load(): Promise<void> {
    set((learning) => ({ ...learning, status: learning.state ? learning.status : "loading" }));
    try {
      const plugins = await call("plugin.list", {});
      const available = plugins.some((plugin) => plugin.id === LEARNING_PLUGIN);
      set((learning) => ({ ...learning, available, status: available || learning.state ? learning.status : "idle" }));
    } catch (error) {
      set((learning) => ({ ...learning, status: learning.state ? learning.status : "error", loadError: error }));
      return;
    }
    if (Object.values(get().learning.outbox).some((item) => item.status === "unknown" || item.status === "sending")) {
      // 断线前还在路上的请求，结果同样不明。
      set((learning) => ({
        ...learning,
        outbox: Object.fromEntries(Object.entries(learning.outbox).map(([id, item]) => [id, item.status === "sending" ? { ...item, status: "unknown" as const } : item])),
      }));
      await settle();
    } else {
      await refresh();
    }
  }

  // 首页、学习页和重连可能同时要求读取，只保留一个进行中的读取。
  let loading: Promise<void> | undefined;

  return {
    /** 打开空间或重连后调用。 */
    loadLearning(): Promise<void> {
      loading ??= load().finally(() => { loading = undefined; });
      return loading;
    },
    refreshLearning: refresh,
    /** 收到 plugin.event 时调用；事件只说明状态变了，内容重新读取。 */
    learningEvent(pluginId: string, event: unknown): void {
      if (pluginId !== LEARNING_PLUGIN || !readLearningEvent(event).ok) return;
      void refresh();
    },
    /** 学习者选菜单里的一项；测验和重考也走 menu.select，后端按候选的类型开始。 */
    selectCandidate(candidateId: string): Promise<void> {
      const menu = get().learning.state?.menu;
      return perform("select", async () => {
        if (!menu) throw new Error("菜单已经变了，请重新选择。");
        return await learningCall("menu.select", { menuId: menu.menuId, candidateId });
      });
    },
    advanceTask(): Promise<void> {
      return perform("advance", async () => await learningCall("task.advance", guard()));
    },
    resumeTask(): Promise<void> {
      return perform("resume", async () => await learningCall("task.resume", guard()));
    },
    abortTask(): Promise<void> {
      return perform("abort", async () => await learningCall("task.abort", guard()));
    },
    /** 判分没有完成的作答再判一次；返回的是这份提交的回执，任务状态随后重新读取。 */
    retryJudging(submissionId: string): Promise<void> {
      return perform("retry", async () => {
        await learningCall("submission.resume", { submissionId });
        return await learningCall("state.get", {});
      });
    },
    /** 提交作答，沿用交付时预留的编号；重试也用同一个编号。 */
    submitAnswer(delivery: Delivery, taskId: string, response: LearnerResponse): Promise<void> {
      return submit(delivery.submissionId, { taskId, deliveryId: delivery.deliveryId, response });
    },
    searchContent(query: string): Promise<LearningResult<"content.search">> {
      return learningCall("content.search", { query, offset: 0, limit: 20 });
    },
    readContent(ref: ContentRef, offset = 0): Promise<ContentPage[]> {
      return learningCall("content.read", { refs: [ref], offset, limit: 64 });
    },
    /** 记一次打开；课内作答前打开概念卡算一次求助，由后端判断。 */
    async openContent(ref: ContentRef): Promise<void> {
      await learningCall("content.open", { ref });
    },
  };
}

export type LearningActions = ReturnType<typeof createLearningActions>;
