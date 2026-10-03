import { spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { RepaFault } from "../errors.js";

export interface RipgrepQuery {
  pattern: string;
  literal?: boolean;
  ignoreCase?: boolean;
}

export interface TextMatch {
  /** 与 content.read 一致，逻辑行从 1 开始；text 不包含行尾。 */
  line: number;
  text: string;
  /** 原始输入中的全局偏移，从 0 开始，末端不含。 */
  byteRange: { start: number; end: number };
  utf16Range: { start: number; end: number };
}

interface SourceLine {
  text: string;
  byteStart: number;
  utf16Start: number;
}

// 只检查使用到的上游 JSON 字段，保留 rg 其他事件及字段的兼容空间。
const EventSchema = Type.Object({ type: Type.String() });
const MatchEventSchema = Type.Object({
  type: Type.Literal("match"),
  data: Type.Object({
    absolute_offset: Type.Integer({ minimum: 0 }),
    submatches: Type.Array(Type.Object({ start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 0 }) })),
  }),
});
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

function resultLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RepaFault("invalid_query", "搜索结果上限必须为正整数。");
  return limit;
}

function queryArguments(query: RipgrepQuery): string[] {
  return [
    "--crlf", "--encoding=none", "--color=never",
    ...(query.literal ? ["--fixed-strings"] : []),
    ...(query.ignoreCase ? ["--ignore-case"] : []),
  ];
}

/** 只启动 rg；取消和达到上限都等实际子进程退出，不使用 shell 或工具下载入口。 */
function runRipgrep(args: string[], options: {
  input?: Buffer;
  signal?: AbortSignal;
  delimiter: "\n" | "\0";
  record(value: string): boolean;
}): Promise<{ truncated: boolean }> {
  if (options.signal?.aborted) return Promise.reject(new RepaFault("cancelled", "搜索已取消。"));
  return new Promise((resolve, reject) => {
    const child = spawn("rg", ["--no-config", ...args], { stdio: ["pipe", "pipe", "pipe"], shell: false });
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let outputBytes = 0;
    let diagnostic = "";
    let diagnosticBytes = 0;
    let truncated = false;
    let aborted = false;
    let failure: unknown;
    const stop = () => {
      child.stdin.destroy();
      if (!child.killed) child.kill();
    };
    const abort = () => { aborted = true; stop(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error: NodeJS.ErrnoException) => {
      failure = error.code === "ENOENT"
        ? new RepaFault("tool_unavailable", "搜索需要 PATH 中已安装的 ripgrep（rg），不会自动下载。")
        : new RepaFault("search_failed", "无法启动 ripgrep。", { reason: error.message });
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // rg 可能因查询错误或结果上限先关闭 stdin，最终状态由 close 统一判断。
      if (error.code !== "EPIPE" && !aborted && !truncated && !failure) {
        failure = new RepaFault("search_failed", "无法向 ripgrep 提交搜索文本。", { reason: error.message });
        stop();
      }
    });
    const consume = (text: string) => {
      pending += text;
      let boundary: number;
      while ((boundary = pending.indexOf(options.delimiter)) >= 0) {
        const value = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        if (!options.record(value)) {
          truncated = true;
          pending = "";
          stop();
          return;
        }
      }
    };
    child.stdout.on("data", (bytes: Buffer) => {
      if (aborted || truncated || failure) return;
      const remaining = MAX_OUTPUT_BYTES - outputBytes;
      outputBytes += bytes.length;
      try {
        consume(decoder.write(bytes.subarray(0, remaining)));
        if (!truncated && outputBytes > MAX_OUTPUT_BYTES) { truncated = true; pending = ""; stop(); }
      } catch (error) { failure = error; stop(); }
    });
    child.stderr.on("data", (bytes: Buffer) => {
      const remaining = Math.max(0, MAX_DIAGNOSTIC_BYTES - diagnosticBytes);
      diagnostic += bytes.subarray(0, remaining).toString("utf8");
      diagnosticBytes += bytes.length;
    });
    child.on("close", (code, signal) => {
      options.signal?.removeEventListener("abort", abort);
      if (aborted) { reject(new RepaFault("cancelled", "搜索已取消。")); return; }
      if (failure) { reject(failure); return; }
      if (truncated) { resolve({ truncated: true }); return; }
      if (code !== 0 && code !== 1) {
        const invalidQuery = /^(?:rg: )?(?:regex parse error|regex error|error parsing (?:regex|glob)|the literal .* is not allowed in a regex)/m.test(diagnostic);
        reject(new RepaFault(invalidQuery ? "invalid_query" : "search_failed",
          invalidQuery ? "搜索模式或 glob 无效。" : "ripgrep 未能完成搜索。", { code, signal, diagnostic: diagnostic.trim() }));
        return;
      }
      try {
        consume(decoder.end());
        if (pending && !options.record(pending)) truncated = true;
        resolve({ truncated });
      } catch (error) { reject(error); }
    });
    child.stdin.end(options.input);
  });
}

function sourceLines(input: string | Uint8Array): { lines: SourceLine[]; bytes: Buffer } {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new RepaFault("unsupported_format", "文本搜索需要有效的 UTF-8 表示。"); }
  if (text.includes("\0")) throw new RepaFault("unsupported_format", "文本搜索不接受含 NUL 的二进制表示。");
  const lines: SourceLine[] = [];
  let byteStart = 0;
  let utf16Start = 0;
  // 仅为内容读取与展示建立逻辑行坐标；匹配使用原始字节及 rg 自身的行尾语义。
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g)) {
    const raw = match[0];
    let ending = 0;
    if (raw.endsWith("\r\n")) ending = 2;
    else if (raw.endsWith("\r") || raw.endsWith("\n")) ending = 1;
    const line = raw.slice(0, raw.length - ending);
    lines.push({ text: line, byteStart, utf16Start });
    byteStart += Buffer.byteLength(raw);
    utf16Start += raw.length;
  }
  return { lines, bytes };
}

function sourceLineAt(lines: readonly SourceLine[], byteOffset: number): number {
  let first = 0;
  let end = lines.length;
  while (first < end) {
    const middle = Math.floor((first + end) / 2);
    if (lines[middle]!.byteStart <= byteOffset) first = middle + 1;
    else end = middle;
  }
  return first - 1;
}

/** 原字节采用 rg --crlf 原生匹配，不启用 multiline；每个结果及 limit 单位都是 submatch。 */
export async function matchText(input: string | Uint8Array, query: RipgrepQuery, options: { signal?: AbortSignal; limit?: number } = {}): Promise<{ matches: TextMatch[]; truncated: boolean }> {
  const limit = resultLimit(options.limit);
  const queryArgs = queryArguments(query);
  const source = sourceLines(input);
  const matches: TextMatch[] = [];
  const result = await runRipgrep(["--json", "--line-number", ...queryArgs, "--", query.pattern, "-"], {
    input: source.bytes, signal: options.signal, delimiter: "\n",
    record(value) {
      let event: unknown;
      try { event = JSON.parse(value); }
      catch { throw new RepaFault("search_failed", "ripgrep 返回了无法解析的 JSON。"); }
      if (!Check(EventSchema, event)) throw new RepaFault("search_failed", "ripgrep 返回了无法解析的事件。");
      if (event.type !== "match") return true;
      if (!Check(MatchEventSchema, event)) throw new RepaFault("search_failed", "ripgrep 返回了无法解析的命中。");
      for (const span of event.data.submatches) {
        if (matches.length === limit) return false;
        const byteStart = event.data.absolute_offset + span.start;
        const byteEnd = event.data.absolute_offset + span.end;
        if (byteStart > byteEnd || byteEnd > source.bytes.length) throw new RepaFault("search_failed", "ripgrep 的命中范围超出了本次输入。");
        const lineIndex = sourceLineAt(source.lines, byteStart);
        const line = source.lines[lineIndex];
        if (!line) throw new RepaFault("search_failed", "ripgrep 的命中行不属于本次输入。");
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
        let start: number;
        let end: number;
        try {
          start = line.utf16Start + decoder.decode(source.bytes.subarray(line.byteStart, byteStart)).length;
          end = line.utf16Start + decoder.decode(source.bytes.subarray(line.byteStart, byteEnd)).length;
        } catch { throw new RepaFault("invalid_query", "搜索模式产生了不在 UTF-8 字符边界上的命中。"); }
        matches.push({
          line: lineIndex + 1, text: line.text,
          byteRange: { start: byteStart, end: byteEnd },
          utf16Range: { start, end },
        });
      }
      return true;
    },
  });
  return { matches, truncated: result.truncated };
}

/** root 必须已由调用者授权；这里只预筛候选，最终命中和修订仍由快照读取入口负责。 */
export async function discoverFiles(root: string, options: { query?: RipgrepQuery; glob?: string; signal?: AbortSignal; limit?: number } = {}): Promise<{ paths: string[]; truncated: boolean }> {
  const limit = resultLimit(options.limit);
  const paths: string[] = [];
  const result = await runRipgrep([
    ...(options.query ? ["--files-with-matches", ...queryArguments(options.query)] : ["--files"]),
    "--null", "--hidden", "--no-follow", "--no-ignore-parent", "--no-ignore-global", "--no-require-git", "--sort=path",
    ...(options.glob ? ["--glob", options.glob] : []),
    // 目录遍历过滤最后应用；显式目标的访问权限仍由内容入口确认。
    "--glob", "!**/.repa", "--glob", "!**/.repa/**", "--glob", "!**/.repa-*.tmp",
    "--glob", "!**/.git", "--glob", "!**/.git/**", "--", ...(options.query ? [options.query.pattern] : []), path.resolve(root),
  ], {
    signal: options.signal, delimiter: "\0",
    record(value) {
      if (paths.length === limit) return false;
      paths.push(path.resolve(value));
      return true;
    },
  });
  return { paths, truncated: result.truncated };
}
