import { expect, it } from "vitest";
import type { AgentEvent, SessionEntry } from "@repa/base/protocol";

import { applyEvent, emptyConversation, historyItems, type Conversation } from "../src/lib/conversation";

const at = "2026-10-12T00:00:00.000Z";

it("会话记录转成显示项：工具结果按调用配对，错误和停止单独标出，运行细节不显示", () => {
  const entries: SessionEntry[] = [
    { id: "p1", type: "prompt", timestamp: at, text: "系统提示" },
    { id: "u1", type: "user", timestamp: at, text: "帮我看看笔记" },
    { id: "v1", type: "view", timestamp: at, text: "学习状态" },
    {
      id: "a1", type: "assistant", timestamp: at, text: "我先读一下。",
      data: { stopReason: "toolUse", calls: [{ id: "c1", name: "read", input: {} }, { id: "c2", name: "bash", input: {} }, { id: "c3", name: "ls", input: {} }] },
    },
    { id: "t1", type: "tool", timestamp: at, text: "内容", data: { callId: "c1", tool: "read", isError: false } },
    { id: "t2", type: "tool", timestamp: at, text: "拒绝", data: { callId: "c2", tool: "bash", isError: true } },
    { id: "a2", type: "assistant", timestamp: at, text: "", data: { stopReason: "error", errorMessage: "额度不足" } },
    { id: "u2", type: "user", timestamp: at, text: "继续" },
    { id: "a3", type: "assistant", timestamp: at, text: "好的", data: { stopReason: "aborted" } },
    { id: "r1", type: "run", timestamp: at, data: { runId: "x" } },
  ];

  expect(historyItems(entries)).toEqual([
    { kind: "user", id: "u1", text: "帮我看看笔记" },
    { kind: "assistant", id: "a1", text: "我先读一下。" },
    { kind: "tool", id: "c1", tool: "read", status: "done" },
    { kind: "tool", id: "c2", tool: "bash", status: "failed" },
    { kind: "tool", id: "c3", tool: "ls", status: "incomplete" },
    { kind: "error", id: "a2:error", text: "额度不足" },
    { kind: "user", id: "u2", text: "继续" },
    { kind: "assistant", id: "a3", text: "好的" },
    { kind: "stopped", id: "a3:stopped" },
  ]);
});

function play(events: Omit<AgentEvent, "sessionId" | "runId">[]): Conversation {
  return events.reduce<Conversation>(
    (conversation, event) => applyEvent(conversation, { sessionId: "s1", runId: "r1", ...event }),
    { ...emptyConversation, status: "ready" },
  );
}

it("文字增量拼成一条助手消息，完整消息覆盖拼接结果，工具调用之后的文字另起一条", () => {
  const conversation = play([
    { type: "runStart" },
    { type: "message", text: "解释一下导数", data: { role: "user" } },
    { type: "textDelta", text: "我先" },
    { type: "textDelta", text: "查一下" },
    { type: "message", text: "我先查一下。", data: { role: "assistant", stopReason: "toolUse" } },
    { type: "toolStart", tool: "read", data: { callId: "c1", input: {} } },
    { type: "toolEnd", tool: "read", data: { callId: "c1", isError: false } },
    { type: "textDelta", text: "导数是" },
  ]);

  expect(conversation.run).toBe("running");
  expect(conversation.items.map((item) => item.kind === "tool" ? `${item.tool}:${item.status}` : `${item.kind}:${"text" in item ? item.text : ""}`)).toEqual([
    "user:解释一下导数",
    "assistant:我先查一下。",
    "read:done",
    "assistant:导数是",
  ]);
  expect(conversation.streaming).toBe(conversation.items.at(-1)?.id);

  const ended = applyEvent(conversation, { sessionId: "s1", runId: "r1", type: "runEnd", data: { status: "completed" } });
  expect(ended.run).toBe("idle");
  expect(ended.streaming).toBeUndefined();
});

it("模型出错只显示一次，取消的运行只留下停止标记", () => {
  const failed = play([
    { type: "runStart" },
    { type: "message", text: "", data: { role: "assistant", stopReason: "error" } },
    { type: "error", text: "额度不足" },
    { type: "error", text: "模型请求失败", data: { code: "model_error" } },
  ]);
  expect(failed.items.map((item) => item.kind === "error" ? item.text : item.kind)).toEqual(["额度不足"]);

  const stopped = play([
    { type: "runStart" },
    { type: "textDelta", text: "导数" },
    { type: "message", text: "导数", data: { role: "assistant", stopReason: "aborted" } },
    { type: "error", text: "会话运行已取消", data: { code: "cancelled" } },
  ]);
  expect(stopped.items.map((item) => item.kind)).toEqual(["assistant", "stopped"]);
});
