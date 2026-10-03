import { RepaFault } from "../errors.js";
import type { Range, TextSnippet } from "./schema.js";

function splitsSurrogate(text: string, offset: number): boolean {
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

/** text 为不含行尾的原逻辑行；输入和返回 range 均使用所属正文的 UTF-16 坐标。 */
export function excerpt(text: string, lineStart: number, matchRange: Range, limit = 500): TextSnippet {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new RepaFault("invalid_query", "搜索片段上限必须为正整数。");
  const matchStart = matchRange.start - lineStart;
  const matchEnd = matchRange.end - lineStart;
  const preferred = matchEnd - matchStart > limit ? matchStart : Math.floor((matchStart + matchEnd - limit) / 2);
  let start = Math.max(0, Math.min(preferred, text.length - limit));
  if (splitsSurrogate(text, start)) start++;
  let end = Math.min(text.length, start + limit);
  if (splitsSurrogate(text, end)) end--;
  return {
    text: text.slice(start, end),
    range: { start: lineStart + start, end: lineStart + end },
    truncated: start > 0 || end < text.length,
  };
}
