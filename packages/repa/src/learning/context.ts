import { Check } from "typebox/value";
import { RepaFault } from "../errors.js";
import { digest } from "../storage/blobs.js";
import { canonicalJson, type ContentStore } from "../content/store.js";
import type { ContentChangeResult, ContentRef } from "../content/schema.js";
import { contextBinding } from "./content-format.js";
import { ContextCompositionSchema, type ContextBinding, type ContextMember, type ContextState, type ContextView } from "./schema.js";

/** 官方学习语境解释选择与组成，保存和完整读取继续使用共同内容入口。 */
export class LearningContext {
  constructor(readonly content: ContentStore) {}

  get(): Promise<ContextState> {
    return this.content.observe(async (scope) => {
      const binding = contextBinding(scope.metadata("context"));
      return { binding, revision: digest(canonicalJson(binding)) };
    });
  }

  set(params: { binding: ContextBinding; base: string; operationId: string }): Promise<ContentChangeResult> {
    const input = structuredClone(params);
    return this.content.setMetadata({
      field: "context", value: input.binding, base: input.base, operationId: input.operationId,
      request: { method: "context", ...input },
    });
  }

  preview(): Promise<ContextView> {
    return this.content.observe(async (scope) => {
      const binding = contextBinding(scope.metadata("context"));
      const sources: ContextView["sources"] = [];
      const read = async (ref: ContentRef): Promise<string> => {
        const observed = await scope.read(ref);
        if (!observed.bytes || !observed.content.bodyRevision)
          throw new RepaFault("context_unavailable", "语境成员没有可读取的正文。", { ref });
        sources.push({ ref, revision: observed.content.bodyRevision });
        try { return new TextDecoder("utf-8", { fatal: true }).decode(observed.bytes); }
        catch { throw new RepaFault("unsupported_format", "该语境成员需要明确的文本表示。", { ref }); }
      };
      let text = "";
      if (binding?.kind === "document") text = await read(binding.ref);
      else if (binding) {
        const body = await read(binding.ref);
        let data: unknown;
        try { data = JSON.parse(body); } catch { throw new RepaFault("invalid_context", "语境组成清单不是有效 JSON。"); }
        if (!Check(ContextCompositionSchema, data)) throw new RepaFault("invalid_context", "语境组成清单格式无效。");
        const parts: string[] = [];
        const member = async (item: ContextMember) => {
          const label = item.title ?? item.ref.id;
          if (item.mode === "expand") parts.push(`## ${label}\n${await read(item.ref)}`);
          else {
            const info = await scope.describe(item.ref);
            parts.push(`## ${label}\nrepa:${info.role}/${item.ref.id}`);
          }
          if (item.note) parts.push(item.note);
        };
        for (const item of data.items) {
          if ("items" in item) {
            parts.push(`# ${item.title}`);
            for (const child of item.items) await member(child);
          } else await member(item);
        }
        text = parts.join("\n\n");
      }
      return { text, sources, revision: digest(canonicalJson({ text, sources })) };
    });
  }
}
