import path from "node:path";
import { RepaFault } from "repa/protocol";
import type { RepaCapabilityServices } from "repa/plugin";
import { parse } from "./parser.js";
import { pdf } from "./poppler.js";
import type { ExtractData, ExtractOptions } from "./schema.js";

const textExtensions = new Set([".txt", ".md", ".markdown", ".mdx", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rs", ".go", ".c", ".h", ".cpp", ".java", ".sh", ".css", ".json", ".yaml", ".yml", ".toml", ".xml", ".sql", ".csv"]);
function kind(mediaType: string, file: string, bytes: Uint8Array): ExtractData["kind"] {
  mediaType = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const extension = path.extname(file).toLowerCase();
  if (Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-" || mediaType === "application/pdf" || extension === ".pdf") return "pdf";
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType === "text/html" || [".html", ".htm"].includes(extension)) return "html";
  if (mediaType.startsWith("text/") || mediaType === "application/json" || /^application\/[^;]+\+json$/u.test(mediaType) || textExtensions.has(extension)) return "text";
  return "unknown";
}

/** 文件、固定资源与 HTTP 原件使用相同读取器；格式判断不改变来源的 mediaType。 */
export async function extractBytes(bytes: Uint8Array, mediaType: string, file: string, input: ExtractOptions,
  signal: AbortSignal, services: RepaCapabilityServices, encoding?: string): Promise<ExtractData> {
  const selected = kind(mediaType, file, bytes);
  if (input.range && (input.range.kind === "pages" ? selected !== "pdf" : selected !== "text"))
    throw new RepaFault("invalid_material_range", "所选局部范围不适用于该材料格式。");
  if (input.range?.end !== undefined && input.range.end < input.range.start)
    throw new RepaFault("invalid_material_range", "局部范围终点不能早于起点。");
  if (selected === "unknown") return {
    status: "unsupported", kind: selected, reader: { name: "none" }, segments: [], truncated: false,
    issues: [{ code: "unsupported_format", message: `没有适用于 ${mediaType} 的本地读取器；原件资源继续可用。` }],
  };
  if (selected !== "pdf") {
    const charset = /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(mediaType);
    return parse(selected, bytes, input, signal, services.progress, encoding ?? charset?.[1] ?? charset?.[2] ?? "utf-8");
  }
  const settings = await services.settings("repa.materials");
  const setting = (key: string) => {
    const value = settings.entries.find(entry => entry.key === key)?.effective;
    if (typeof value !== "string" || !value) throw new RepaFault("configuration", `PDF 工具 ${key} 的配置无效。`);
    return value;
  };
  return pdf(bytes, input, { pdfinfo: setting("pdfinfo"), pdftotext: setting("pdftotext") }, signal, services.progress);
}
