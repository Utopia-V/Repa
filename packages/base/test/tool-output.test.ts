import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { limitToolText } from "../src/agent/output.js";

test("短输出原样返回，包括空文本、中文和临界值", () => {
  for (const text of ["", "中文\r\n完整。\n", "a".repeat(DEFAULT_MAX_BYTES), Array(DEFAULT_MAX_LINES).fill("行").join("\n")]) {
    assert.equal(limitToolText(text), text);
  }
});

test("多行、超长单行与中文输出连同省略提示符合 Pi 默认上限，准确报告省略量", () => {
  for (const text of [Array(3000).fill("一行").join("\n"), "a".repeat(60_000), Array(1500).fill("中文内容".repeat(10)).join("\n")]) {
    const result = limitToolText(text);
    assert.equal(truncateHead(result).truncated, false);
    const body = result.slice(0, result.lastIndexOf("\n\n"));
    const count = body === "" ? 0 : body.split("\n").length;
    assert.ok(result.includes(`已省略 ${Buffer.byteLength(text) - Buffer.byteLength(body)} 字节、${text.split("\n").length - count} 行`));
    assert.match(result, /缩小查询范围.*分页参数/);
    assert.equal(result.includes("�"), false);
  }
});
