import path from "node:path";
import { createEditToolDefinition, defineTool, generateDiffString, generateUnifiedPatch, withFileMutationQueue, type ToolDefinition } from "@earendil-works/pi-coding-agent";

/** 编辑时读写文件的入口；调用方在这里检查路径范围，并把写回接到空间的写入路径。 */
export interface EditFiles {
  /** 检查路径范围，返回解析后的绝对路径。 */
  resolve(file: string): Promise<string>;
  read(file: string): Promise<Buffer>;
  /**
   * 写回编辑结果。before 是这次编辑在文件队列里读到的原始字节，写入前核对磁盘上仍是它。
   * unseen 表示 before 里有这个会话上次读取之后别人做的改动。
   */
  write(file: string, before: Buffer, after: string): Promise<{ unseen: boolean }>;
}

// 编辑叠在别人的改动上时附在结果后面，意思与 Claude Code 的同类提示相同：编辑已经生效，但文件里有模型没看过的内容。
const UNSEEN_CHANGES = "注意：这个文件自上次读取后还有其他改动。编辑已按原文应用，但文件里有你没看过的内容；要做依赖上下文的修改，先重新读取。";

/**
 * 保留 Pi 的参数与展示，只替换编辑步骤。Pi 1.1.0 的 core/tools/edit-diff.js 在精确匹配失败时，
 * 通过 normalizeForFuzzyMatch 和 applyEditsToNormalizedContent 做模糊匹配，并从规范化后的文本重写命中的整行。
 * 中文段落常常就是一整行，NFKC 会把全角的，：；（）！？变成半角，弯引号替换会把“”变成英文引号；
 * 同一行的破折号、特殊空格和行尾空白也会改变。此外，Pi 的 edit 会统一全文换行，混合换行无法原样保留。
 * 因此这里仅按原文精确替换，升级 Pi 时核对上述步骤；上游能保留这些原文后，再判断是否复用。
 * 和 Pi 的 edit 一样在同一文件的写入队列里读出、替换、写回，所以这个进程里的其他写入者改过的内容
 * 都会先被读到；锚文本还在就照常应用。
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
        const { unseen } = await files.write(file, original, after);
        const diff = generateDiffString(before, after);
        return {
          content: [{ type: "text" as const, text: unseen ? `已精确编辑 ${input.path}。${UNSEEN_CHANGES}` : `已精确编辑 ${input.path}` }],
          details: { diff: diff.diff, patch: generateUnifiedPatch(input.path, before, after), firstChangedLine: diff.firstChangedLine },
        };
      });
    },
  });
}
