import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { RepaFault } from "../src/errors.js";
import { discoverFiles, matchText } from "../src/search/ripgrep.js";

const fault = (code: string) => (error: unknown) => error instanceof RepaFault && error.code === code;

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-ripgrep-"));
  const cleanups: (() => Promise<void>)[] = [];
  t.after(async () => {
    try { for (const cleanup of cleanups) await cleanup(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  return { root, cleanup(work: () => Promise<void>) { cleanups.push(work); } };
}

async function until(read: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!read()) {
    if (Date.now() >= deadline) assert.fail("等待测试子进程状态超时");
    await delay(10);
  }
}

/** 只在同步 spawn 期间更换本测试进程的 PATH，返回 Promise 后立即恢复。 */
function withPath<T>(value: string, start: () => T): T {
  const previous = process.env.PATH;
  process.env.PATH = value;
  try { return start(); }
  finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
}

test("原生 rg CRLF 匹配保留输入字节，中文 emoji 与裸 CR 命中映射到内容读取坐标", async () => {
  const text = "\uFEFF开头\r\n中文target🙂target\r结尾TARGET\n";
  const result = await matchText(Buffer.from(text), { pattern: "target", literal: true, ignoreCase: true });
  const starts = [text.indexOf("target"), text.lastIndexOf("target"), text.indexOf("TARGET")];
  assert.deepEqual(result, {
    matches: starts.map((start, index) => ({
      line: index < 2 ? 2 : 3,
      text: index < 2 ? "中文target🙂target" : "结尾TARGET",
      byteRange: { start: Buffer.byteLength(text.slice(0, start)), end: Buffer.byteLength(text.slice(0, start + 6)) },
      utf16Range: { start, end: start + 6 },
    })),
    truncated: false,
  });
  const emoji = await matchText(text, { pattern: "🙂", literal: true });
  const emojiStart = text.indexOf("🙂");
  assert.deepEqual(emoji.matches[0]?.utf16Range, { start: emojiStart, end: emojiStart + 2 });
  assert.equal((emoji.matches[0]?.byteRange.end ?? 0) - (emoji.matches[0]?.byteRange.start ?? 0), 4);
  const anchored = await matchText(text, { pattern: "^结尾TARGET$" });
  assert.deepEqual(anchored.matches.map(match => [match.line, match.text]), [[3, "结尾TARGET"]]);
  assert.deepEqual((await matchText("a\rb\n", { pattern: "[^\\n]+" })).matches.map(match => ({ line: match.line, text: match.text, range: match.byteRange })), [
    { line: 1, text: "a", range: { start: 0, end: 1 } },
    { line: 2, text: "b", range: { start: 2, end: 3 } },
  ]);
  await assert.rejects(matchText(text, { pattern: "\\r" }), fault("invalid_query"));
  await assert.rejects(matchText(text, { pattern: "target\n结尾" }), fault("invalid_query"));
});

test("字面量与正则沿用 rg 语义，每项子命中计入上限且准确报告截断", async () => {
  const text = "a.b axb\nhit hit hit\n";
  assert.equal((await matchText(text, { pattern: "a.b", literal: true })).matches.length, 1);
  assert.equal((await matchText(text, { pattern: "a.b" })).matches.length, 2);
  const limited = await matchText(text, { pattern: "hit", literal: true }, { limit: 2 });
  assert.equal(limited.matches.length, 2);
  assert(limited.matches.every(match => match.line === 2));
  assert.equal(limited.truncated, true);
  const exact = await matchText("hit hit\n", { pattern: "hit" }, { limit: 2 });
  assert.equal(exact.matches.length, 2);
  assert.equal(exact.truncated, false);
  assert.deepEqual(await matchText("没有命中", { pattern: "absent" }), { matches: [], truncated: false });
  assert.deepEqual(await matchText("", { pattern: "^$" }), { matches: [], truncated: false });
  assert.equal((await matchText("\n", { pattern: "^$" })).matches.length, 1);
  assert.equal((await matchText("正文\n", { pattern: "^$" })).matches.length, 0);
  await assert.rejects(matchText(text, { pattern: "[" }), fault("invalid_query"));
  await assert.rejects(matchText(Buffer.from([0xff]), { pattern: "text" }), fault("unsupported_format"));
});

test("目录候选发现复用 rg 过滤规则，不纳入管理文件或跟随空间外链接", async (t) => {
  const f = await fixture(t);
  const root = path.join(f.root, "space");
  const outside = path.join(f.root, "outside");
  await mkdir(path.join(root, "sub/.repa"), { recursive: true });
  await mkdir(path.join(root, ".repa"));
  await mkdir(path.join(root, ".git"));
  await mkdir(outside);
  const files = ["first.txt", "sub/中文\n名称.txt", ".hidden.txt", ".repa/private.txt", "sub/.repa/private.txt", ".repa-save.tmp", ".git/config", "ignored.txt"];
  for (const file of files) await writeFile(path.join(root, file), "内容");
  await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(path.join(outside, "secret.txt"), "空间外内容");
  await symlink(path.join(outside, "secret.txt"), path.join(root, "linked-file.txt"));
  await symlink(outside, path.join(root, "linked-directory"));
  const result = await discoverFiles(root);
  const names = result.paths.map(file => path.relative(root, file));
  assert.deepEqual(new Set(names), new Set([".gitignore", ".hidden.txt", "first.txt", "sub/中文\n名称.txt"]));
  assert.equal(result.truncated, false);
  const reopened = await discoverFiles(root, { glob: "**/*" });
  assert(reopened.paths.includes(path.join(root, "ignored.txt")), "用户 glob 可覆盖普通 ignore，但不能覆盖固定目录过滤");
  assert(!reopened.paths.some(file => /(?:^|[/\\])(?:\.repa(?:[/\\]|$)|\.repa-.*\.tmp$|\.git(?:[/\\]|$)|linked-)/.test(path.relative(root, file))));
  assert.deepEqual(await discoverFiles(root, { glob: "**/.repa/**" }), { paths: [], truncated: false });
  const limited = await discoverFiles(root, { glob: "*.txt", limit: 1 });
  assert.equal(limited.paths.length, 1);
  assert.equal(limited.truncated, true);
  assert.deepEqual(await discoverFiles(root, { glob: "first.txt", limit: 1 }), { paths: [path.join(root, "first.txt")], truncated: false });
  await assert.rejects(discoverFiles(root, { glob: "[" }), fault("invalid_query"));
  await assert.rejects(discoverFiles(path.join(f.root, "missing")), fault("search_failed"));
});

test("目录预筛只交出实际命中文件，与原始快照的二次匹配采用相同 rg 语义", async (t) => {
  const f = await fixture(t);
  const texts = new Map([
    ["lf.txt", "前文\n中文🙂 needle\n后文\n"],
    ["crlf.txt", "前文\r\n中文🙂 NEEDLE\r\n后文\r\n"],
    ["cr.txt", "前文\r中文🙂 needle\r后文\r"],
    ["unmatched.txt", "不需要读取快照的正文\n"],
  ]);
  for (const [file, text] of texts) await writeFile(path.join(f.root, file), text);
  await mkdir(path.join(f.root, ".repa"));
  await writeFile(path.join(f.root, ".repa/secret.txt"), "中文🙂 needle\n");
  const query = { pattern: "^中文🙂 needle$", ignoreCase: true };
  const result = await discoverFiles(f.root, { query, glob: "**/*" });
  assert.deepEqual(result.paths.map(file => path.basename(file)), ["cr.txt", "crlf.txt", "lf.txt"]);
  assert.equal(result.truncated, false);
  for (const file of result.paths) {
    const bytes = await readFile(file);
    const matched = await matchText(bytes, query);
    assert.equal(matched.matches.length, 1);
    assert.equal(matched.matches[0]?.line, 2);
    const match = matched.matches[0];
    assert(match);
    assert.equal(bytes.subarray(match.byteRange.start, match.byteRange.end).toString(), match.text);
    assert.equal(bytes.toString().slice(match.utf16Range.start, match.utf16Range.end), match.text);
  }
  assert.equal((await discoverFiles(f.root, { query, limit: 1 })).truncated, true);
  assert.deepEqual(await discoverFiles(f.root, { query: { pattern: "absent", literal: true } }), { paths: [], truncated: false });
  await assert.rejects(discoverFiles(f.root, { query: { pattern: "[" } }), fault("invalid_query"));
});

test("工具缺失与进程失败明确区分，不隐式下载或当作没有命中", async (t) => {
  const f = await fixture(t);
  await assert.rejects(withPath(f.root, () => matchText("正文", { pattern: "正文" })), fault("tool_unavailable"));
  await writeFile(path.join(f.root, "rg"), `#!${process.execPath}\nprocess.stderr.write("fixture process failure\\n"); process.exit(7);\n`, { mode: 0o700 });
  await assert.rejects(withPath(f.root, () => matchText("正文", { pattern: "正文" })), fault("search_failed"));
});

test("取消只在真实子进程退出后完成，已经取消的调用不启动工具", async (t) => {
  const f = await fixture(t);
  const pidFile = path.join(f.root, "pid");
  const cancelledFile = path.join(f.root, "cancelled");
  const releaseFile = path.join(f.root, "release");
  // 仅在系统进程边界控制退出时机；文本与目录行为由上面的真实 rg 用例验证。
  await writeFile(path.join(f.root, "rg"), `#!${process.execPath}
const fs = require("node:fs");
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(cancelledFile)}, "cancelled");
  setInterval(() => { if (fs.existsSync(${JSON.stringify(releaseFile)})) process.exit(0); }, 5);
});
process.stdin.resume();
setInterval(() => {}, 1000);
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
`, { mode: 0o700 });
  const controller = new AbortController();
  const pending = withPath(f.root, () => matchText("实际输入", { pattern: "输入" }, { signal: controller.signal }));
  f.cleanup(async () => {
    controller.abort();
    await writeFile(releaseFile, "release");
    await pending.catch(() => {});
  });
  let settled = false;
  const observed = pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(pending, fault("cancelled"));
  await until(() => existsSync(pidFile));
  const pid = Number(await readFile(pidFile, "utf8"));
  controller.abort();
  await until(() => existsSync(cancelledFile));
  assert.equal(settled, false);
  assert.doesNotThrow(() => process.kill(pid, 0));
  await writeFile(releaseFile, "release");
  await Promise.all([rejected, observed]);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const preCancelled = new AbortController();
  preCancelled.abort();
  await assert.rejects(withPath(path.join(f.root, "no-tools"), () => matchText("正文", { pattern: "正文" }, { signal: preCancelled.signal })), fault("cancelled"));
});
