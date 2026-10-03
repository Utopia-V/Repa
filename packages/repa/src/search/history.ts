import { RepaFault } from "../errors.js";
import type { Message } from "../protocol.js";
import { matchText, type RipgrepQuery } from "./ripgrep.js";
import type { HistorySearchMatch } from "./schema.js";
import { excerpt } from "./snippet.js";

interface HistoryBlock {
  messageId: string;
  blockIndex: number;
  start: number;
  end: number;
  firstLine: number;
  endsWithNewline: boolean;
  lineOffsets: number[];
}

const MAX_TEXT_BYTES = 8 * 1024 * 1024;

/** 只查询调用者取得的冻结历史；不读取会话文件、切换分支或打开 Agent。 */
export async function searchHistory(
  snapshot: { revision: string; messages: readonly Message[] },
  query: RipgrepQuery,
  options: { signal?: AbortSignal; limit?: number; maxTextBytes?: number } = {},
): Promise<{ revision: string; matches: HistorySearchMatch[]; truncated: boolean }> {
  const maxTextBytes = options.maxTextBytes ?? MAX_TEXT_BYTES;
  if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes < 1)
    throw new RepaFault("invalid_query", "历史搜索正文上限必须为正整数。");
  const pieces: string[] = [];
  const blocks: HistoryBlock[] = [];
  let bytes = 0;
  let offset = 0;
  let firstLine = 1;
  let truncated = false;
  history: for (const message of snapshot.messages) {
    for (const [blockIndex, block] of message.content.entries()) {
      if (options.signal?.aborted) throw new RepaFault("cancelled", "历史搜索已取消。");
      if ((block.type !== "text" && block.type !== "thinking") || block.text.length === 0) continue;
      const size = Buffer.byteLength(block.text);
      if (bytes + size > maxTextBytes) {
        // 只纳入完整块，避免截断正文后制造原文不存在的行尾匹配。
        truncated = true;
        break history;
      }
      const endsWithNewline = /[\r\n]$/.test(block.text);
      // 缺少 LF 时只追加段分隔，不改写原正文；正则行边界由 rg 的实际选项解释。
      const suffix = block.text.endsWith("\n") ? "" : "\n";
      const lineOffsets = [0];
      for (const ending of block.text.matchAll(/\r\n|\r|\n/g))
        lineOffsets.push(ending.index + ending[0].length);
      pieces.push(block.text, suffix);
      blocks.push({ messageId: message.id, blockIndex, start: offset, end: offset + block.text.length,
        firstLine, endsWithNewline, lineOffsets });
      bytes += size;
      offset += block.text.length + suffix.length;
      firstLine += lineOffsets.length - (endsWithNewline ? 1 : 0);
    }
  }
  const result = await matchText(pieces.join(""), query, { signal: options.signal, limit: options.limit });
  const matches: HistorySearchMatch[] = [];
  let blockIndex = 0;
  for (const match of result.matches) {
    while (blockIndex < blocks.length) {
      const block = blocks[blockIndex]!;
      if (match.utf16Range.start < block.end ||
        (match.utf16Range.start === block.end && !block.endsWithNewline)) break;
      blockIndex++;
    }
    const block = blocks[blockIndex];
    if (!block || match.utf16Range.start < block.start || match.utf16Range.end > block.end) continue;
    const line = match.line - block.firstLine + 1;
    const lineStart = block.lineOffsets[line - 1];
    if (lineStart === undefined) throw new RepaFault("search_failed", "历史搜索命中行不属于原消息块。");
    const range = { start: match.utf16Range.start - block.start, end: match.utf16Range.end - block.start };
    matches.push({
      messageId: block.messageId, blockIndex: block.blockIndex, line, range,
      snippet: excerpt(match.text, lineStart, range),
    });
  }
  return { revision: snapshot.revision, matches, truncated: truncated || result.truncated };
}
