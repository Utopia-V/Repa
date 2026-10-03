import { Type, type Static } from "typebox";
import { object } from "../schema.js";

export const SummaryPromptsSchema = object({
  system: Type.Union([Type.String(), Type.Null()]),
  instructions: Type.Union([Type.String(), Type.Null()]),
});
export type SummaryPrompts = Static<typeof SummaryPromptsSchema>;
