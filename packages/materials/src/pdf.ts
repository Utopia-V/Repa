import path from "node:path";
import { fileURLToPath } from "node:url";

import { getDocumentProxy } from "unpdf";

import { ConversionFailure, type Converted, type MissingPage } from "./result.js";

// pdf.js 的 CMap 数据，取自与 unpdf 内置 pdf.js 同版本的 pdfjs-dist。中文 PDF 里不嵌入字体、按预定义 CMap（如 UniGB-UCS2-H、GBK-EUC-H）编码的文字，
// 没有它就读成空白。包根的 cmaps/ 在源码和构建产物的上一级。
const CMAP_DIRECTORY = `${fileURLToPath(new URL("../cmaps", import.meta.url))}${path.sep}`;

// 私用区字符、替换符与控制字符占到一页非空白字符的这个比例以上，这一页按乱码处理。比例是 Repa 的假设：
// 字体没有字符对照时 pdf.js 多半给出私用区字符，正常的中英文课件里这类字符几乎为零。
const GARBLED_SHARE = 0.3;
const GARBLED_CHARACTER = /[\uE000-\uF8FF\uFFFD\u0000-\u0008\u000E-\u001F]/gu;

function pageText(items: unknown[]): string {
  let text = "";
  for (const item of items) {
    if (typeof item !== "object" || item === null || !("str" in item) || typeof item.str !== "string") continue;
    text += item.str;
    if ("hasEOL" in item && item.hasEOL === true) text += "\n";
  }
  return text.replace(/[ \t]+$/gmu, "").replace(/\n{3,}/gu, "\n\n").trim();
}

function classify(text: string): string | MissingPage {
  const visible = text.replace(/\s/gu, "");
  if (visible === "") return { missing: "no_text" };
  const garbled = visible.match(GARBLED_CHARACTER)?.length ?? 0;
  if (garbled / visible.length >= GARBLED_SHARE) return { missing: "garbled" };
  return text;
}

function errorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "name" in error && typeof error.name === "string" ? error.name : undefined;
}

/** 逐页取出文字层。每读完一页检查一次取消，大文件中途停下时不留下半份结果。 */
export async function convertPdf(data: Uint8Array, signal: AbortSignal): Promise<Converted> {
  let document;
  try {
    document = await getDocumentProxy(data, {
      cMapUrl: CMAP_DIRECTORY,
      cMapPacked: true,
      // 只取文字，不渲染：不用系统字体，pdf.js 的警告（如缺字体）也不打到后端的输出里。
      useSystemFonts: false,
      verbosity: 0,
    });
  } catch (error) {
    if (errorName(error) === "PasswordException") throw new ConversionFailure("encrypted");
    throw new ConversionFailure("damaged", error instanceof Error ? error.message : String(error));
  }
  try {
    const parts: Array<string | MissingPage> = [];
    for (let number = 1; number <= document.numPages; number++) {
      signal.throwIfAborted();
      let content;
      try {
        const page = await document.getPage(number);
        content = await page.getTextContent();
        page.cleanup();
      } catch (error) {
        throw new ConversionFailure("damaged", `第 ${number} 页：${error instanceof Error ? error.message : String(error)}`);
      }
      parts.push(classify(pageText(content.items)));
    }
    const readable = parts.some((part) => typeof part === "string");
    if (!readable && parts.some((part) => typeof part !== "string" && part.missing === "garbled")) {
      return { status: "failed", format: "pdf", reason: "garbled" };
    }
    if (!readable) return { status: "failed", format: "pdf", reason: "scanned" };
    return { status: "text", format: "pdf", parts };
  } finally {
    await document.loadingTask.destroy();
  }
}
