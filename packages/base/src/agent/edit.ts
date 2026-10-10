import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createEditToolDefinition, defineTool, generateDiffString, generateUnifiedPatch, type ToolDefinition } from "@earendil-works/pi-coding-agent";

/** 保留 Pi 的参数与展示，只替换会规范化全文的编辑步骤。 */
export function exactEditTool(cwd: string): ToolDefinition {
  const builtin = createEditToolDefinition(cwd);
  return defineTool({
    ...builtin,
    async execute(_callId, input, signal) {
      signal?.throwIfAborted();
      const file = path.resolve(cwd, input.path);
      const before = await readFile(file, "utf8");
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
      await writeFile(file, after, "utf8");
      const diff = generateDiffString(before, after);
      return {
        content: [{ type: "text" as const, text: `已精确编辑 ${input.path}` }],
        details: { diff: diff.diff, patch: generateUnifiedPatch(input.path, before, after), firstChangedLine: diff.firstChangedLine },
      };
    },
  });
}
