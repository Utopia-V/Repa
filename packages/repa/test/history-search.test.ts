import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../src/protocol.js";
import { RepaFault } from "../src/errors.js";
import { searchHistory } from "../src/search/history.js";
import { excerpt } from "../src/search/snippet.js";

function message(id: string, role: Message["role"], content: Message["content"]): Message {
  return { id, role, timestamp: 0, content };
}

const fault = (code: string) => (error: unknown) => error instanceof RepaFault && error.code === code;

test("真实 rg 一次查询公开历史文本，中文和 emoji 定位回原消息块及换行前坐标", async () => {
  const text = "起😀线索\r\n下一行线索\r尾行";
  const snapshot = {
    revision: "冻结历史修订",
    messages: [
      message("question", "user", [{ type: "text", text }]),
      message("reply", "assistant", [
        { type: "tool_call", id: "call", name: "probe", arguments: { hidden: "线索" } },
        { type: "thinking", text: "思考中的线索" },
        { type: "extension", data: { hidden: "线索" } },
      ]),
      message("tool", "tool", [{ type: "text", text: "工具结果线索" }]),
      message("summary", "context", [{ type: "text", text: "压缩摘要线索" }]),
    ],
  };
  const before = structuredClone(snapshot);
  const result = await searchHistory(snapshot, { pattern: "线索", literal: true });
  assert.equal(result.revision, snapshot.revision);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.matches.map(({ snippet, ...match }) => match), [
    { messageId: "question", blockIndex: 0, line: 1, range: { start: 3, end: 5 } },
    { messageId: "question", blockIndex: 0, line: 2, range: { start: 10, end: 12 } },
    { messageId: "reply", blockIndex: 1, line: 1, range: { start: 4, end: 6 } },
    { messageId: "tool", blockIndex: 0, line: 1, range: { start: 4, end: 6 } },
    { messageId: "summary", blockIndex: 0, line: 1, range: { start: 4, end: 6 } },
  ]);
  assert.deepEqual(result.matches.map(match => match.snippet), [
    { text: "起😀线索", range: { start: 0, end: 5 }, truncated: false },
    { text: "下一行线索", range: { start: 7, end: 12 }, truncated: false },
    { text: "思考中的线索", range: { start: 0, end: 6 }, truncated: false },
    { text: "工具结果线索", range: { start: 0, end: 6 }, truncated: false },
    { text: "压缩摘要线索", range: { start: 0, end: 6 }, truncated: false },
  ]);
  assert.deepEqual(snapshot, before);
  for (const match of result.matches) {
    const source = snapshot.messages.find(item => item.id === match.messageId)?.content[match.blockIndex];
    assert(source && "text" in source);
    assert.equal(source.text.slice(match.range.start, match.range.end), "线索");
    assert.equal(source.text.slice(match.snippet.range.start, match.snippet.range.end), match.snippet.text);
  }
});

test("不同文本块不跨行串联，补齐行尾不制造空命中，原有空行仍可定位", async () => {
  const snapshot = {
    revision: "块边界修订",
    messages: [message("blocks", "user", [
      { type: "text", text: "a" },
      { type: "text", text: "b" },
      { type: "text", text: "c\r" },
      { type: "text", text: "\n实际正文\n" },
      { type: "text", text: "" },
    ])],
  };
  assert.deepEqual((await searchHistory(snapshot, { pattern: "a.*b" })).matches, []);
  assert.deepEqual((await searchHistory(snapshot, { pattern: "^$" }, { limit: 1 })).matches, [
    { messageId: "blocks", blockIndex: 3, line: 1, range: { start: 0, end: 0 },
      snippet: { text: "", range: { start: 0, end: 0 }, truncated: false } },
  ]);
  const endings = await searchHistory(snapshot, { pattern: "$" });
  assert.equal(endings.truncated, false);
  assert.deepEqual(endings.matches.map(match => ({ blockIndex: match.blockIndex, line: match.line, range: match.range })), [
    { blockIndex: 0, line: 1, range: { start: 1, end: 1 } },
    { blockIndex: 1, line: 1, range: { start: 1, end: 1 } },
    { blockIndex: 2, line: 1, range: { start: 1, end: 1 } },
    { blockIndex: 3, line: 1, range: { start: 0, end: 0 } },
    { blockIndex: 3, line: 2, range: { start: 5, end: 5 } },
  ]);
});

test("LF、CRLF 和裸 CR 的锚点沿用真实 rg 语义，位置仍属于原消息块", async () => {
  const snapshot = {
    revision: "原始换行修订",
    messages: [message("endings", "user", [
      { type: "text", text: "a\n" },
      { type: "text", text: "b\r\n" },
      { type: "text", text: "c\r" },
      { type: "text", text: "d\re\n" },
    ])],
  };
  const result = await searchHistory(snapshot, { pattern: "^[a-e]$" });
  assert.equal(result.truncated, false);
  assert.deepEqual(result.matches.map(match => ({ blockIndex: match.blockIndex, line: match.line, range: match.range })), [
    { blockIndex: 0, line: 1, range: { start: 0, end: 1 } },
    { blockIndex: 1, line: 1, range: { start: 0, end: 1 } },
    { blockIndex: 2, line: 1, range: { start: 0, end: 1 } },
    { blockIndex: 3, line: 1, range: { start: 0, end: 1 } },
    { blockIndex: 3, line: 2, range: { start: 2, end: 3 } },
  ]);
  const empty = await searchHistory(snapshot, { pattern: "^$" }, { limit: 1 });
  assert.deepEqual(empty.matches, []);
  assert.equal(empty.truncated, false);
});

test("结果上限按实际子命中计数，正文上限按完整块停止并明示未完整查询", async () => {
  const first = "match MATCH";
  const snapshot = {
    revision: "有限读取修订",
    messages: [message("bounded", "user", [
      { type: "text", text: first }, { type: "text", text: "后续 match" },
    ])],
  };
  const query = { pattern: "match", literal: true, ignoreCase: true };
  const limited = await searchHistory(snapshot, query, { limit: 1 });
  assert.equal(limited.matches.length, 1);
  assert.equal(limited.truncated, true);
  const bounded = await searchHistory(snapshot, query, { limit: 2, maxTextBytes: Buffer.byteLength(first) });
  assert.equal(bounded.matches.length, 2);
  assert.equal(bounded.truncated, true);
  assert(bounded.matches.every(match => match.blockIndex === 0));
  const complete = await searchHistory({ ...snapshot, messages: [message("bounded", "user", [{ type: "text", text: first }])] }, query, { limit: 2 });
  assert.equal(complete.matches.length, 2);
  assert.equal(complete.truncated, false);
  const tooSmall = await searchHistory(snapshot, query, { maxTextBytes: 1 });
  assert.deepEqual(tooSmall.matches, []);
  assert.equal(tooSmall.truncated, true);
});

test("长行片段有原块范围且不劈 emoji，长匹配仍保留完整真实命中范围", async () => {
  const text = "😀".repeat(270) + "线索" + "结束".repeat(300);
  const snippet = excerpt(text, 30, { start: 570, end: 572 });
  assert.equal(snippet.text.length, 500);
  assert.deepEqual(snippet.range, { start: 322, end: 822 });
  assert(snippet.text.includes("线索"));
  assert.equal(snippet.text, text.slice(snippet.range.start - 30, snippet.range.end - 30));
  assert.equal(snippet.truncated, true);
  const boundary = excerpt("a".repeat(499) + "😀tail", 0, { start: 0, end: 1 });
  assert.equal(boundary.text, "a".repeat(499));
  assert.deepEqual(boundary.range, { start: 0, end: 499 });
  const longMatch = await searchHistory({ revision: "长行修订", messages: [
    message("long", "assistant", [{ type: "text", text: "😀".repeat(400) }]),
  ] }, { pattern: "😀+" });
  assert.equal(longMatch.matches.length, 1);
  assert.deepEqual(longMatch.matches[0]?.range, { start: 0, end: 800 });
  assert.deepEqual(longMatch.matches[0]?.snippet, {
    text: "😀".repeat(250), range: { start: 0, end: 500 }, truncated: true,
  });
  assert.equal(longMatch.truncated, false);
});

test("历史搜索保留真实查询错误和取消结果，不将失败报告为空命中", async () => {
  const snapshot = { revision: "查询修订", messages: [message("query", "user", [{ type: "text", text: "正文" }])] };
  await assert.rejects(searchHistory(snapshot, { pattern: "[" }), fault("invalid_query"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(searchHistory(snapshot, { pattern: "正文" }, { signal: controller.signal }), fault("cancelled"));
});
