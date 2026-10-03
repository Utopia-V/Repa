import path from "node:path";
import { Type, type BackendPlugin, type CapabilityDefinition, type RepaCapabilityServices } from "repa/plugin";
import { RepaFault, type ProcessingResult } from "repa/protocol";
import { parse } from "./parser.js";
import { pdf } from "./poppler.js";
import { EXTRACT_CONTRACT, EXTRACT_FORMAT, ExtractInputSchema, ExtractOutputSchema, MAX_BYTES, type ExtractData } from "./schema.js";
export { EXTRACT_CONTRACT, EXTRACT_FORMAT, ExtractInputSchema, ExtractOutputSchema, ExtractDataSchema } from "./schema.js";
export type { ExtractInput, ExtractData } from "./schema.js";

const textExtensions = new Set([".txt", ".md", ".markdown", ".mdx", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rs", ".go", ".c", ".h", ".cpp", ".java", ".sh", ".css", ".json", ".yaml", ".yml", ".toml", ".xml", ".sql", ".csv"]);
function kind(mediaType: string, file: string, bytes: Uint8Array): ExtractData["kind"] {
  const extension = path.extname(file).toLowerCase();
  if (Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-" || mediaType === "application/pdf" || extension === ".pdf") return "pdf";
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType === "text/html" || [".html", ".htm"].includes(extension)) return "html";
  if (mediaType.startsWith("text/") || textExtensions.has(extension)) return "text";
  return "unknown";
}

export default function materials(): BackendPlugin<RepaCapabilityServices> {
  const extract: CapabilityDefinition<typeof ExtractInputSchema, typeof ExtractOutputSchema, RepaCapabilityServices> = {
    contract: EXTRACT_CONTRACT, implementationId: "local", inputSchema: ExtractInputSchema, outputSchema: ExtractOutputSchema,
    scopes: ["space"], execution: "background",
    tool: { name: "read_material", description: "读取关联材料的实际字节版本。支持原文行范围、本地 HTML 正文、PDF 页范围和图片信息，不修改原件或人工稿。" },
    async invoke(input, context): Promise<ProcessingResult> {
      if (!context.services?.resources) throw new RepaFault("capability_service", "材料读取需要真实父请求的资源快照服务。");
      context.signal.throwIfAborted();
      let snapshot: Awaited<ReturnType<typeof context.services.resources.snapshot>>;
      try {
        snapshot = await context.services.resources.snapshot({ target: input.target, maxBytes: MAX_BYTES,
          ...(input.expectedBodyRevision !== undefined ? { revision: input.expectedBodyRevision } : {}) });
      } catch (error) {
        context.signal.throwIfAborted();
        if (!(error instanceof RepaFault) || error.code !== "content_limit") throw error;
        const data: ExtractData = { status: "limit_exceeded", kind: "unknown", reader: { name: "none" }, segments: [], truncated: false,
          issues: [{ code: "input_limit", message: "原件超过本地材料读取的 32 MiB 限额，未提取正文。" }] };
        // 未读取字节就没有可确认的正文修订或资源，不为超限说明补读原件。
        return { format: EXTRACT_FORMAT, value: { kind: "inline", data }, sources: [], resources: [] };
      }
      context.signal.throwIfAborted();
      const selected = kind(snapshot.content.mediaType, snapshot.content.location.path, snapshot.bytes);
      if (input.range && (input.range.kind === "pages" ? selected !== "pdf" : selected !== "text"))
        throw new RepaFault("invalid_material_range", "所选局部范围不适用于该材料格式。");
      if (input.range?.end !== undefined && input.range.end < input.range.start)
        throw new RepaFault("invalid_material_range", "局部范围终点不能早于起点。");
      let data: ExtractData;
      if (selected === "unknown") data = { status: "unsupported", kind: selected, reader: { name: "none" }, segments: [], truncated: false,
        issues: [{ code: "unsupported_format", message: `没有适用于 ${snapshot.content.mediaType} 的本地读取器；原件资源继续可用。` }] };
      else if (selected === "pdf") {
        const settings = await context.services.settings("repa.materials");
        const setting = (key: string) => {
          const value = settings.entries.find(entry => entry.key === key)?.effective;
          if (typeof value !== "string" || !value) throw new RepaFault("configuration", `PDF 工具 ${key} 的配置无效。`);
          return value;
        };
        data = await pdf(snapshot.bytes, input, { pdfinfo: setting("pdfinfo"), pdftotext: setting("pdftotext") }, context.signal, context.services.progress);
      } else data = await parse(selected, snapshot.bytes, input, context.signal, context.services.progress);
      context.signal.throwIfAborted();
      const target = snapshot.content.ref ? { kind: "content" as const, ref: snapshot.content.ref } : snapshot.content.target;
      const revision = snapshot.content.bodyRevision;
      if (!revision) throw new RepaFault("revision_unavailable", "原件没有实际字节修订。");
      const source = { target, revision };
      return { format: EXTRACT_FORMAT, value: { kind: "inline", data },
        sources: data.segments.length ? data.segments.map(segment => ({ ...source, locator: segment.locator })) : [source],
        resources: [snapshot.resource] };
    },
  };
  return { capabilities: [extract], settings: [{ namespace: "repa.materials", settings: {
    pdfinfo: { schema: Type.String({ minLength: 1 }), default: "pdfinfo", scopes: ["application"] },
    pdftotext: { schema: Type.String({ minLength: 1 }), default: "pdftotext", scopes: ["application"] },
  } }] };
}
