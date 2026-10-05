import path from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Definition, Nodes } from "mdast";
import { Check } from "typebox/value";
import { RepaFault } from "../errors.js";
import { IdSchema } from "../schema.js";
import { discoverFiles } from "../search/ripgrep.js";
import {
  ContentRelationsInputSchema,
  type ContentInfo, type ContentRelationEndpoint, type ContentRelationsInput,
  type ContentRelationsResult, type ContentRelationTarget, type ContentTarget,
} from "./schema.js";
import type { ContentStore, ContentObservation } from "./store.js";

const MAX_CANDIDATES = 500;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

function endpoint(content: ContentInfo): ContentRelationEndpoint {
  return {
    target: content.target,
    ...(content.ref ? { ref: content.ref } : {}),
    location: content.location,
    ...(content.role ? { role: content.role } : {}),
    mediaType: content.mediaType,
    status: content.status,
  };
}

function failureCode(error: unknown): string | undefined {
  if (error instanceof RepaFault) return error.code;
  if (error instanceof Error && "code" in error) {
    if (error.code === "ENOENT") return "not_found";
    if (error.code === "EACCES" || error.code === "EPERM") return "permission_required";
  }
  return undefined;
}

async function resolveTarget(inspect: ContentObservation["inspect"], target: ContentTarget): Promise<ContentRelationEndpoint> {
  try { return endpoint(await inspect(target)); }
  catch (error) {
    const code = failureCode(error);
    if (code !== "not_found" && code !== "permission_required") throw error;
    return {
      target, ...(target.kind === "content" ? { ref: target.ref } : { location: target.location }),
      status: code === "not_found" ? "missing" : "permission_required",
    };
  }
}

async function resolveHref(content: ContentStore, inspect: ContentObservation["inspect"], source: ContentInfo, href: string): Promise<ContentRelationTarget> {
  const identity = /^repa:(?:document|material)\/([a-zA-Z0-9_-]+)(?:[?#].*)?$/.exec(href);
  if (identity?.[1] && Check(IdSchema, identity[1])) {
    const target: ContentTarget = { kind: "content", ref: { spaceId: content.options.spaceId, id: identity[1] } };
    return { kind: "local", ...await resolveTarget(inspect, target) };
  }
  if (href.startsWith("repa:")) return { kind: "unresolved", href, status: "invalid", code: "invalid_reference" };
  // 网络地址只保留原始链接，不进行访问，也不以解析成功声称目标在线可用。
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href) || href.startsWith("//"))
    return { kind: "url", href, status: "unverified" };
  let file: string;
  try { file = decodeURIComponent(href.split(/[?#]/, 1)[0] ?? ""); }
  catch { return { kind: "unresolved", href, status: "invalid", code: "invalid_path" }; }
  if (file.includes("\0")) return { kind: "unresolved", href, status: "invalid", code: "invalid_path" };
  const absolute = source.location.kind === "external" ? source.location.path : path.resolve(content.options.root, source.location.path);
  const target = file === "" ? source.target : content.target(path.resolve(path.dirname(absolute), file));
  return { kind: "local", ...await resolveTarget(inspect, target) };
}

function walk(node: Nodes, visit: (node: Nodes) => void): void {
  visit(node);
  if ("children" in node) for (const child of node.children) walk(child, visit);
}

/** 从实际使用位置提取 CommonMark 链接，不把未引用的定义当作关系。 */
function markdownReferences(text: string): { href: string; syntax: "link" | "image"; line: number; range: { start: number; end: number } }[] {
  const tree = fromMarkdown(text);
  const definitions = new Map<string, Definition>();
  walk(tree, node => {
    if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
  });
  const references: ReturnType<typeof markdownReferences> = [];
  walk(tree, node => {
    if (node.type !== "link" && node.type !== "image" && node.type !== "linkReference" && node.type !== "imageReference") return;
    const href = node.type === "link" || node.type === "image" ? node.url : definitions.get(node.identifier)?.url;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (href === undefined || start === undefined || end === undefined || !node.position) return;
    references.push({ href, syntax: node.type === "image" || node.type === "imageReference" ? "image" : "link",
      line: node.position.start.line, range: { start, end } });
  });
  return references;
}

/** 关系是正文和明确 members 的派生结果；一次查询不建立身份、反向索引或资源持有。 */
export async function queryContentRelations(content: ContentStore, input: ContentRelationsInput = {}, options: { signal?: AbortSignal } = {}): Promise<ContentRelationsResult> {
  if (!Check(ContentRelationsInputSchema, input) || (input.limit !== undefined && !Number.isSafeInteger(input.limit)))
    throw new RepaFault("invalid_query", "内容关系的范围或结果上限无效。");
  const limit = input.limit ?? 1000;
  const cancel = () => { if (options.signal?.aborted) throw new RepaFault("cancelled", "内容关系查询已取消。"); };
  cancel();
  return content.observe(async scope => {
    const result: ContentRelationsResult = { relations: [], unavailable: [], truncated: false };
    const unavailable = (target: ContentTarget, code: string, message: string) => result.unavailable.push({ target, code, message });
    const metadata = new Map<string, ContentInfo>();
    const targetKey = (target: ContentTarget) => JSON.stringify(target.kind === "content"
      ? [target.kind, target.ref.spaceId, target.ref.id]
      : [target.kind, target.spaceId, target.location.kind, target.location.path]);
    const inspect = async (target: ContentTarget) => {
      const saved = metadata.get(targetKey(target));
      if (saved) return saved;
      const info = await scope.inspect(target);
      metadata.set(targetKey(target), info);
      metadata.set(targetKey(info.target), info);
      // 失效身份的位置不能替后来占用同一路径的文件回答查询。
      if (info.status === "available")
        metadata.set(targetKey({ kind: "file", spaceId: content.options.spaceId, location: info.location }), info);
      return info;
    };
    const base = content.target(input.path ?? ".");
    const selected = await inspect(base);
    if (selected.status === "needs_recovery" || selected.status === "detached") {
      unavailable(selected.target, selected.status, "所选内容目前不能作为已确认的关系来源。");
      return result;
    }
    if (selected.location.kind === "external" && selected.fileType === "directory")
      throw new RepaFault("permission_required", "关系查询不遍历空间外目录，请选择明确关联的文件。");
    const absolute = selected.location.kind === "external" ? selected.location.path : path.resolve(content.options.root, selected.location.path);
    const explicitSource = input.path !== undefined && selected.fileType !== "directory";
    const candidates = new Map<string, ContentInfo>();
    const key = (info: ContentInfo) => info.ref ? `id:${info.ref.id}` : `${info.location.kind}:${info.location.path}`;
    const add = (info: ContentInfo) => {
      if (!explicitSource && info.mediaType !== "text/markdown" && !(info.ref && info.members.length)) return;
      const identity = key(info);
      if (candidates.has(identity)) return;
      if (candidates.size >= MAX_CANDIDATES) {
        result.truncated = true;
        return;
      }
      candidates.set(identity, info);
    };
    if (selected.fileType !== "directory") add(selected);
    else {
      const found = await discoverFiles(absolute, { glob: "*.[mM][dD]", signal: options.signal, limit: MAX_CANDIDATES });
      result.truncated = found.truncated;
      for (const file of found.paths) {
        cancel();
        const target = content.target(file);
        try { add(await inspect(target)); }
        catch (error) {
          const code = failureCode(error);
          if (code !== "permission_required" && code !== "not_found") throw error;
          unavailable(target, code, "候选文件目前不可读取。");
        }
      }
      // 明确组成也可能属于目录或原件缺失的对象，不能仅依靠现存文件发现。
      for (const target of scope.targets()) {
        cancel();
        let info: ContentInfo;
        try { info = await inspect(target); }
        catch (error) {
          const code = failureCode(error);
          if (code !== "permission_required" && code !== "not_found") throw error;
          unavailable(target, code, "已登记来源目前不可读取。");
          continue;
        }
        if (info.location.kind === "external") {
          if (input.path === undefined) add(info);
          continue;
        }
        const relative = path.relative(absolute, path.resolve(content.options.root, info.location.path));
        if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) add(info);
      }
    }
    let bytesRead = 0;
    for (const candidate of candidates.values()) {
      cancel();
      if (candidate.status === "needs_recovery" || candidate.status === "detached") {
        unavailable(candidate.target, candidate.status, "来源的位置或组成尚不可用，未生成已确认关系。");
        continue;
      }
      const source = endpoint(candidate);
      for (const [index, member] of candidate.members.entries()) {
        if (result.relations.length === limit) {
          result.truncated = true;
          return result;
        }
        if (!candidate.revision) throw new RepaFault("revision_unavailable", "组成关系缺少实际结构修订。");
        result.relations.push({ kind: "composition", source, revision: candidate.revision,
          target: { kind: "local", ...await resolveTarget(inspect, member.target) }, index,
          ...(member.name !== undefined ? { name: member.name } : {}) });
      }
      if (candidate.status !== "available") {
        unavailable(candidate.target, candidate.status, "来源正文目前不可读取，已确认的组成关系仍已返回。");
        continue;
      }
      if (candidate.fileType === "directory") continue;
      if (candidate.mediaType !== "text/markdown") {
        if (explicitSource)
          unavailable(candidate.target, "unsupported_format", "当前只从 Markdown 正文提取引用；明确组成关系仍已返回。");
        continue;
      }
      if (candidate.size === undefined) {
        unavailable(candidate.target, "metadata_unavailable", "候选文件的大小不可用，未读取正文。");
        continue;
      }
      if (candidate.size > MAX_FILE_BYTES || bytesRead + candidate.size > MAX_TOTAL_BYTES) {
        result.truncated = true;
        unavailable(candidate.target, candidate.size > MAX_FILE_BYTES ? "file_byte_limit" : "query_byte_limit", "来源超过本次关系查询的字节预算，未提取正文引用。");
        continue;
      }
      try {
        const snapshot = await scope.readTarget(candidate.target, Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - bytesRead));
        cancel();
        if (!snapshot.bytes || snapshot.content.status !== "available") {
          unavailable(candidate.target, snapshot.content.status, "来源文件在查询期间变得不可用。");
          continue;
        }
        bytesRead += snapshot.bytes.length;
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(snapshot.bytes); }
        catch {
          unavailable(candidate.target, "unsupported_format", "Markdown 正文不是有效的 UTF-8 表示。");
          continue;
        }
        if (text.includes("\0")) {
          unavailable(candidate.target, "unsupported_format", "Markdown 正文包含二进制数据。");
          continue;
        }
        const revision = snapshot.content.bodyRevision;
        if (!revision) throw new RepaFault("revision_unavailable", "引用来源缺少实际字节修订。");
        for (const reference of markdownReferences(text)) {
          cancel();
          if (result.relations.length === limit) {
            result.truncated = true;
            return result;
          }
          result.relations.push({ kind: "reference", source: endpoint(snapshot.content), revision,
            target: await resolveHref(content, inspect, snapshot.content, reference.href), ...reference });
        }
      } catch (error) {
        cancel();
        const code = failureCode(error);
        if (!code || !["not_found", "permission_required", "content_limit", "recovery_required"].includes(code)) throw error;
        if (code === "content_limit") result.truncated = true;
        unavailable(candidate.target, code, "来源文件在查询期间不可读取或超过字节预算。");
      }
    }
    return result;
  });
}
