import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { limitToolText } from "../src/agent/output.js";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-tool-output-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, sessionId: "session", toolCallId: "call" };
}

test("短输出原样返回，包括空文本、中文和临界值，不创建输出文件", async t => {
  const location = await fixture(t);
  for (const text of ["", "中文\r\n完整。\n", "a".repeat(DEFAULT_MAX_BYTES), Array(DEFAULT_MAX_LINES).fill("行").join("\n")]) {
    assert.equal(await limitToolText(text, location), text);
  }
  assert.deepEqual(await readdir(location.root), []);
});

test("多行、超长单行与中文输出保存原文字节，首尾和提示符合 Pi 默认上限", async t => {
  const location = await fixture(t);
  for (const text of [Array(3000).fill("一行").join("\n"), JSON.stringify({ 开始: "开头", 正文: "中文🙂".repeat(30_000), 结束: "结尾" }), Array(1500).fill("中文内容".repeat(10)).join("\n")]) {
    const result = await limitToolText(text, location);
    assert.equal(truncateHead(result).truncated, false);
    const match = /\n\[中间省略 (\d+) 字节、(\d+) 行；全文在 ([^，]+)，可用 read 工具按行读取\]\n/u.exec(result);
    assert.ok(match && match.index !== undefined);
    const head = result.slice(0, match.index);
    const tail = result.slice(match.index + match[0].length);
    assert.ok(head.length > 0 && tail.length > 0);
    assert.ok(text.startsWith(head));
    assert.ok(text.endsWith(tail));
    assert.ok(Buffer.byteLength(head) <= DEFAULT_MAX_BYTES * 0.6);
    assert.ok(Buffer.byteLength(tail) <= DEFAULT_MAX_BYTES * 0.2);
    const omitted = text.slice(head.length, text.length - tail.length);
    assert.equal(Number(match[1]), Buffer.byteLength(omitted));
    assert.equal(Number(match[2]), omitted.split("\n").length);
    assert.equal(match[3], ".repa/tool-output/session/call.txt");
    assert.deepEqual(await readFile(path.join(location.root, match[3] ?? "")), Buffer.from(text, "utf8"));
    assert.equal(result.includes("�"), false);
  }
});

test("多行输出在行边界保留首尾，超长首尾行退回字符边界", async t => {
  const location = await fixture(t);
  const line = "中文行🙂".repeat(40);
  const text = Array(3000).fill(line).join("\n");
  const result = await limitToolText(text, location);
  const [head, tail] = result.split(/\n\[中间省略[^\n]+\]\n/u);
  assert.ok(head?.endsWith("\n"));
  assert.ok(tail?.startsWith(line));
  const longLines = `${"🙂".repeat(20_000)}\n${"中".repeat(30_000)}`;
  const longResult = await limitToolText(longLines, location);
  assert.ok(longResult.startsWith("🙂"));
  assert.ok(longResult.endsWith("中"));
  assert.equal(longResult.includes("�"), false);
});
