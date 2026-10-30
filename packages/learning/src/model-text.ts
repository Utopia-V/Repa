/**
 * 把课程内容写成给模型看的分行文字，模型核对（check/confirm.ts）和辅导（tutor-text.ts）共用：
 * 代码块用围栏写出，带 startLine 的每行前写行号，图像只写说明文字。
 */
import type { Block, Content } from "@repa/base/protocol";

/** 代码块带 startLine 时，每行前面写上行号，题面里说“第 3 行”才对得上。 */
function numberedCode(block: Extract<Block, { type: "code" }>): string {
  const text = block.text.replace(/\n$/, "");
  if (block.startLine === undefined) return text;
  const lines = text.split("\n");
  const start = block.startLine;
  const width = String(start + lines.length - 1).length;
  return lines.map((line, index) => `${String(start + index).padStart(width)} | ${line}`).join("\n");
}

/** 内容块依次写出，块之间空一行。 */
export function contentText(content: Content | undefined): string {
  return (content ?? []).map((block) => {
    if (block.type === "markdown") return block.text;
    if (block.type === "code") return `\`\`\`${block.language}\n${numberedCode(block)}\n\`\`\``;
    return `[图：${block.alt}]`;
  }).join("\n\n");
}

/** 列表里的一项：一行文字写在开头后面；多行文字（例如多行代码）原样缩进排在开头下面。 */
export function entryText(head: string, text: string): string {
  if (!text.includes("\n")) return `${head}${text}`;
  return `${head.trimEnd()}\n${text.split("\n").map((line) => (line === "" ? "" : `  ${line}`)).join("\n")}`;
}
