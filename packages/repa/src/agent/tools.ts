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
import { ContentPatchInputSchema, type ContentChangeResult, type ContentInfo, type ResourceRef } from "../content/schema.js";
import type { ContentStore } from "../content/store.js";
import { operationError } from "../content/operation-error.js";
import type { ProcessingResult } from "../requests/schema.js";
import { IdSchema, literals, object } from "../schema.js";

const patchParameters = Type.Omit(ContentPatchInputSchema, Type.Literal("operationId"), { additionalProperties: false });
const infoParameters = object({ path: Type.String({ minLength: 1 }) });
const operationParameters = object({ action: literals(["get", "undo"]), operationId: IdSchema });

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RepaFault("cancelled", "工具执行已取消。");
}

function resourceReference(value: string, spaceId: string): ResourceRef | undefined {
  if (!value.startsWith("repa:resource/")) return undefined;
  const match = /^repa:resource\/([a-f0-9]{64})$/.exec(value);
  if (!match?.[1]) throw new RepaFault("invalid_input", "资源引用无效。");
  return { spaceId, id: match[1], mediaType: "text/plain" };
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
  const save = async (change: (operationId: string) => Promise<ContentChangeResult>) => {
    const operationId = randomUUID();
    try {
      const result = await change(operationId);
      // 内容操作与观察收尾均可等待；取消不把已经保存的结果改报为未保存。
      rememberSaved(result);
      await observer?.recordSaved(result);
      return result;
    } catch (error) {
      throw operationError(error, operationId);
    }
  };
  const safeRead = createReadToolDefinition(learnerSpace);
  const info: ToolDefinition<typeof infoParameters, ContentInfo> = {
    name: "content_info", label: "content_info",
    description: "查询空间文件路径或 repa:document/<id>、repa:material/<id> 的稳定身份、结构 revision、组成与可用状态，不读取正文。修改组成时使用这里返回的结构 revision；正文读取和编辑仍用 read/edit/apply_patch。",
    parameters: infoParameters,
    executionMode: "sequential",
    async execute(_callId, parameters, signal) {
      checkCancelled(signal);
      const result = await content.inspect(content.target(parameters.path));
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  };
  const operation: ToolDefinition<typeof operationParameters, Awaited<ReturnType<ContentStore["operation"]>> | ContentChangeResult> = {
    name: "content_operation", label: "content_operation",
    description: "查询指定内容保存操作的实际状态，或按该操作逆向保存。get 用于核对成功、失败与待恢复事实；undo 复用内容撤回并保留可区分的后续修改，冲突时保留现场。操作标识来自内容工具结果。",
    parameters: operationParameters,
    executionMode: "sequential",
    async execute(_callId, parameters, signal) {
      checkCancelled(signal);
      const result = parameters.action === "get"
        ? await content.operation(parameters.operationId)
        : await save(undoOperationId => content.undo({ operationId: parameters.operationId, undoOperationId }));
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  };
  const read: ToolDefinition<typeof safeRead.parameters, any> = {
    ...safeRead,
    description: `${safeRead.description} Also accepts repa:document/<id>, repa:material/<id>, and repa:resource/<sha256> references. File reads append a Repa content snapshot with target and bodyRevision for apply_patch.bases; this metadata is not file content. The revision covers the complete observed file, including when only a page is shown. Resource references read immutable text such as complete command output in the current space, with the same offset/limit pagination. Reads space content and resources of currently enabled skills.`,
    executionMode: "sequential",
    async execute(callId, parameters, signal, onUpdate, ctx) {
      checkCancelled(signal);
      for (const value of [parameters.offset, parameters.limit]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
          throw new RepaFault("invalid_input", "offset 和 limit 必须为正整数。");
      }
      const resource = resourceReference(parameters.path, content.options.spaceId);
      const roots = resource ? [] : await enabledSkillRoots(loader);
      checkCancelled(signal);
      // 先解析原始引用；Pi 随后的路径处理只用于格式化，所有 ops 共用这份快照。
      const snapshot = resource
        ? { kind: "resource" as const, resource, bytes: await content.blobs.get(resource.id) }
        : { kind: "content" as const, ...await content.readForTool(parameters.path, roots) };
      checkCancelled(signal);
      const mimeType = snapshot.kind === "content" && /^image\/(?:png|jpeg|jpg|gif|webp|bmp)$/.test(snapshot.content.mediaType)
        ? snapshot.content.mediaType : undefined;
      const formatter = createReadToolDefinition(learnerSpace, {
        operations: {
          access: async () => {},
          readFile: async () => snapshot.bytes,
          detectImageMimeType: async () => mimeType,
        },
      });
      const result = await formatter.execute(callId, {
        ...parameters,
        path: snapshot.kind === "content" ? absolute(snapshot.content) : parameters.path,
      }, signal, onUpdate, ctx);
      checkCancelled(signal);
      if (result.details?.truncation?.firstLineExceedsLimit) {
        // Pi 的默认建议依赖 bash；此工具组合只提供内容操作。
        const truncation = result.details.truncation;
        const advice = snapshot.kind === "content" ? "；局部修改可通过 edit 提供准确且唯一的文本片段" : "";
        result.content = [{ type: "text", text: `第 ${parameters.offset ?? 1} 行超过 ${formatSize(truncation.maxBytes)} 读取限制，未返回这一行的正文。可使用 offset 读取其他行${advice}。` }];
      }
      if (snapshot.kind === "resource") {
        const details: ProcessingResult = {
          format: { id: "repa.resource-read", version: "1" },
          value: { kind: "inline", data: result.details ?? {} },
          sources: [],
          resources: [snapshot.resource],
        };
        return { ...result, details };
      }
      remember(snapshot.content);
      const fullRange = (parameters.offset ?? 1) === 1 &&
        (parameters.limit === undefined || parameters.limit >= snapshot.bytes.toString("utf8").split("\n").length);
      observer?.recordRead(snapshot.content, snapshot.bytes, fullRange && !result.details?.truncation?.truncated);
      return {
        ...result,
        content: [...result.content, {
          type: "text",
          text: `[Repa content snapshot: ${JSON.stringify({ target: snapshot.content.target, bodyRevision: snapshot.content.bodyRevision })}]`,
        }],
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
      const result = await save(operationId => content.write({
        target,
        value: { kind: "text", text: parameters.content },
        base,
        operationId,
      }));
      const saved = result.contents.find((info) => info.bodyRevision && info.status === "available");
      if (saved) observer?.recordRead(saved, Buffer.from(parameters.content), true);
      return {
        content: [{ type: "text", text: `已向 ${parameters.path} 保存 ${Buffer.byteLength(parameters.content)} 字节。\noperationId: ${result.operationId}` }],
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
      const result = await save(operationId => content.edit({
        target: content.target(parameters.path),
        edits: parameters.edits,
        operationId,
      }));
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
        content: [{ type: "text", text: summary + (diffError ? " 差异预览暂不可用，保存结果与操作标识已保留。" : "") + `\noperationId: ${result.operationId}` }],
        details: { ...savedDetails(result, true), ...diff, ...(diffError ? { diffError } : {}) },
      };
    },
  };

  const patch: ToolDefinition<typeof patchParameters, any> = {
    name: "apply_patch",
    label: "apply_patch",
    description: "Apply a patch enclosed by *** Begin Patch and *** End Patch, using Add File, Delete File, Update File, Move to, and @@ context hunks. Saves related file edits in one content operation. Optional bases guard the complete prior body of files actually changed by this patch: use the target and bodyRevision from read's Repa content snapshot as {target, base: bodyRevision}, or {kind: 'absent'} as base for a new location. For moves, source bases refer to the pre-move location. Unchanged files cannot be used as read guards. Optional registrations assign new content identities, with explicit ids when the same patch refers to them; compositions update existing content membership using its observed structure base from content_info. Known references and registered composition files are ordinary patch text. Include enough unchanged context to identify each edit uniquely; unchanged text and line endings are preserved.",
    promptSnippet: "Apply focused patches, including related changes across multiple files",
    parameters: patchParameters,
    executionMode: "sequential",
    async execute(_callId, parameters, signal) {
      checkCancelled(signal);
      const result = await save(operationId => content.applyPatch({ ...parameters, operationId }));
      return {
        content: [{ type: "text", text: (result.changes.length
          ? `补丁已保存：\n${result.changes.map((change) => change.path).join("\n")}`
          : "补丁已处理，正文没有变化。") + `\noperationId: ${result.operationId}` }],
        details: savedDetails(result),
      };
    },
  };
  return [read, info, operation, edit, write, patch];
}
