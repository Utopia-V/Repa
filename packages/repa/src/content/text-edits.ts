import { RepaFault } from "../errors.js";

export interface TextEdit { oldText: string; newText: string }
interface Replacement { start: number; end: number; text: string }

function apply(source: string, changes: Replacement[]): string {
  let result = source;
  for (const change of [...changes].sort((a, b) => b.start - a.start))
    result = result.slice(0, change.start) + change.text + result.slice(change.end);
  return result;
}

export function editText(source: string, edits: TextEdit[]): string {
  const replacements = edits.map(({ oldText, newText }) => {
    if (!oldText) throw new RepaFault("invalid_input", "待替换文本不能为空。");
    const first = source.indexOf(oldText);
    if (first < 0)
      throw new RepaFault("match_failed", "当前文件中没有匹配的文本，请按需重新读取。");
    const next = source.indexOf(oldText, first + 1);
    if (next >= 0)
      throw new RepaFault("ambiguous_match", "待替换文本存在多个位置，请提供明确上下文。", {
        positions: [first, next],
      });
    return { start: first, end: first + oldText.length, text: newText };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < replacements.length; i++)
    if (replacements[i]!.start < replacements[i - 1]!.end)
      throw new RepaFault("ambiguous_match", "同一次编辑中的替换范围重叠。");
  return apply(source, replacements);
}

function replacements(before: string, after: string): Replacement[] {
  const split = (text: string) => text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  const left = split(before), right = split(after);
  const occurrences = (lines: string[]) => {
    const indices = new Map<string, number[]>();
    lines.forEach((line, index) => indices.set(line, [...indices.get(line) ?? [], index]));
    return indices;
  };
  const a = occurrences(left), b = occurrences(right);
  const pairs = left.flatMap((line, index) => a.get(line)!.length === 1 && b.get(line)?.length === 1
    ? [{ left: index, right: b.get(line)![0]! }] : []);
  // Only unique unchanged lines whose ordering is unambiguous serve as anchors.
  // Repeated or reordered regions remain whole changes, rather than guessing a diff alignment.
  const suffixMinimum = new Array<number>(pairs.length + 1).fill(Infinity);
  for (let i = pairs.length - 1; i >= 0; i--)
    suffixMinimum[i] = Math.min(suffixMinimum[i + 1]!, pairs[i]!.right);
  let maximum = -1;
  const anchors = pairs.filter((pair, index) => {
    const safe = pair.right > maximum && pair.right < suffixMinimum[index + 1]!;
    maximum = Math.max(maximum, pair.right);
    return safe;
  });
  const offsets = [0];
  for (const line of left) offsets.push(offsets.at(-1)! + line.length);
  const result: Replacement[] = [];
  let from = 0, to = 0;
  for (const anchor of [...anchors, { left: left.length, right: right.length }]) {
    const original = left.slice(from, anchor.left).join("");
    const text = right.slice(to, anchor.right).join("");
    if (original !== text) result.push({ start: offsets[from]!, end: offsets[anchor.left]!, text });
    from = anchor.left + 1;
    to = anchor.right + 1;
  }
  return result;
}

/** Apply the inverse change only where later edits can be kept separately. */
export function revertText(before: string, after: string, current: string): string {
  if (after === current) return before;
  const inverse = replacements(after, before);
  const later = replacements(after, current);
  for (const undo of inverse) {
    for (const change of later) {
      const overlap = undo.start === undo.end
        ? undo.start >= change.start && undo.start <= change.end
        : change.start === change.end
          ? change.start >= undo.start && change.start <= undo.end
          : undo.start < change.end && change.start < undo.end;
      if (overlap)
        throw new RepaFault("revision_conflict", "撤回范围与后续修改重叠，请查看差异后处理。");
    }
  }
  return apply(current, inverse.map((undo) => {
    const shift = later.filter((change) => change.end <= undo.start)
      .reduce((sum, change) => sum + change.text.length - (change.end - change.start), 0);
    return { ...undo, start: undo.start + shift, end: undo.end + shift };
  }));
}
