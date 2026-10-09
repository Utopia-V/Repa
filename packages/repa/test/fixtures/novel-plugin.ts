import assert from "node:assert/strict";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { BackgroundCodec, PreparedBackground, WorkingMessage } from "../../src/agent/background.js";
import type { BackendPluginRegistration, CapabilityDefinition } from "../../src/capabilities/types.js";
import type { RepaCapabilityServices } from "../../src/capabilities/services.js";
import type { ContentFormat } from "../../src/content/formats.js";
import { mapReference } from "../../src/content/references.js";
import { ContentChangeResultSchema, ContentRefSchema } from "../../src/content/schema.js";
import { canonicalJson, type ContentStore } from "../../src/content/store.js";
import { RepaFault } from "../../src/errors.js";
import { object } from "../../src/schema.js";
import { digest } from "../../src/storage/blobs.js";

const BindingSchema = Type.Union([Type.Null(), ContentRefSchema]);
export const ViewSchema = object({ text: Type.String(), revision: Type.String(), ref: BindingSchema });
type View = Static<typeof ViewSchema>;
const ToolInputSchema = object({});
export const InputSchema = object({ kind: Type.Literal("current") });
const BindSchema = object({ ref: ContentRefSchema, operationId: Type.String() });
const marker = (view: View) => `<novel_background>\n${view.text}\n</novel_background>`;
export const novelCodec: BackgroundCodec = {
  id: "novelSetting", customType: "example.novel-setting",
  snapshot(message: WorkingMessage) {
    return message.role === "custom" && message.customType === this.customType &&
      Check(ViewSchema, message.details) && message.content === marker(message.details) ? message.details : undefined;
  },
};
export const novelFormat: ContentFormat = {
  id: "novel-setting", field: "novelSetting", default: null, schema: BindingSchema,
  references: value => Check(ContentRefSchema, value) ? [value] : [],
  files: () => [],
  remapMetadata: (value, mapping) => Check(ContentRefSchema, value) ? mapReference(value, mapping) : null,
  remapFile: bytes => bytes,
};
function prepared(value: unknown): PreparedBackground {
  if (!Check(ViewSchema, value)) throw new RepaFault("invalid_novel_view", "小说设定视图无效。");
  return {
    message: { role: "custom", customType: novelCodec.customType, content: marker(value), details: value, display: false, timestamp: Date.now() },
    revision: value.revision, text: value.text,
  };
}
async function view(content: ContentStore): Promise<View> {
  return content.observe(async scope => {
    const ref = scope.metadata(novelFormat.field);
    assert(Check(BindingSchema, ref));
    const text = ref ? new TextDecoder().decode((await scope.read(ref)).bytes) : "";
    return { ref, text, revision: digest(canonicalJson({ ref, text })) };
  });
}

/** 非学习领域使用同一内容关系、能力查询和背景消息，不建立第二份状态。 */
export function novelPlugin(options: {
  staticPreview?: boolean;
  beforeRead?(context: { signal: AbortSignal; source: unknown }): Promise<void>;
} = {}) {
  const state = { factories: 0, queries: 0, toolAdapters: 0, sources: [] as unknown[] };
  const preview: CapabilityDefinition<typeof InputSchema, typeof ViewSchema, RepaCapabilityServices, unknown, typeof ToolInputSchema> = {
    contract: { id: "example.novel.preview", version: "1" }, implementationId: "local",
    inputSchema: InputSchema, outputSchema: ViewSchema, scopes: ["space"], execution: "query",
    tool: { name: "novel_setting", description: "读取持续维护的小说设定。", input: {
      schema: ToolInputSchema, prepare() { state.toolAdapters++; return { kind: "current" as const }; },
    } },
    async invoke(input, context) {
      assert.deepEqual(input, { kind: "current" });
      assert(context.content);
      assert(context.services?.settings);
      state.queries++;
      state.sources.push(context.source);
      await options.beforeRead?.(context);
      context.signal.throwIfAborted();
      return view(context.content);
    },
  };
  const bind: CapabilityDefinition<typeof BindSchema, typeof ContentChangeResultSchema> = {
    contract: { id: "example.novel.bind", version: "1" }, implementationId: "local",
    inputSchema: BindSchema, outputSchema: ContentChangeResultSchema, scopes: ["space"], execution: "inline",
    async invoke(input, context) {
      assert(context.content);
      const before = await context.content.observe(async scope => scope.metadata(novelFormat.field));
      return context.content.setMetadata({ field: novelFormat.field, value: input.ref,
        base: digest(canonicalJson(before)), operationId: input.operationId, request: input });
    },
  };
  const registration: BackendPluginRegistration = {
    id: "novel", enabled: true, formats: [novelFormat],
    backgrounds: [{
      codec: novelCodec, selection: { contract: preview.contract, implementationId: "local" }, input: { kind: "current" }, prepare: prepared,
      ...(options.staticPreview ? { preview: { implementationId: "local", read: async (content: ContentStore) => prepared(await view(content)) } } : {}),
    }],
    factory() { state.factories++; return { capabilities: [preview, bind] }; },
  };
  return { registration, state };
}
