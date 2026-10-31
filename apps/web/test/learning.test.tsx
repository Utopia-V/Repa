import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { ConnectionError, RpcError } from "@repa/base/client";
import type { Item, SessionEntry, SessionInfo } from "@repa/base/protocol";
import type { Delivery, LearningState, LearningTask } from "@repa/learning/protocol";

import { StoreProvider } from "../src/hooks/use-app-store";
import { TrialRunnerProvider, type TrialRunner } from "../src/hooks/use-trial-runner";
import { createAppStore } from "../src/lib/store";
import { routes } from "../src/routes";
import { fakeClient } from "./fake-client";
import { mockMatchMedia } from "./match-media";

afterEach(() => { cleanup(); localStorage.clear(); });

const version = `sha256:${"1".repeat(64)}`;
const ref = (id: string, kind: "lesson" | "example" | "card" | "kp", kpId = "py01.k1") => ({ courseId: "python", topicId: "py01", kpId, id, version, kind });
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
    taskId: "t1", kind: "lesson", topics: [{ id: "py01", title: "数字、文字和缺省值不是一回事" }], phase, startedAt: 1, deadlineAt: null,
    kps: [{ kpId: "py01.k1", title: "int、float、str 的行为差别", attempts: 0, consecutiveCorrect: 0, completed: false }],
    deliveries: [], submissions: [], ...extra,
  };
}

function state(revision: number, current: LearningTask | null): LearningState {
  return { revision, serverNow: 1_000 + revision, course: { id: "python", title: "Python：读懂代码，说清需求", version: "0.2.0" }, task: current, menu: null, restrictions: open, progress };
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
        return Promise.resolve({ root: "/notes/python" });
      case "space.list":
      case "session.list":
      case "model.list":
      case "model.providers":
        return Promise.resolve([]);
      case "model.getDefault":
        return Promise.resolve(null);
      case "plugin.list":
        return Promise.resolve([{ id: "learning", methods: [], tools: [] }]);
      case "plugin.call":
        return learning(params.method as string, params.input as Record<string, unknown>);
      default:
        return Promise.reject(new Error(`未模拟的方法 ${method}`));
    }
  });
  return { call, ...fakeClient(call) };
}

function learningCalls(call: ReturnType<typeof backend>["call"]) {
  return call.mock.calls.filter(([method]) => method === "plugin.call").map(([, params]) => params as { method: string; input: unknown });
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
  const tutor = await screen.findByRole("region", { name: "辅导" });

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
    protocol: "repa-python-batch-v2" as const,
    tests: [{ id: "trial", program: "print(len(df))\nprint(x)\n", prelude: "", setup: "", data: [], captures: [], doctest: [] }],
  };
  const learning = vi.fn<Learning>((method) => {
    if (method === "state.get") return Promise.resolve(state(1, task({ stage: "awaiting_answer", deliveryId: "d4" }, { deliveries: [coding] })));
    if (method === "run.prepare") return Promise.resolve(batch);
    return Promise.reject(new Error(method));
  });
  const runner = { run: vi.fn<TrialRunner["run"]>(() => Promise.resolve({
    protocol: "repa-python-batch-v2",
    runtime: { pyodide: "0.29.0", python: "3.13.2", packages: {} },
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
  expect(learningCalls(fake.call).map((call) => call.method)).toEqual(["state.get", "run.prepare"]);
});
