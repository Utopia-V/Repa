import { parentPort, workerData } from "node:worker_threads";
import { Check } from "typebox/value";
import { Type } from "repa/plugin";
import { ExtractInputSchema, MAX_TEXT, type ExtractData } from "./schema.js";

const RequestSchema = Type.Object({
  kind: Type.Enum(["text", "html", "image"]), bytes: Type.Unknown(), encoding: Type.String(),
  range: ExtractInputSchema.properties.range, limit: ExtractInputSchema.properties.limit,
});
const input: unknown = workerData;
if (!Check(RequestSchema, input) || !(input.bytes instanceof Uint8Array)) throw new Error("材料解析 worker 输入无效。");
const kind = input.kind;
const bytes = input.bytes;
const range = input.range;
const limit = input.limit ?? 100;
const result: ExtractData = { status: "ready", kind, reader: { name: "utf-8" }, segments: [], truncated: false, issues: [] };
let remaining = MAX_TEXT;
function segment(text: string, value: unknown, format: string) {
  if (result.segments.length >= limit || remaining <= 0) { result.truncated = true; return; }
  const selected = text.slice(0, remaining);
  result.truncated ||= selected.length !== text.length;
  remaining -= selected.length;
  result.segments.push({ text: selected, locator: { format: { id: format, version: "1" }, value } });
}
parentPort?.postMessage({ progress: `正在解析 ${kind} 原件` });
try {
  if (kind === "image") {
    result.reader = { name: "image-size", version: "2.0.4" };
    const { imageSize } = await import("image-size");
    const info = imageSize(bytes);
    if (!Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) || info.width < 1 || info.height < 1)
      throw new Error("图片头没有有效的实际尺寸。");
    result.image = { format: info.type ?? "unknown", width: info.width, height: info.height,
      ...(info.orientation !== undefined ? { orientation: info.orientation } : {}) };
    result.total = 1;
  } else {
    // HTTP 原件使用响应声明的 charset；未声明与本地文件继续按 UTF-8，不猜测编码。
    const decoder = new TextDecoder(input.encoding, { fatal: true });
    const text = decoder.decode(bytes);
    if (text.includes("\0")) throw new Error("解码后的正文包含 NUL，不能作为文本读取。");
    if (kind === "text") {
      result.reader = { name: decoder.encoding, encoding: decoder.encoding };
      const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
      const start = range?.start ?? 1;
      const end = range?.end ?? lines.length;
      result.total = lines.length;
      for (let line = start; line <= Math.min(end, lines.length); line++) {
        if (result.segments.length >= limit || remaining <= 0) { result.truncated = true; break; }
        segment(lines[line - 1] ?? "", { line }, "repa.material.lines");
      }
    } else {
      const { JSDOM } = await import("jsdom");
      const { Readability } = await import("@mozilla/readability");
      result.reader = { name: "readability", version: "0.6.0", encoding: decoder.encoding };
      // 不启用脚本、子资源或网络抓取；只解析已保存的原件。
      const dom = new JSDOM(text);
      try {
        const article = new Readability(dom.window.document, { charThreshold: 0, maxElemsToParse: 100000 }).parse();
        if (article) {
          result.title = article.title ?? "";
          const selected = new JSDOM(article.content ?? "");
          try {
            const blocks = [...selected.window.document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,pre,li,blockquote")];
            let heading = "";
            const readable = blocks.filter(block => !block.parentElement?.closest("pre,li,blockquote"));
            result.total = readable.length;
            if (!readable.length && article.textContent?.trim()) {
              const content = article.textContent.trim();
              result.total = 1;
              segment(content, { block: 1, heading: "", quote: content.slice(0, 240) }, "repa.material.html");
            }
            for (let index = 0; index < readable.length; index++) {
              const block = readable[index];
              if (!block) continue;
              const content = (block.textContent ?? "").trim();
              if (!content) continue;
              if (/^H[1-6]$/.test(block.tagName)) heading = content;
              if (result.segments.length >= limit || remaining <= 0) { result.truncated = true; break; }
              // heading/quote 属于原件快照中的文本定位，不声称是原 HTML 字符偏移。
              segment(content, { block: index + 1, heading, quote: content.slice(0, 240) }, "repa.material.html");
            }
          } finally { selected.window.close(); }
        }
      } finally { dom.window.close(); }
    }
    if (!result.segments.length) result.status = "empty";
  }
} catch (error) {
  result.status = "invalid";
  result.segments = [];
  result.issues.push({ code: "invalid_material", message: error instanceof Error ? error.message : "原件不能由所选解析器处理。" });
}
parentPort?.postMessage(result);
