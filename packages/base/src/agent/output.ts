import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";

/** 给省略提示预留字节和两行；超长单行沿 Pi 的语义整行省略。 */
export function limitToolText(text: string): string {
  if (!truncateHead(text).truncated) return text;
  const result = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES - 512, maxLines: DEFAULT_MAX_LINES - 2 });
  const notice = `[已省略 ${result.totalBytes - result.outputBytes} 字节、${result.totalLines - result.outputLines} 行；请缩小查询范围，或使用原工具的分页参数继续读取。]`;
  return `${result.content}\n\n${notice}`;
}
