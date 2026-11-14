import { open } from "node:fs/promises";

import { COMPOUND_FILE_SIGNATURE } from "./compound-file.js";
import { convertCompoundFile } from "./office-binary.js";
import { convertOoxml } from "./ooxml.js";
import { convertPdf } from "./pdf.js";
import { ConversionFailure, PICTURE, type Converted } from "./result.js";

/** 看文件头分出的种类。前三种交给转换；text 是可以直接用 read 读的文字文件；other 是读不出文字的格式。 */
export type Container = "pdf" | "zip" | "compound" | "text" | "other";

const SNIFF_BYTES = 8192;
const ZIP_SIGNATURE = Uint8Array.of(0x50, 0x4b, 0x03, 0x04);

function startsWith(bytes: Uint8Array, signature: Uint8Array): boolean {
  return bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
}

/** 按开头的字节分辨格式，不看扩展名，所以改错扩展名的文件照样能读。 */
export async function sniff(file: string): Promise<Container> {
  const handle = await open(file, "r");
  let head: Uint8Array;
  try {
    const buffer = new Uint8Array(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    head = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  // PDF 规范允许文件头前有少量别的字节，pdf.js 也接受，在开头 1 KiB 内找。
  if (new TextDecoder("latin1").decode(head.subarray(0, 1024)).includes("%PDF-")) return "pdf";
  if (startsWith(head, ZIP_SIGNATURE)) return "zip";
  if (startsWith(head, COMPOUND_FILE_SIGNATURE)) return "compound";
  if (head.includes(0)) return "other";
  try {
    // stream: true 让截在 8 KiB 边界上的半个字符不算错。
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    return "text";
  } catch {
    return "other";
  }
}

let conversions = 0;

/** 本进程里实际解析文件的次数，测试用它确认缓存命中时不再解析。 */
export function conversionCount(): number {
  return conversions;
}

/**
 * 把一个文件的内容转成按页、张或段排列的文字。读不出文字的各种情形都变成 failed 结果，包括解析库抛出的任何错误：
 * 一份坏文件只让这一份读不了。取消不在其列，照常抛出。
 */
export async function convert(data: Uint8Array, container: "pdf" | "zip" | "compound", signal: AbortSignal): Promise<Converted> {
  conversions += 1;
  try {
    switch (container) {
      case "pdf":
        return await convertPdf(data, signal);
      case "zip":
        return emptyAsFailure(convertOoxml(data));
      case "compound":
        return emptyAsFailure(convertCompoundFile(data));
    }
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof ConversionFailure) return { status: "failed", reason: error.reason, ...(error.detail === undefined ? {} : { detail: error.detail }) };
    return { status: "failed", reason: "damaged", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** 幻灯片和 Word 文档里除了图片标记没有一个字时，按没有文字处理，不交回一串 [图片]。 */
function emptyAsFailure(result: Converted): Converted {
  if (result.status === "text" && result.parts.every((part) => typeof part !== "string" || part.replaceAll(PICTURE, "").trim() === "")) {
    return { status: "failed", format: result.format, reason: "no_text" };
  }
  return result;
}
