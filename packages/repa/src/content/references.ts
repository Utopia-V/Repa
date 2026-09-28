import { parse, postprocess, preprocess } from "micromark";
import { Check } from "typebox/value";
import { ContextCompositionSchema, type ContentRef } from "./schema.js";

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

/** 组成格式由语境能力拥有；这里只映射该已知格式中的明确内容引用。 */
export function remapContextComposition(bytes: Buffer, mapping: ReferenceMapping): Buffer {
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString("utf8")); } catch { return bytes; }
  if (!Check(ContextCompositionSchema, raw)) return bytes;
  const before = JSON.stringify(raw);
  for (const item of raw.items) {
    if ("items" in item) for (const child of item.items) child.ref = mapReference(child.ref, mapping);
    else item.ref = mapReference(item.ref, mapping);
  }
  return JSON.stringify(raw) === before ? bytes : Buffer.from(`${JSON.stringify(raw, null, 2)}\n`);
}
