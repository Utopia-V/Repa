import { Type, type Static } from "typebox";
import { object } from "../schema.js";

export const RangeSchema = object({
  start: Type.Integer({ minimum: 0 }),
  end: Type.Integer({ minimum: 0 }),
});
export type Range = Static<typeof RangeSchema>;

export const TextSnippetSchema = object({
  text: Type.String(),
  range: RangeSchema,
  truncated: Type.Boolean(),
});
export type TextSnippet = Static<typeof TextSnippetSchema>;

export const HistorySearchMatchSchema = object({
  messageId: Type.String(),
  blockIndex: Type.Integer({ minimum: 0 }),
  line: Type.Integer({ minimum: 1 }),
  range: RangeSchema,
  snippet: TextSnippetSchema,
});
export type HistorySearchMatch = Static<typeof HistorySearchMatchSchema>;
