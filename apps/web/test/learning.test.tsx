import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { ConnectionError, RpcError } from "@repa/base/client";
import type { Item, SessionEntry, SessionInfo } from "@repa/base/protocol";
import type { Delivery, LearningState, LearningTask, Submission } from "@repa/learning/protocol";

import { StoreProvider } from "../src/hooks/use-app-store";
import { TrialRunnerProvider, type TrialRunner } from "../src/hooks/use-trial-runner";
import { createAppStore } from "../src/lib/store";
import { routes } from "../src/routes";
import { t } from "../src/lib/strings";
import { fakeClient } from "./fake-client";
import { mockMatchMedia } from "./match-media";

afterEach(() => { cleanup(); localStorage.clear(); });

const version = `sha256:${"1".repeat(64)}`;
const ref = (id: string, kind: "lesson" | "example" | "card" | "kp", kpId = "py01.k1") => ({ course: "c1", courseId: "python", topicId: "py01", kpId, id, version, kind });
const progress = { day: "2026-10-31", timeZone: "Pacific/Auckland", dailyGoalXp: 20, todayXp: 0, totalXp: 0, completedTopics: 0, totalTopics: 48, completionRate: 0, etaDate: null };
const open = { kind: "none" as const, tutorAllowed: true, referenceContentAllowed: true };

const item: Item = {
  id: "o1", version, requires: ["block.markdown", "slot.text"],
  body: [{ type: "markdown", text: "`n = 4` 以后 `print(n)` 显示什么？" }],
  slots: [{ id: "output", type: "text", prompt: [{ type: "markdown", text: "显示的整数" }] }],
};
const delivery: Delivery = { deliveryId: "d3", submissionId: "s3", item, topicId: "py01", kpId: "py01.k1", mode: "practice", repeated: false, requiresServices: [] };

function task(phase: LearningTask["phase"], extra: Partial<LearningTask> = {}): LearningTask {
  return {
    taskId: "t1", kind: "lesson", course: "c1", topics: [{ id: "py01", title: "数字、文字和缺省值不是一回事" }], phase, startedAt: 1, deadlineAt: null,
    kps: [{ kpId: "py01.k1", title: "int、float、str 的行为差别", attempts: 0, consecutiveCorrect: 0, completed: false }],
    deliveries: [], submissions: [], ...extra,
  };
}

function state(revision: number, current: LearningTask | null): LearningState {
  return { revision, serverNow: 1_000 + revision, started: true, course: { id: "python", title: "Python：读懂代码，说清需求", version: "0.2.0" }, courses: [], task: current, menu: null, restrictions: open, progress };
}

const explanation = task({
  stage: "explanation",
  page: {
    ref: ref("py01.k1.explanation", "lesson"), origin: { taskId: "t1", content: ref("py01.k1.explanation", "lesson") },
    offset: 0, total: 1,
    blocks: [{ type: "markdown", text: "读到一行[赋值](repa:concept/py01.k1)，先算右边。" }],
  },
});
const answering = task({ stage: "awaiting_answer", deliveryId: "d3" }, { deliveries: [delivery] });

type Learning = (method: string, input: Record<string, unknown>) => Promise<unknown>;

type Base = (params: Record<string, unknown>) => Promise<unknown>;

/** 只模拟学习页用到的底座方法；学习插件的方法交给每个测试的 learning，base 替换个别底座方法。 */
function backend(learning: Learning, base: Record<string, Base> = {}) {
  const call = vi.fn((method: string, params: Record<string, unknown>): Promise<unknown> => {
    const replaced = base[method];
    if (replaced) return replaced(params);
    switch (method) {
      case "space.open":
        return Promise.resolve({ root: "/notes/python", opening: "opening-1", plugins: [] });
      case "space.list":
      case "session.list":
      case "model.list":
      case "model.providers":
        return Promise.resolve([]);
      case "model.getDefault":
        return Promise.resolve(null);
      case "plugin.list":
        return Promise.resolve([{ id: "learning", source: "bundled", state: "running", pages: [], methods: [], tools: [] }]);
      case "plugin.call":
        return learning(params.method as string, params.input as Record<string, unknown>);
      default:
        return Promise.reject(new Error(`未模拟的方法 ${method}`));
    }
  });
  return { call, ...fakeClient(call) };
}

function learningCalls(call: ReturnType<typeof backend>["call"]) {
  return call.mock.calls.filter(([method]) => method === "plugin.call").map(([, params]) => params as { method: string; input: unknown; opening: string });
}

function start(client: ReturnType<typeof backend>["client"], wide = false, runner?: TrialRunner) {
  mockMatchMedia(wide);
  localStorage.setItem("repa.web.preferences", JSON.stringify({ state: { space: "/notes/python" }, version: 0 }));
  const store = createAppStore();
  store.getState().setClient(client);
  const router = createMemoryRouter(routes, { initialEntries: ["/learn"] });
  const page = <RouterProvider router={router} />;
  render(<StoreProvider store={store}>{runner ? <TrialRunnerProvider runner={runner}>{page}</TrialRunnerProvider> : page}</StoreProvider>);
  return store;
}

it("讲解阶段显示课程内容和任务自带的标题，点“看例题”带着阶段和 revision 推进", async () => {
  const learning = vi.fn<Learning>((method) => {
    if (method === "state.get") return Promise.resolve(state(1, explanation));
    if (method === "task.advance") return Promise.resolve(state(2, answering));
    return Promise.reject(new Error(method));
  });
  const fake = backend(learning);
  start(fake.client);

  expect(await screen.findByText("先算右边。", { exact: false })).toBeTruthy();
  // 标题直接取自任务：课内作答之前搜索内容会记一次求助，复习和测验期间也不能搜索。
  expect(screen.getByRole("heading", { name: "数字、文字和缺省值不是一回事" })).toBeTruthy();
  expect(screen.getByText("int、float、str 的行为差别")).toBeTruthy();
  expect(learningCalls(fake.call).some((call) => call.method === "content.search")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "看例题" }));

  expect(await screen.findByText("显示的整数")).toBeTruthy();
  expect(learningCalls(fake.call).find((call) => call.method === "task.advance")?.input).toEqual({ taskId: "t1", expectedStage: "explanation", expectedRevision: 1 });
  expect(learningCalls(fake.call).find((call) => call.method === "task.advance")?.opening).toBe("opening-1");
});

it("操作时画面已经过时，换成后端给的当前状态并提示，不再执行原操作", async () => {
  const learning = vi.fn<Learning>((method) => {
    if (method === "state.get") return Promise.resolve(state(1, explanation));
    if (method === "task.advance") return Promise.reject(new RpcError(-32000, "任务状态已改变", { code: "stale_state", details: { reason: "stale", state: state(3, answering) } }));
    return Promise.reject(new Error(method));
  });
  start(backend(learning).client);

  fireEvent.click(await screen.findByRole("button", { name: "看例题" }));

  expect(await screen.findByText("画面已经更新")).toBeTruthy();
  expect(screen.getByText("显示的整数")).toBeTruthy();
});

it("断线时提交的作答，重连后先查询；后端没收到才用原编号和原答案补交", async () => {
  let submits = 0;
  const learning = vi.fn<Learning>((method) => {
    if (method === "state.get") return Promise.resolve(state(2, answering));
    if (method === "submission.submit") {
      submits++;
      if (submits === 1) return Promise.reject(new ConnectionError());
      return Promise.resolve({ status: "recorded", submission: { taskId: "t1", deliveryId: "d3", submissionId: "s3", response: { item: { id: "o1", version }, answers: {} }, acceptedAt: 5, processing: { status: "completed" }, gradeRevision: 1 } });
    }
    if (method === "submission.get") return Promise.resolve({ status: "absent", submissionId: "s3", revision: 2 });
    return Promise.reject(new Error(method));
  });
  const fake = backend(learning);
  const store = start(fake.client);

  fireEvent.change(await screen.findByRole("textbox", { name: "显示的整数" }), { target: { value: "4" } });
  // 提交时连接已经断了：结果不明，不能再改答案。
  act(() => store.getState().setConnected(false));
  fireEvent.click(screen.getByRole("button", { name: "提交" }));
  expect(await screen.findByText("连接断了，正在确认这份作答有没有交上，确认后会自动处理。")).toBeTruthy();
  expect(screen.getByRole("button", { name: "提交" }).hasAttribute("disabled")).toBe(true);

  act(() => store.getState().setClient(fake.client));
  await vi.waitFor(() => expect(submits).toBe(2));

  const calls = learningCalls(fake.call).filter((call) => call.method.startsWith("submission."));
  expect(calls.map((call) => call.method)).toEqual(["submission.submit", "submission.get", "submission.submit"]);
  expect(calls[2]?.input).toEqual(calls[0]?.input);
  expect(calls[2]?.input).toEqual({ taskId: "t1", deliveryId: "d3", submissionId: "s3", response: { item: { id: "o1", version }, answers: { output: { type: "text", text: "4" } } } });
  await vi.waitFor(() => expect(store.getState().learning.outbox).toEqual({}));
});

it("重连后查到后端已经收下这份作答，就不再重交", async () => {
  const learning = vi.fn<Learning>((method) => {
    if (method === "state.get") return Promise.resolve(state(2, answering));
    if (method === "submission.submit") return Promise.reject(new ConnectionError());
    if (method === "submission.get") return Promise.resolve({ status: "found", revision: 3, submission: { taskId: "t1", deliveryId: "d3", submissionId: "s3", response: { item: { id: "o1", version }, answers: {} }, acceptedAt: 5, processing: { status: "pending" }, gradeRevision: 0 } });
    return Promise.reject(new Error(method));
  });
  const fake = backend(learning);
  const store = start(fake.client);

  const dontKnow = await screen.findByRole("button", { name: "不会" });
  act(() => store.getState().setConnected(false));
  fireEvent.click(dontKnow);
  await vi.waitFor(() => expect(store.getState().learning.outbox.s3?.status).toBe("unknown"));
  act(() => store.getState().setClient(fake.client));

  await vi.waitFor(() => expect(store.getState().learning.outbox).toEqual({}));
  expect(learningCalls(fake.call).filter((call) => call.method === "submission.submit")).toHaveLength(1);
});

it("讲解里的概念链接打开概念卡：先记一次打开，再读卡片内容", async () => {
  const card = ref("py01.k1.card", "card");
  const learning = vi.fn<Learning>((method, input) => {
    if (method === "state.get") return Promise.resolve(state(1, explanation));
    if (method === "content.search") {
      if (input.query !== "py01.k1") return Promise.resolve({ hits: [], nextOffset: null });
      return Promise.resolve({
        hits: [
          { ref: ref("py01.k1", "kp"), title: "名字指向当前的值", snippet: "", origin: { taskId: "t1", content: ref("py01.k1", "kp") } },
          { ref: card, title: "赋值 / 变量", snippet: "", origin: { taskId: "t1", content: ref("py01.k1.example", "example") } },
        ],
        nextOffset: null,
      });
    }
    if (method === "content.open") return Promise.resolve({ openedAt: 9 });
    if (method === "content.read") {
      return Promise.resolve([{ ref: card, origin: { taskId: "t1", content: ref("py01.k1.example", "example") }, offset: 0, total: 1, blocks: [{ type: "markdown", text: "`=` 先算右边。" }] }]);
    }
    return Promise.reject(new Error(method));
  });
  const fake = backend(learning);
  start(fake.client);

  fireEvent.click(await screen.findByRole("button", { name: "赋值" }));

  const dialog = await screen.findByRole("dialog", { name: "赋值 / 变量" });
  expect(await within(dialog).findByText("先算右边。", { exact: false })).toBeTruthy();
  const order = learningCalls(fake.call).map((call) => call.method).filter((method) => method === "content.open" || method === "content.read");
  expect(order).toEqual(["content.open", "content.read"]);
  expect(learningCalls(fake.call).find((call) => call.method === "content.open")?.input).toEqual({ ref: card });
});

it("剩下的题都要模型判分而没有可用模型时，说明任务会保留，并引导去设置模型", async () => {
  const learning = vi.fn<Learning>((method) => {
    if (method === "state.get") return Promise.resolve(state(1, explanation));
    if (method === "task.advance") return Promise.reject(new RpcError(-32000, "没有可用的模型", { code: "model_required" }));
    return Promise.reject(new Error(method));
  });
  start(backend(learning).client);

  fireEvent.click(await screen.findByRole("button", { name: "看例题" }));

  expect(await screen.findByText("还没有可用的模型")).toBeTruthy();
  expect(screen.getByRole("link", { name: "去设置模型" }).getAttribute("href")).toBe("/settings");
});

it("判分的模型请求失败时按原因说明；key 无效时引导去设置模型，认不出原因时照旧只说没判出结果", async () => {
  const recovering = (failure?: "balance" | "auth") => task({ stage: "recovery", submissionId: "s3" }, {
    deliveries: [delivery],
    submissions: [{
      taskId: "t1", deliveryId: "d3", submissionId: "s3", acceptedAt: 1, gradeRevision: 0,
      response: { item: { id: "o1", version }, answers: { output: { type: "text", text: "4" } } },
      processing: { status: "interrupted", reason: "service_failure", ...(failure === undefined ? {} : { failure }) },
    }],
  });
  let current = recovering("balance");
  const learning = vi.fn<Learning>((method) => {
    if (method === "state.get") return Promise.resolve(state(1, current));
    return Promise.reject(new Error(method));
  });
  start(backend(learning).client);
  expect(await screen.findByText(t("learn.stage.ungraded.balance.description"))).toBeTruthy();
  expect(screen.queryByRole("link", { name: "去设置模型" })).toBeNull();
  cleanup();

  current = recovering("auth");
  start(backend(learning).client);
  expect(await screen.findByText(t("learn.stage.ungraded.auth.description"))).toBeTruthy();
  expect(screen.getByRole("link", { name: "去设置模型" }).getAttribute("href")).toBe("/settings");
  cleanup();

  current = recovering();
  start(backend(learning).client);
  // 认不出原因时用通用的那一句；它的文字由维护前端的人定，这里按键取。
  expect(await screen.findByText(t("learn.stage.ungraded.description"))).toBeTruthy();
});

it("辅导接着这个空间最近的一段辅导会话；开始新对话后，第一条消息建立新的辅导会话", async () => {
  const at = "2026-10-31T00:00:00.000Z";
  // 会话列表按最后消息时间倒序：最近的是通用对话，其次才是辅导。
  const sessions: SessionInfo[] = [
    { id: "g1", createdAt: at, updatedAt: at, agent: "general" },
    { id: "tutor2", createdAt: at, updatedAt: at, agent: "learning-tutor" },
    { id: "tutor1", createdAt: at, updatedAt: at, agent: "learning-tutor" },
  ];
  const history: SessionEntry[] = [
    { id: "u1", type: "user", timestamp: at, text: "赋值是什么意思" },
    { id: "a1", type: "assistant", timestamp: at, text: "把右边算出的值交给左边的名字。", data: { stopReason: "stop" } },
  ];
  const learning = vi.fn<Learning>((method) => {
    if (method === "state.get") return Promise.resolve(state(1, answering));
    return Promise.reject(new Error(method));
  });
  const fake = backend(learning, {
    "session.list": () => Promise.resolve(sessions),
    "session.history": (params) => Promise.resolve(params.sessionId === "tutor2" ? history : []),
    "model.getDefault": () => Promise.resolve({ provider: "test", id: "m" }),
    "session.create": () => Promise.resolve({ id: "tutor3", createdAt: at, updatedAt: at, agent: "learning-tutor" }),
    "session.send": () => Promise.resolve(null),
  });
  start(fake.client, true);
  const tutor = await screen.findByRole("region", { name: "提问" });

  expect(await within(tutor).findByText("把右边算出的值交给左边的名字。")).toBeTruthy();
  expect(fake.call.mock.calls.filter(([method]) => method === "session.history").map(([, params]) => params)).toEqual([{ sessionId: "tutor2" }]);

  fireEvent.click(within(tutor).getByRole("button", { name: "新对话" }));
  expect(within(tutor).queryByText("把右边算出的值交给左边的名字。")).toBeNull();
  fireEvent.change(within(tutor).getByRole("textbox", { name: "消息" }), { target: { value: "for 循环怎么停下来" } });
  fireEvent.click(within(tutor).getByRole("button", { name: "发送" }));

  await vi.waitFor(() => expect(fake.call.mock.calls.find(([method]) => method === "session.send")?.[1]).toEqual({ sessionId: "tutor3", text: "for 循环怎么停下来" }));
  expect(fake.call.mock.calls.find(([method]) => method === "session.create")?.[1]).toEqual({ agent: "learning-tutor" });
});

it("代码题点“运行”：后端拼好不带答案的一批，交给试运行的运行器，显示输出和出错的行；结果不交回后端", async () => {
  const code: Item = {
    id: "c1", version, requires: ["slot.code"],
    body: [{ type: "markdown", text: "打印 `df` 里及格的人数。" }],
    slots: [{ id: "code", type: "code", language: "python", starter: "print(len(df))\n" }],
  };
  const coding: Delivery = { ...delivery, deliveryId: "d4", submissionId: "s4", item: code, requiresServices: ["python.run"] };
  const batch = {
    protocol: "repa-python-batch-v4" as const,
    tests: [{ id: "trial", program: "print(len(df))\nprint(x)\n", prelude: "", setup: "", data: [], captures: [], doctest: [] }],
  };
  const learning = vi.fn<Learning>((method) => {
    if (method === "state.get") return Promise.resolve(state(1, task({ stage: "awaiting_answer", deliveryId: "d4" }, { deliveries: [coding] })));
    if (method === "run.prepare") return Promise.resolve(batch);
    return Promise.reject(new Error(method));
  });
  const runner = { run: vi.fn<TrialRunner["run"]>(() => Promise.resolve({
    protocol: "repa-python-batch-v4",
    runtime: { pyodide: "0.29.0", python: "3.13.2", packages: {} },
    loaded: [],
    tests: [{ id: "trial", status: "completed", result: { stdout: "3\n", error: { type: "NameError", message: "name 'x' is not defined", line: 2 }, captures: {}, doctest: [] } }],
  })) };
  const fake = backend(learning);
  start(fake.client, false, runner);

  const editor = await screen.findByRole("textbox");
  fireEvent.change(editor, { target: { value: "print(len(df))\nprint(x)\n" } });
  fireEvent.click(screen.getByRole("button", { name: "运行" }));

  expect((await screen.findByLabelText("运行输出")).textContent).toBe("3\n");
  expect(screen.getByText("第 2 行出错：", { exact: false })).toBeTruthy();
  expect(learningCalls(fake.call).find((call) => call.method === "run.prepare")?.input).toEqual({ deliveryId: "d4", slotId: "code", code: "print(len(df))\nprint(x)\n" });
  expect(runner.run).toHaveBeenCalledWith(batch, expect.any(AbortSignal));
  // 做课的状态与设置随学习状态一起读，与试运行无关。
  expect(learningCalls(fake.call).map((call) => call.method).filter((method) => !["building.get", "settings.get", "courses.list"].includes(method))).toEqual(["state.get", "run.prepare"]);
});

it("插件列表变了，学习插件不再运行时学习页标为不可用；它回来以后重新读取学习状态", async () => {
  const learning = vi.fn<Learning>((method) => {
    if (method === "state.get") return Promise.resolve(state(1, explanation));
    return Promise.reject(new Error(method));
  });
  const fake = backend(learning);
  const store = start(fake.client);
  expect(await screen.findByText("先算右边。", { exact: false })).toBeTruthy();
  const reads = () => learningCalls(fake.call).filter((call) => call.method === "state.get").length;
  const before = reads();

  const item = { id: "learning", source: "space" as const, pages: [], methods: [], tools: [] };
  act(() => fake.emit("plugin.updated", { plugins: [{ ...item, state: "failed", reason: { code: "plugin_open_failed", message: "打不开" } }] }));
  expect(store.getState().learning.available).toBe(false);
  act(() => fake.emit("plugin.updated", { plugins: [{ ...item, state: "running" }] }));
  expect(store.getState().learning.available).toBe(true);
  await vi.waitFor(() => { expect(reads()).toBeGreaterThan(before); });
});

const kindText = (kind: LearningTask["kind"]) => ({ lesson: "新课", review: "复习", quiz: "测验", retake: "重考" })[kind];
const quizDelivery = (index: number): Delivery => ({ ...delivery, deliveryId: `d${index}`, submissionId: `s${index}`, mode: "quiz" });
function quizTask(phase: LearningTask["phase"], kind: "quiz" | "retake" = "quiz"): LearningTask {
  return task(phase, { kind, deadlineAt: 900_000, kps: [], deliveries: [quizDelivery(1), quizDelivery(2), quizDelivery(3)] });
}
const quizAnswering = quizTask({ stage: "awaiting_answer", deliveryId: "d1" });

it("测验交卷：带着任务守卫调用 quiz.finish，换上后端交回的结束状态", async () => {
  const learning = vi.fn<Learning>((method) => {
    if (method === "state.get") return Promise.resolve(state(4, quizAnswering));
    if (method === "quiz.finish") return Promise.resolve(state(5, quizTask({ stage: "completed", outcome: "failed" })));
    return Promise.reject(new Error(method));
  });
  const fake = backend(learning);
  const store = start(fake.client);
  await screen.findByRole("button", { name: "提交" });

  await act(() => store.getState().finishQuiz());

  expect(learningCalls(fake.call).filter((call) => call.method === "quiz.finish").map((call) => call.input)).toEqual([{ taskId: "t1", expectedStage: "awaiting_answer", expectedRevision: 4 }]);
  expect(store.getState().learning.state?.task?.phase).toEqual({ stage: "completed", outcome: "failed" });
  expect(store.getState().learning.replaced).toBe(false);
  expect(screen.getByText("测验结束")).toBeTruthy();
});

it("交卷时测验已经按截止时间结束（stale_state）：换成后端交回的状态，提示画面已经更新", async () => {
  const learning = vi.fn<Learning>((method) => {
    if (method === "state.get") return Promise.resolve(state(4, quizAnswering));
    if (method === "quiz.finish") return Promise.reject(new RpcError(-32000, "测验仍在准备或状态已改变，请刷新后交卷", { code: "stale_state", details: { reason: "stale", state: state(6, quizTask({ stage: "completed", outcome: "timeout" })) } }));
    return Promise.reject(new Error(method));
  });
  const store = start(backend(learning).client);
  await screen.findByRole("button", { name: "提交" });

  await act(() => store.getState().finishQuiz());

  expect(store.getState().learning.state?.revision).toBe(6);
  expect(store.getState().learning.replaced).toBe("stale");
  expect(store.getState().learning.actionError).toBeUndefined();
  expect(screen.getByText(t("learn.result.timeout.status"))).toBeTruthy();
});

it("重复交卷：后端返回已有的结束状态，前端照常换上，不报错", async () => {
  const ended = quizTask({ stage: "completed", outcome: "failed" });
  const learning = vi.fn<Learning>((method) => {
    if (method === "state.get") return Promise.resolve(state(4, quizAnswering));
    // 已经结束的场次再交，后端不写新事实，返回同一个终态。
    if (method === "quiz.finish") return Promise.resolve(state(5, ended));
    return Promise.reject(new Error(method));
  });
  const fake = backend(learning);
  const store = start(fake.client);
  await screen.findByRole("button", { name: "提交" });

  await act(() => store.getState().finishQuiz());
  await act(() => store.getState().finishQuiz());

  const finishes = learningCalls(fake.call).filter((call) => call.method === "quiz.finish").map((call) => call.input);
  expect(finishes).toEqual([
    { taskId: "t1", expectedStage: "awaiting_answer", expectedRevision: 4 },
    { taskId: "t1", expectedStage: "completed", expectedRevision: 5 },
  ]);
  expect(store.getState().learning.state?.task).toEqual(ended);
  expect(store.getState().learning.actionError).toBeUndefined();
  expect(store.getState().learning.replaced).toBe(false);
});

it("交卷时连接断了：不知道交没交上，重新读取状态，以后端为准", async () => {
  let finished = false;
  const learning = vi.fn<Learning>((method) => {
    if (method === "state.get") return Promise.resolve(finished ? state(5, quizTask({ stage: "completed", outcome: "failed" })) : state(4, quizAnswering));
    if (method === "quiz.finish") {
      finished = true;
      return Promise.reject(new ConnectionError());
    }
    return Promise.reject(new Error(method));
  });
  const store = start(backend(learning).client);
  await screen.findByRole("button", { name: "提交" });

  await act(() => store.getState().finishQuiz());

  await vi.waitFor(() => expect(store.getState().learning.state?.task?.phase).toEqual({ stage: "completed", outcome: "failed" }));
});

// 测验和重考的每个阶段：点遍页面上能点的按钮（含确认框里的），前端都不发 task.advance。
// feedback 在测验里不会出现（反馈到整场结束才释放），也一并检查。
const quizStages: LearningTask["phase"][] = [
  { stage: "preparing" },
  { stage: "awaiting_answer", deliveryId: "d2" },
  { stage: "judging", submissionId: "s1" },
  { stage: "recovery", submissionId: "s1" },
  { stage: "feedback", submissionId: "s1" },
  { stage: "completed", outcome: "unresolved" },
];
it.each((["quiz", "retake"] as const).flatMap((kind) => quizStages.map((phase) => [kind, phase.stage, phase] as const)))("%s 的 %s 阶段：不论点哪个按钮，前端都不发 task.advance", async (kind, _stage, phase) => {
  const current = state(4, quizTask(phase, kind));
  const learning = vi.fn<Learning>((method) => {
    if (method === "state.get") return Promise.resolve(current);
    return Promise.reject(new Error(method));
  });
  const fake = backend(learning);
  start(fake.client);
  const main = await screen.findByRole("main");
  await within(main).findByText(kind === "quiz" ? "测验" : "重考");

  // 一个个点：点了以后可能打开确认框，确认框里的按钮也点。
  const clicked = new Set<HTMLElement>();
  for (let round = 0; round < 20; round++) {
    const next = screen.queryAllByRole("button").find((button) => !clicked.has(button) && !button.hasAttribute("disabled") && !button.closest("nav, aside, [data-sidebar]"));
    if (!next) break;
    clicked.add(next);
    await act(async () => { fireEvent.click(next); });
  }

  expect(clicked.size).toBeGreaterThan(0);
  expect(learningCalls(fake.call).map((call) => call.method)).not.toContain("task.advance");
});

it("测验头部：标题是“测验”，写第几题和剩余时间；不列 topic 名称，没有知识点圆圈", async () => {
  const titled = (phase: LearningTask["phase"]) => ({
    ...quizTask(phase),
    topics: [{ id: "py01", title: "数字、文字和缺省值不是一回事" }, { id: "py02", title: "名字指向当前的值" }],
    kps: [{ kpId: "py01.k1", title: "int、float、str 的行为差别", attempts: 0, consecutiveCorrect: 0, completed: false }],
  });
  let current = state(4, titled({ stage: "awaiting_answer", deliveryId: "d2" }));
  const learning = vi.fn<Learning>((method) => {
    if (method === "state.get") return Promise.resolve(current);
    return Promise.reject(new Error(method));
  });
  const store = start(backend(learning).client);

  const main = await screen.findByRole("main");
  expect(within(main).getByRole("heading", { name: "测验" })).toBeTruthy();
  expect(within(main).getByText(t("learn.quiz.position.status", { current: 2, total: 3 }))).toBeTruthy();
  expect(within(main).getByRole("timer").textContent).toMatch(/^1[45]:\d\d$/u);
  expect(within(main).queryByText("数字、文字和缺省值不是一回事", { exact: false })).toBeNull();
  expect(within(main).queryByRole("list", { name: "知识点" })).toBeNull();

  // 判不出结果的那份作答属于第 1 题；结束以后不再写题号和剩余时间。
  current = state(5, titled({ stage: "recovery", submissionId: "s1" }));
  await act(() => store.getState().refreshLearning());
  expect(within(main).getByText(t("learn.quiz.position.status", { current: 1, total: 3 }))).toBeTruthy();
  current = state(6, titled({ stage: "completed", outcome: "failed" }));
  await act(() => store.getState().refreshLearning());
  expect(within(main).queryByRole("timer")).toBeNull();
  expect(within(main).queryByText(t("learn.quiz.position.status", { current: 1, total: 3 }))).toBeNull();
});

it("测验截止后才交的一题被拒：换成后端交回的结果，说明这一题没有计入，而不是通用的“画面已经更新”", async () => {
  const learning = vi.fn<Learning>((method) => {
    if (method === "state.get") return Promise.resolve(state(4, quizAnswering));
    if (method === "submission.submit") return Promise.reject(new RpcError(-32000, "交付已失效或已截止", { code: "stale_state", details: { reason: "stale", state: state(5, quizTask({ stage: "completed", outcome: "timeout" })) } }));
    return Promise.reject(new Error(method));
  });
  const store = start(backend(learning).client);

  fireEvent.change(await screen.findByRole("textbox", { name: "显示的整数" }), { target: { value: "4" } });
  fireEvent.click(screen.getByRole("button", { name: "提交" }));

  expect(await screen.findByText(t("learn.result.timeout.status"))).toBeTruthy();
  expect(store.getState().learning.replaced).toBe("unrecorded");
  expect(screen.getByText(t("learn.quiz.unrecorded.title"))).toBeTruthy();
  expect(screen.queryByText("画面已经更新")).toBeNull();
});

it("测验还在进行时交题遇到过时状态，仍是通用的“画面已经更新”", async () => {
  const learning = vi.fn<Learning>((method) => {
    if (method === "state.get") return Promise.resolve(state(4, quizAnswering));
    if (method === "submission.submit") return Promise.reject(new RpcError(-32000, "交付已失效或已截止", { code: "stale_state", details: { reason: "stale", state: state(5, quizTask({ stage: "awaiting_answer", deliveryId: "d2" })) } }));
    return Promise.reject(new Error(method));
  });
  const store = start(backend(learning).client);

  fireEvent.change(await screen.findByRole("textbox", { name: "显示的整数" }), { target: { value: "4" } });
  fireEvent.click(screen.getByRole("button", { name: "提交" }));

  expect(await screen.findByText("画面已经更新")).toBeTruthy();
  expect(store.getState().learning.replaced).toBe("stale");
});

const answered = (index: number): Submission => ({
  taskId: "t1", deliveryId: `d${index}`, submissionId: `s${index}`, response: { item: { id: "o1", version }, answers: {} },
  acceptedAt: 5, processing: { status: "completed" }, gradeRevision: 1,
});

it.each([
  ["测验准备阶段", quizTask({ stage: "preparing" }), "中止测验"],
  ["测验作答中", quizAnswering, "finish"],
  ["测验判分中", quizTask({ stage: "judging", submissionId: "s1" }), "finish"],
  ["测验判不出结果", quizTask({ stage: "recovery", submissionId: "s1" }), "finish"],
  ["重考作答中", quizTask({ stage: "awaiting_answer", deliveryId: "d1" }, "retake"), "finish"],
  ["新课作答中", answering, "中止新课"],
] as const)("%s：底部是“%s”", async (_name, current, expected) => {
  const learning = vi.fn<Learning>((method) => {
    if (method === "state.get") return Promise.resolve(state(4, current));
    return Promise.reject(new Error(method));
  });
  start(backend(learning).client);
  const main = await screen.findByRole("main");
  await within(main).findByText(kindText(current.kind));

  const label = expected === "finish" ? t("learn.quiz.finish.action") : expected;
  expect(within(main).getByRole("button", { name: label })).toBeTruthy();
  expect(within(main).queryByRole("button", { name: /^中止/u }) !== null).toBe(expected !== "finish");
});

it("交卷的确认写明还有几题没答；确认后带着任务守卫交卷", async () => {
  const current = { ...quizAnswering, phase: { stage: "awaiting_answer" as const, deliveryId: "d2" }, submissions: [answered(1)] };
  const learning = vi.fn<Learning>((method) => {
    if (method === "state.get") return Promise.resolve(state(4, current));
    if (method === "quiz.finish") return Promise.resolve(state(5, quizTask({ stage: "completed", outcome: "failed" })));
    return Promise.reject(new Error(method));
  });
  const fake = backend(learning);
  start(fake.client);

  fireEvent.click(await screen.findByRole("button", { name: t("learn.quiz.finish.action") }));
  const dialog = await screen.findByRole("dialog", { name: t("learn.quiz.finish.title") });
  expect(within(dialog).getByText(t("learn.quiz.finish.unanswered.description", { count: 2 }))).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: t("learn.quiz.finish.action") }));

  expect(await screen.findByText("测验结束")).toBeTruthy();
  expect(learningCalls(fake.call).filter((call) => call.method === "quiz.finish").map((call) => call.input)).toEqual([{ taskId: "t1", expectedStage: "awaiting_answer", expectedRevision: 4 }]);
});

it("题都答了：交卷的确认里不说未答", async () => {
  const current = { ...quizTask({ stage: "awaiting_answer", deliveryId: "d3" }), submissions: [answered(1), answered(2), answered(3)] };
  const learning = vi.fn<Learning>((method) => {
    if (method === "state.get") return Promise.resolve(state(4, current));
    return Promise.reject(new Error(method));
  });
  start(backend(learning).client);

  fireEvent.click(await screen.findByRole("button", { name: t("learn.quiz.finish.action") }));
  const dialog = await screen.findByRole("dialog", { name: t("learn.quiz.finish.title") });
  for (const count of [0, 1, 2, 3]) expect(within(dialog).queryByText(t("learn.quiz.finish.unanswered.description", { count }))).toBeNull();
  expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toContain(t("common.cancel.action"));
});

it("测验的题都答完、判完（后端交回指向最后一题的等作答）：不再显示那道题，说明等交卷，交卷样式不变，不写题号", async () => {
  const current = { ...quizTask({ stage: "awaiting_answer", deliveryId: "d3" }), submissions: [answered(1), answered(2), answered(3)] };
  const learning = vi.fn<Learning>((method) => {
    if (method === "state.get") return Promise.resolve(state(4, current));
    return Promise.reject(new Error(method));
  });
  start(backend(learning).client);
  const main = await screen.findByRole("main");

  // 标题和说明的文字待写，现在都是同一个占位，按多个查。
  expect((await within(main).findAllByText(t("learn.quiz.ready.description"))).length).toBeGreaterThan(0);
  expect(within(main).queryByRole("button", { name: "提交" })).toBeNull();
  expect(within(main).queryByRole("textbox")).toBeNull();
  expect(within(main).getByRole("button", { name: t("learn.quiz.finish.action") }).getAttribute("data-variant")).toBe("ghost");
  expect(within(main).getByRole("timer")).toBeTruthy();
  for (const current of [1, 2, 3]) expect(within(main).queryByText(t("learn.quiz.position.status", { current, total: 3 }))).toBeNull();
});

it("还有题没答时作答框照常，交卷同样是次要按钮", async () => {
  const current = { ...quizTask({ stage: "awaiting_answer", deliveryId: "d3" }), submissions: [answered(1), answered(2)] };
  const learning = vi.fn<Learning>((method) => {
    if (method === "state.get") return Promise.resolve(state(4, current));
    return Promise.reject(new Error(method));
  });
  start(backend(learning).client);
  const main = await screen.findByRole("main");

  expect(await within(main).findByRole("button", { name: "提交" })).toBeTruthy();
  expect(within(main).getByRole("button", { name: t("learn.quiz.finish.action") }).getAttribute("data-variant")).toBe("ghost");
  expect(within(main).queryAllByText(t("learn.quiz.ready.description"))).toEqual([]);
});
