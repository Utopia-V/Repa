import path from "node:path";
import { createEditToolDefinition, defineTool, generateDiffString, generateUnifiedPatch, withFileMutationQueue, type ToolDefinition } from "@earendil-works/pi-coding-agent";

/** 编辑时读写文件的入口；调用方在这里检查路径范围，并把写回接到空间的写入路径。 */
export interface EditFiles {
  /** 检查路径范围，返回解析后的绝对路径。 */
  resolve(file: string): Promise<string>;
  read(file: string): Promise<Buffer>;
  /** 写回编辑结果。before 是这次编辑在文件队列里读到的原始字节，写入前核对磁盘上仍是它。 */
  write(file: string, before: Buffer, after: string): Promise<void>;
}

/**
 * 保留 Pi 的参数与展示，只替换会规范化全文的编辑步骤。和 Pi 的 edit 一样在同一文件的写入队列里读出、替换、写回，
 * 所以这个进程里的其他写入者改过的内容都会先被读到；锚文本还在就照常应用。
 */
export function exactEditTool(cwd: string, files: EditFiles): ToolDefinition {
  const builtin = createEditToolDefinition(cwd);
  return defineTool({
    ...builtin,
    async execute(_callId, input, signal) {
      signal?.throwIfAborted();
      const file = await files.resolve(path.resolve(cwd, input.path));
      return withFileMutationQueue(file, async () => {
        const original = await files.read(file);
        const before = original.toString("utf8");
        const replacements = input.edits.map(edit => {
          if (edit.oldText.length === 0) throw new Error("oldText 不得为空");
          const start = before.indexOf(edit.oldText);
          if (start < 0) throw new Error("未找到精确匹配的原文");
          if (before.indexOf(edit.oldText, start + 1) >= 0) throw new Error("原文出现多次，请提供唯一匹配");
          return { start, end: start + edit.oldText.length, text: edit.newText };
        }).sort((a, b) => a.start - b.start);
        for (let index = 1; index < replacements.length; index++) {
          const previous = replacements[index - 1];
          const current = replacements[index];
          if (previous && current && previous.end > current.start) throw new Error("编辑范围重叠");
        }
        let after = before;
        for (const edit of replacements.toReversed()) after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
        if (after === before) throw new Error("编辑没有改变文件");
        signal?.throwIfAborted();
        await files.write(file, original, after);
        const diff = generateDiffString(before, after);
        return {
          content: [{ type: "text" as const, text: `已精确编辑 ${input.path}` }],
          details: { diff: diff.diff, patch: generateUnifiedPatch(input.path, before, after), firstChangedLine: diff.firstChangedLine },
        };
      });
    },
  });
}
