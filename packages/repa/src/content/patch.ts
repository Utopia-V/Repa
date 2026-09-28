/**
 * 语法及分级定位参考 OpenAI Codex（Apache-2.0）：
 * https://github.com/openai/codex/tree/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/apply-patch/src
 * 这里独立实现 Repa 的唯一定位与逐行保真语义，不采用其整文件换行规范化。
 */
export interface PatchChunk {
  oldLines: string[];
  newLines: string[];
  /** oldLines 与 newLines 中明确标为上下文的对应下标。 */
  contextLines: Array<[number, number]>;
  anchor?: string;
  eof: boolean;
}

export type PatchAction =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; chunks: PatchChunk[] };

const beginMarker = "*** Begin Patch";
const endMarker = "*** End Patch";
const eofMarker = "*** End of File";
const moveMarker = "*** Move to: ";
const fileHeader = /^\*\*\* (Add|Delete|Update) File: (.*)$/;

/** 只解析补丁；路径原文交给内容操作检查和解析。 */
export function parsePatch(patch: string): PatchAction[] {
  const lines = patch.split(/\r\n|\n|\r/);
  let first = 0;
  let last = lines.length - 1;
  while (first <= last && lines[first]!.trim() === "") first++;
  while (last >= first && lines[last]!.trim() === "") last--;
  if (lines[first]?.trim() !== beginMarker || lines[last]?.trim() !== endMarker) {
    throw new Error(`补丁必须以 ${beginMarker} 开始并以 ${endMarker} 结束`);
  }

  const actions: PatchAction[] = [];
  const fail = (line: number, message: string): never => {
    throw new Error(`补丁第 ${line + 1} 行：${message}`);
  };
  let cursor = first + 1;
  while (cursor < last) {
    const header = fileHeader.exec(lines[cursor]!);
    if (!header) fail(cursor, "应为 Add File、Delete File 或 Update File 标记");
    const path = header![2]!;
    if (path.length === 0) fail(cursor, "文件路径不能为空");
    cursor++;

    if (header![1] === "Delete") {
      actions.push({ kind: "delete", path });
      continue;
    }
    if (header![1] === "Add") {
      const content: string[] = [];
      while (cursor < last && lines[cursor]!.startsWith("+")) {
        content.push(lines[cursor]!.slice(1) + "\n");
        cursor++;
      }
      actions.push({ kind: "add", path, content: content.join("") });
      continue;
    }

    const action: Extract<PatchAction, { kind: "update" }> = {
      kind: "update",
      path,
      chunks: [],
    };
    if (cursor < last && lines[cursor]!.startsWith(moveMarker)) {
      action.moveTo = lines[cursor]!.slice(moveMarker.length);
      if (action.moveTo.length === 0) fail(cursor, "移动目标不能为空");
      cursor++;
    }
    let chunk: PatchChunk | undefined;
    const finishChunk = () => {
      if (chunk && chunk.oldLines.length === 0 && chunk.newLines.length === 0) {
        fail(cursor, "编辑块不能为空");
      }
    };
    while (cursor < last && !fileHeader.test(lines[cursor]!)) {
      const line = lines[cursor]!;
      if (line === "@@" || line.startsWith("@@ ")) {
        finishChunk();
        chunk = { oldLines: [], newLines: [], contextLines: [], eof: false };
        if (line.length > 3) chunk.anchor = line.slice(3);
        action.chunks.push(chunk);
      } else if (line === eofMarker) {
        if (!chunk || chunk.eof) fail(cursor, "End of File 必须跟在一个编辑块后");
        finishChunk();
        chunk!.eof = true;
      } else {
        if (chunk?.eof) fail(cursor, "End of File 后的编辑块必须以 @@ 开始");
        const prefix = line[0] ?? " ";
        if (prefix !== " " && prefix !== "+" && prefix !== "-") {
          fail(cursor, "编辑行必须以空格、+ 或 - 开始");
        }
        if (!chunk) {
          chunk = { oldLines: [], newLines: [], contextLines: [], eof: false };
          action.chunks.push(chunk);
        }
        const text = line.slice(1);
        if (prefix === " ") {
          chunk.contextLines.push([chunk.oldLines.length, chunk.newLines.length]);
          chunk.oldLines.push(text);
          chunk.newLines.push(text);
        } else if (prefix === "-") {
          chunk.oldLines.push(text);
        } else {
          chunk.newLines.push(text);
        }
      }
      cursor++;
    }
    finishChunk();
    if (action.chunks.length === 0 && action.moveTo === undefined) {
      fail(cursor, "Update File 必须包含编辑内容或移动目标");
    }
    actions.push(action);
  }
  return actions;
}

interface SourceLine {
  text: string;
  ending: string;
}

interface Replacement {
  start: number;
  end: number;
  lines: string[];
}

function sourceLines(text: string): SourceLine[] {
  const result: SourceLine[] = [];
  let start = 0;
  for (const match of text.matchAll(/\r\n|\n|\r/g)) {
    result.push({ text: text.slice(start, match.index), ending: match[0] });
    start = match.index + match[0].length;
  }
  if (start < text.length) result.push({ text: text.slice(start), ending: "" });
  return result;
}

// 只用于比较；既不使用 NFKC，也不将转换后的内容写回文件。
function comparablePunctuation(text: string): string {
  return text
    .trim()
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, " ");
}

const comparisons = [
  (text: string) => text,
  (text: string) => text.trimEnd(),
  (text: string) => text.trim(),
  comparablePunctuation,
];

function locate(
  source: SourceLine[],
  pattern: string[],
  minimum: number,
  eof: boolean,
  description: string,
): number {
  const last = source.length - pattern.length;
  for (const compare of comparisons) {
    const expected = pattern.map(compare);
    let found: number | undefined;
    for (let start = eof ? Math.max(minimum, last) : minimum; start <= last; start++) {
      if (!expected.every((line, offset) => compare(source[start + offset]!.text) === line)) {
        continue;
      }
      if (found !== undefined) {
        throw new Error(`${description}匹配存在歧义：第 ${found + 1} 行和第 ${start + 1} 行；请增加上下文`);
      }
      found = start;
    }
    if (found !== undefined) return found;
  }
  const excerpt = pattern.slice(0, 3).join("\n").slice(0, 240);
  throw new Error(`${description}匹配失败${eof ? "（要求位于文件末尾）" : ""}：${JSON.stringify(excerpt)}`);
}

function changes(chunk: PatchChunk, start: number): Replacement[] {
  const replacements: Replacement[] = [];
  let oldStart = 0;
  let newStart = 0;
  const add = (oldEnd: number, newEnd: number) => {
    if (oldStart !== oldEnd || newStart !== newEnd) {
      replacements.push({
        start: start + oldStart,
        end: start + oldEnd,
        lines: chunk.newLines.slice(newStart, newEnd),
      });
    }
  };
  for (const [oldIndex, newIndex] of chunk.contextLines) {
    if (
      !Number.isInteger(oldIndex) || !Number.isInteger(newIndex) ||
      oldIndex < oldStart || newIndex < newStart ||
      oldIndex >= chunk.oldLines.length || newIndex >= chunk.newLines.length ||
      chunk.oldLines[oldIndex] !== chunk.newLines[newIndex]
    ) {
      throw new Error("编辑块的上下文下标无效或不按顺序排列");
    }
    add(oldIndex, newIndex);
    oldStart = oldIndex + 1;
    newStart = newIndex + 1;
  }
  add(chunk.oldLines.length, chunk.newLines.length);
  return replacements;
}

function nearbyEnding(source: SourceLine[], start: number, end: number): string {
  for (let index = start; index < end; index++) {
    if (source[index]!.ending) return source[index]!.ending;
  }
  for (let index = start - 1; index >= 0; index--) {
    if (source[index]!.ending) return source[index]!.ending;
  }
  for (let index = end; index < source.length; index++) {
    if (source[index]!.ending) return source[index]!.ending;
  }
  return "\n";
}

/**
 * 所有编辑块定位同一份原文，允许上下文重叠，拒绝实际编辑重叠或逆序。
 * 无旧行的块在文件末尾追加；具有 anchor 时紧接该行插入，eof 则明确追加。
 * 新末行继承编辑边界原有的终止状态；显式新增的空行保留其行分隔符。
 */
export function applyTextPatch(original: string, chunks: PatchChunk[]): string {
  const source = sourceLines(original);
  const replacements: Replacement[] = [];
  let minimum = 0;
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.oldLines.length === 0 && chunk.newLines.length === 0) {
      throw new Error(`第 ${index + 1} 个编辑块为空`);
    }
    let searchFrom = minimum;
    if (chunk.anchor !== undefined) {
      searchFrom = locate(source, [chunk.anchor], minimum, false, `第 ${index + 1} 个编辑块的锚点`) + 1;
    }
    const start = chunk.oldLines.length === 0
      ? chunk.anchor !== undefined && !chunk.eof ? searchFrom : source.length
      : locate(source, chunk.oldLines, searchFrom, chunk.eof, `第 ${index + 1} 个编辑块`);
    for (const replacement of changes(chunk, start)) {
      const previous = replacements.at(-1);
      if (previous && (
        replacement.start < previous.end ||
        (replacement.start === previous.start &&
          (replacement.start === replacement.end || previous.start === previous.end))
      )) {
        throw new Error(`第 ${index + 1} 个编辑块与此前的编辑范围重叠或顺序相反`);
      }
      replacements.push(replacement);
    }
    minimum = start;
  }

  const result: SourceLine[] = [];
  let cursor = 0;
  for (const replacement of replacements) {
    for (const line of source.slice(cursor, replacement.start)) result.push(line);
    const ending = nearbyEnding(source, replacement.start, replacement.end);
    const removed = source.slice(replacement.start, replacement.end);
    const finalEnding = replacement.end === source.length
      ? source.at(-1)?.ending ?? ending
      : removed.at(-1)?.ending || ending;
    for (const [index, text] of replacement.lines.entries()) {
      let lineEnding = index === replacement.lines.length - 1
        ? finalEnding
        : removed[index]?.ending || ending;
      if (text === "" && lineEnding === "") lineEnding = ending;
      result.push({ text, ending: lineEnding });
    }
    cursor = replacement.end;
  }
  for (const line of source.slice(cursor)) result.push(line);

  // EOF 追加会把原来没有终止符的末行移到中间，此时只补必要的行分隔。
  let previousEnding = source.find((line) => line.ending)?.ending ?? "\n";
  return result.map((line, index) => {
    const ending = line.ending || (index < result.length - 1 ? previousEnding : "");
    if (ending) previousEnding = ending;
    return line.text + ending;
  }).join("");
}
