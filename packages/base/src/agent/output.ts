import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";

interface ToolOutputLocation {
  root: string;
  sessionId: string;
  toolCallId: string;
}

/** 优先保留完整行；首尾一行本身超过预算时，退回 UTF-8 字符边界。 */
function headEnd(bytes: Buffer, maxBytes: number, maxLines: number): number {
  let end = Math.min(bytes.length, maxBytes);
  while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  const newline = bytes.lastIndexOf(0x0a, end - 1);
  if (newline >= 0) end = newline + 1;
  let lines = 0;
  for (let index = 0; index < end; index++) {
    if (bytes[index] === 0x0a && ++lines === maxLines) return index + 1;
  }
  return end;
}

function tailStart(bytes: Buffer, maxBytes: number, maxLines: number): number {
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  const newline = bytes.indexOf(0x0a, start);
  if (newline >= 0 && newline < bytes.length - 1) start = newline + 1;
  let lines = 0;
  for (let index = bytes.length - 1; index >= start; index--) {
    if (bytes[index] === 0x0a && ++lines === maxLines) return index + 1;
  }
  return start;
}

/** 超限结果保存原文，模型只接收首尾和可继续读取的空间相对路径。 */
export async function limitToolText(text: string, location: ToolOutputLocation): Promise<string> {
  const bytes = Buffer.from(text, "utf8");
  const totalLines = text.split("\n").length;
  if (bytes.length <= DEFAULT_MAX_BYTES && totalLines <= DEFAULT_MAX_LINES) return text;
  // 编号来自会话和服务商；编码路径分隔符，确保输出始终落在这个调用自己的文件中。
  const relative = `.repa/tool-output/${encodeURIComponent(location.sessionId)}/${encodeURIComponent(location.toolCallId)}.txt`;
  const file = path.join(location.root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  const end = headEnd(bytes, Math.floor(DEFAULT_MAX_BYTES * 0.6), Math.floor(DEFAULT_MAX_LINES * 0.6));
  const start = tailStart(bytes, Math.floor(DEFAULT_MAX_BYTES * 0.2), Math.floor(DEFAULT_MAX_LINES * 0.2));
  const omitted = bytes.subarray(end, start);
  const omittedLines = omitted.toString("utf8").split("\n").length;
  const notice = `[中间省略 ${omitted.length} 字节、${omittedLines} 行；全文在 ${relative}，可用 read 工具按行读取]`;
  return `${bytes.subarray(0, end).toString("utf8")}\n${notice}\n${bytes.subarray(start).toString("utf8")}`;
}
