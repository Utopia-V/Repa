import { parse, postprocess, preprocess } from "micromark";
import type { ContentRef } from "./schema.js";

export interface ReferenceMapping {
  fromSpace: string;
  toSpace: string;
  ids: ReadonlyMap<string, string>;
}
export function mapReference(ref: ContentRef, mapping: ReferenceMapping): ContentRef {
  if (ref.spaceId !== mapping.fromSpace) return ref;
  return { spaceId: mapping.toSpace, id: mapping.ids.get(ref.id) ?? ref.id };
}

/** 只改 CommonMark 确认为链接目标的区间，正文、代码与换行保留原字节形式。 */
export function remapMarkdown(text: string, ids: ReadonlyMap<string, string>): string {
  const edits: { start: number; end: number; value: string }[] = [];
  for (const [kind, token] of postprocess(parse().document().write(preprocess()(text, undefined, true)))) {
    if (kind !== "enter" || !["resourceDestinationString", "definitionDestinationString", "autolinkProtocol"].includes(token.type)) continue;
    const raw = text.slice(token.start.offset, token.end.offset);
    const match = /^repa:(document|material)\/([a-zA-Z0-9_-]+)([?#].*)?$/s.exec(raw);
    const id = match && ids.get(match[2]!);
    if (id && id !== match![2]) edits.push({ start: token.start.offset, end: token.end.offset, value: `repa:${match![1]}/${id}${match![3] ?? ""}` });
  }
  let result = text;
  for (const edit of edits.sort((a,b) => b.start-a.start)) result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  return result;
}
