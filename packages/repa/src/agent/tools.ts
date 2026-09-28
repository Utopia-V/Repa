import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  formatSize,
  generateDiffString,
  generateUnifiedPatch,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RepaFault } from "../errors.js";
import type { ContentChangeResult, ContentInfo } from "../content/schema.js";
import type { ContentStore } from "../content/store.js";

const patchParameters = Type.Object({
  patch: Type.String({ description: "A patch enclosed by *** Begin Patch and *** End Patch. Use Add File, Delete File, Update File, Move to, and @@ context hunks." }),
});

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RepaFault("cancelled", "工具执行已取消。");
}

async function enabledSkillRoots(loader: ResourceLoader): Promise<string[]> {
  const roots = await Promise.all(loader.getSkills().skills.map(async (skill) => {
    try { return await realpath(skill.baseDir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }));
  return [...new Set(roots.filter((root): root is string => root !== undefined))];
}

/** 参数与展示复用 Pi；文件权限、定位、基准检查和提交由内容模块负责。 */
export async function createContentTools(
  learnerSpace: string,
  content: ContentStore,
  loader: ResourceLoader,
  observer?: {
    recordRead(info: ContentInfo, bytes: Buffer, complete: boolean): void;
    recordSaved(result: ContentChangeResult): Promise<void>;
  },
): Promise<ToolDefinition<any, any>[]> {
  const observedBodies = new Map<string, string>();
  const absolute = (info: ContentInfo) => info.location.kind === "external"
    ? info.location.path
    : path.resolve(learnerSpace, info.location.path);
  const keys = (info: ContentInfo): string[] => [
    `file:${absolute(info)}`,
    ...(info.ref ? [`content:${info.ref.spaceId}:${info.ref.id}`] : []),
  ];
  const remember = (info: ContentInfo) => {
    for (const key of keys(info)) {
      if (info.bodyRevision) observedBodies.set(key, info.bodyRevision);
      else if (key.startsWith("content:")) observedBodies.delete(key);
    }
  };
  const rememberSaved = (result: ContentChangeResult) => {
    for (const info of result.contents) remember(info);
    for (const change of result.changes) {
      const key = `file:${path.resolve(learnerSpace, change.path)}`;
      if (change.after) observedBodies.set(key, change.after);
      else observedBodies.delete(key);
    }
  };
  const savedDetails = (result: ContentChangeResult, singleFile = false) => ({
    ...result,
    ...(singleFile
      ? { bodyRevision: result.changes[0]?.after ?? result.contents.find((info) => info.bodyRevision)?.bodyRevision ?? null }
      : result.changes.length === 1
      ? { bodyRevision: result.changes[0]!.after }
      : result.contents.length === 1 ? { bodyRevision: result.contents[0]!.bodyRevision ?? null } : {}),
    bodyRevisions: Object.fromEntries(result.changes.map((change) => [change.path, change.after])),
  });
  const safeRead = createReadToolDefinition(learnerSpace);
  const read: ToolDefinition<typeof safeRead.parameters, any> = {
    ...safeRead,
    description: `${safeRead.description} Also accepts repa:document/<id> and repa:material/<id> references. Reads learning-space content and resources of currently enabled skills.`,
    executionMode: "sequential",
    async execute(callId, parameters, signal, onUpdate, ctx) {
      checkCancelled(signal);
      for (const value of [parameters.offset, parameters.limit]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
          throw new RepaFault("invalid_input", "offset 和 limit 必须为正整数。");
      }
      const roots = await enabledSkillRoots(loader);
      checkCancelled(signal);
      // 先解析原始引用；Pi 随后的路径处理只用于格式化，所有 ops 共用这份快照。
      const snapshot = await content.readForTool(parameters.path, roots);
      checkCancelled(signal);
      const mimeType = /^image\/(?:png|jpeg|jpg|gif|webp|bmp)$/.test(snapshot.content.mediaType)
        ? snapshot.content.mediaType : undefined;
      const formatter = createReadToolDefinition(learnerSpace, {
        operations: {
          access: async () => {},
          readFile: async () => snapshot.bytes,
          detectImageMimeType: async () => mimeType,
        },
      });
      const result = await formatter.execute(callId, { ...parameters, path: absolute(snapshot.content) }, signal, onUpdate, ctx);
      checkCancelled(signal);
      if (result.details?.truncation?.firstLineExceedsLimit) {
        // Pi 的默认建议依赖 bash；此工具组合只提供内容操作。
        const truncation = result.details.truncation;
        result.content = [{ type: "text", text: `第 ${parameters.offset ?? 1} 行超过 ${formatSize(truncation.maxBytes)} 读取限制，未返回这一行的正文。可使用 offset 读取其他行；局部修改可通过 edit 提供准确且唯一的文本片段。` }];
      }
      remember(snapshot.content);
      const fullRange = (parameters.offset ?? 1) === 1 &&
        (parameters.limit === undefined || parameters.limit >= snapshot.bytes.toString("utf8").split("\n").length);
      observer?.recordRead(snapshot.content, snapshot.bytes, fullRange && !result.details?.truncation?.truncated);
      return {
        ...result,
        details: { ...result.details, path: parameters.path, content: snapshot.content, bodyRevision: snapshot.content.bodyRevision },
      };
    },
  };

  const piWrite = createWriteToolDefinition(learnerSpace);
  const write: ToolDefinition<typeof piWrite.parameters, any> = {
    ...piWrite,
    description: "Create a file or replace its complete contents. Existing files must first be observed with read in this tool session; reading the relevant portion is sufficient. Saving fails if the body changed since that observation. Parent directories are created as part of the saved operation. Paths may be relative, absolute, or repa:document/<id> references.",
    executionMode: "sequential",
    async execute(_callId, parameters, signal) {
      checkCancelled(signal);
      const target = content.target(parameters.path);
      const current = await content.get(target);
      checkCancelled(signal);
      const base = current.bodyRevision === null || current.status === "missing"
        ? { kind: "absent" as const }
        : keys(current).map((key) => observedBodies.get(key)).find((value) => value !== undefined);
      if (base === undefined)
        throw new RepaFault("read_required", "覆盖既有文件前，请先用 read 读取相关部分，以取得保存基准。", { path: parameters.path });
      const result = await content.write({
        target,
        value: { kind: "text", text: parameters.content },
        base,
        operationId: randomUUID(),
      });
      // 提交后等待内容操作收尾；取消不把已经保存的结果改报为未保存。
      rememberSaved(result);
      await observer?.recordSaved(result);
      const saved = result.contents.find((info) => info.bodyRevision && info.status === "available");
      if (saved) observer?.recordRead(saved, Buffer.from(parameters.content), true);
      return {
        content: [{ type: "text", text: `已向 ${parameters.path} 保存 ${Buffer.byteLength(parameters.content)} 字节。` }],
        details: savedDetails(result, true),
      };
    },
  };

  const piEdit = createEditToolDefinition(learnerSpace);
  const edit: ToolDefinition<typeof piEdit.parameters, any> = {
    name: piEdit.name,
    label: piEdit.label,
    description: `${piEdit.description} A prior read of the complete file is not required. Paths may also be repa:document/<id> references.`,
    parameters: piEdit.parameters,
    promptSnippet: piEdit.promptSnippet,
    promptGuidelines: piEdit.promptGuidelines,
    prepareArguments: piEdit.prepareArguments,
    constrainedSampling: piEdit.constrainedSampling,
    executionMode: "sequential",
    // Pi 的 renderCall 会自行读取磁盘生成预览；这里只展示已提交的实际差异。
    renderResult: piEdit.renderResult,
    async execute(_callId, parameters, signal) {
      checkCancelled(signal);
      if (!parameters.edits.length)
        throw new RepaFault("invalid_input", "edit 至少需要一个替换片段。");
      const result = await content.edit({
        target: content.target(parameters.path),
        edits: parameters.edits,
        operationId: randomUUID(),
      });
      rememberSaved(result);
      await observer?.recordSaved(result);
      const change = result.changes[0];
      let diff: { diff: string; patch: string; firstChangedLine?: number } = { diff: "", patch: "" };
      let diffError: string | undefined;
      if (change?.before && change.after) {
        try {
          const [before, after] = await Promise.all([content.blobs.get(change.before), content.blobs.get(change.after)]);
          const display = generateDiffString(before.toString("utf8"), after.toString("utf8"));
          diff = { ...display, patch: generateUnifiedPatch(change.path, before.toString("utf8"), after.toString("utf8")) };
        } catch (error) {
          diffError = error instanceof Error ? error.message : String(error);
        }
      }
      const summary = result.changes.length
        ? `已在 ${parameters.path} 替换 ${parameters.edits.length} 个片段。`
        : `${parameters.path} 的编辑已处理，正文没有变化。`;
      return {
        content: [{ type: "text", text: summary + (diffError ? " 差异预览暂不可用，保存结果与操作标识已保留。" : "") }],
        details: { ...savedDetails(result, true), ...diff, ...(diffError ? { diffError } : {}) },
      };
    },
  };

  const patch: ToolDefinition<typeof patchParameters, any> = {
    name: "apply_patch",
    label: "apply_patch",
    description: "Apply a context patch to learning-space files. Supports adding, deleting, updating, and moving files in one saved content operation. Include enough unchanged context to identify each edit uniquely; ambiguous or overlapping edits fail. Unchanged text and its line endings are preserved.",
    promptSnippet: "Apply focused patches, including related changes across multiple files",
    parameters: patchParameters,
    executionMode: "sequential",
    async execute(_callId, parameters, signal) {
      checkCancelled(signal);
      const result = await content.applyPatch({ patch: parameters.patch, operationId: randomUUID() });
      rememberSaved(result);
      await observer?.recordSaved(result);
      return {
        content: [{ type: "text", text: result.changes.length
          ? `补丁已保存：\n${result.changes.map((change) => change.path).join("\n")}`
          : "补丁已处理，正文没有变化。" }],
        details: savedDetails(result),
      };
    },
  };
  return [read, edit, write, patch];
}
