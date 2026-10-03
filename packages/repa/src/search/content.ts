import path from "node:path";
import { Check } from "typebox/value";
import type { RepaCapabilityServices } from "../capabilities/services.js";
import type { ContentInfo, ContentTarget } from "../content/schema.js";
import type { ContentStore } from "../content/store.js";
import { RepaFault } from "../errors.js";
import { ContentSearchInputSchema, type ContentSearchInput, type ContentSearchResult } from "./content-schema.js";
import { discoverFiles, matchText } from "./ripgrep.js";
import { excerpt } from "./snippet.js";

const MAX_CANDIDATES = 500;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const statuses: Partial<Record<ContentInfo["status"], string>> = {
  missing: "not_found", detached: "not_found", needs_recovery: "needs_recovery", permission_required: "permission_required",
};

/** glob 只过滤空间目录候选；默认根查询另纳入精确关联的外部文件，不遍历它们的父目录。 */
export async function searchContent(content: ContentStore, resources: NonNullable<RepaCapabilityServices["resources"]>,
  input: ContentSearchInput, options: { signal?: AbortSignal; limit?: number } = {}): Promise<ContentSearchResult> {
  const limit = options.limit ?? 100;
  if (!Check(ContentSearchInputSchema, input) || !Number.isSafeInteger(limit) || limit < 1)
    throw new RepaFault("invalid_query", "内容搜索参数或结果上限无效。");
  const cancel = () => { if (options.signal?.aborted) throw new RepaFault("cancelled", "内容搜索已取消。"); };
  cancel();
  const result: ContentSearchResult = { matches: [], unavailable: [], truncated: false, resources: [] };
  const query = { pattern: input.pattern, literal: input.literal, ignoreCase: input.ignoreCase };
  const metadata = new Map<string, ContentInfo[]>();
  const listing = async (directory: string) => {
    const saved = metadata.get(directory);
    if (saved) return saved;
    const listed = await content.list({ path: path.relative(content.options.root, directory) });
    metadata.set(directory, listed);
    return listed;
  };
  const candidates: { target: ContentTarget; info?: ContentInfo }[] = [];
  const base = content.target(input.path ?? ".");
  const scope = await content.inspect(base);
  const scopeUnavailable = statuses[scope.status];
  if (scopeUnavailable) {
    result.unavailable.push({ target: scope.target, code: scopeUnavailable, message: "所选内容原件目前不可读取。" });
    return result;
  }
  if (scope.location.kind === "external" && scope.fileType === "directory")
    throw new RepaFault("permission_required", "内容搜索不遍历空间外目录，请明确关联或选择文件。");
  const absolute = scope.location.kind === "external" ? scope.location.path : path.resolve(content.options.root, scope.location.path);
  const found = await discoverFiles(absolute, { query, glob: input.glob, signal: options.signal, limit: MAX_CANDIDATES });
  result.truncated = found.truncated;
  for (const file of found.paths) {
    cancel();
    if (scope.fileType === "file") candidates.push({ target: scope.target, info: scope });
    else {
      const listed = await listing(path.dirname(file));
      const info = listed.find(item => item.location.kind === "relative" && path.resolve(content.options.root, item.location.path) === file);
      candidates.push({ target: info?.target ?? content.target(file), ...(info ? { info } : {}) });
    }
  }
  if (input.path === undefined) {
    const listed = await listing(content.options.root);
    for (const info of listed) {
      if (info.location.kind !== "external" || !info.ref) continue;
      if (candidates.length >= MAX_CANDIDATES) { result.truncated = true; break; }
      // 外部候选从已授权目录清单取得；通过资源服务读取，不直接向 rg 交出一个外部目录。
      candidates.push({ target: { kind: "content", ref: info.ref }, info });
    }
  }
  let readBytes = 0;
  const retained = new Set<string>();
  for (const [index, candidate] of candidates.entries()) {
    cancel();
    if (result.matches.length >= limit) { result.truncated = true; break; }
    const info = candidate.info;
    const unavailable = (code: string, message: string) => result.unavailable.push({ target: candidate.target, code, message });
    if (info && statuses[info.status]) { unavailable(statuses[info.status] ?? "unavailable", "所选内容原件目前不可读取。"); continue; }
    if (info?.fileType === "directory") { unavailable("unsupported_target", "只查询精确关联的外部文件，不递归其目录。"); continue; }
    if (info?.size === undefined) {
      result.truncated = true;
      unavailable("metadata_unavailable", "候选的大小元信息不可用，未读取正文。");
      continue;
    }
    if (info.mediaType === "application/pdf" || /^image\/(?!svg\+xml)/.test(info.mediaType)) {
      unavailable("unsupported_format", "原件没有直接可搜索的文本正文，请先选用材料能力提供的文本表示。");
      continue;
    }
    if (info.size > MAX_FILE_BYTES) {
      result.truncated = true;
      unavailable("file_byte_limit", "候选文件超过内容搜索的 8 MiB 单文件限额。");
      continue;
    }
    if (readBytes >= MAX_TOTAL_BYTES || readBytes + info.size > MAX_TOTAL_BYTES) {
      result.truncated = true;
      unavailable("query_byte_limit", "本次内容查询超过 32 MiB 总读取预算，未读取该候选。");
      continue;
    }
    try {
      const snapshot = await resources.snapshot({ target: candidate.target, maxBytes: Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - readBytes) });
      cancel();
      readBytes += snapshot.bytes.length;
      if (snapshot.bytes.length > MAX_FILE_BYTES || readBytes > MAX_TOTAL_BYTES) {
        result.truncated = true;
        unavailable("query_byte_limit", "候选在查询期间增长超过字节预算，未进行匹配。");
        continue;
      }
      const matched = await matchText(snapshot.bytes, query, { signal: options.signal, limit: limit - result.matches.length });
      result.truncated ||= matched.truncated;
      if (!matched.matches.length) continue;
      const revision = snapshot.content.bodyRevision;
      if (!revision) throw new RepaFault("revision_unavailable", "搜索快照缺少实际字节修订。");
      const target = snapshot.content.ref ? { kind: "content" as const, ref: snapshot.content.ref } : snapshot.content.target;
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(snapshot.bytes);
      const lineStarts = [0];
      for (const ending of text.matchAll(/\r\n|\r|\n/g)) lineStarts.push(ending.index + ending[0].length);
      for (const match of matched.matches) {
        const lineStart = lineStarts[match.line - 1];
        if (lineStart === undefined) throw new RepaFault("search_failed", "内容搜索命中行不属于实际快照。");
        result.matches.push({ target, revision, resource: snapshot.resource, line: match.line,
          range: match.utf16Range, byteRange: match.byteRange,
          snippet: excerpt(match.text, lineStart, match.utf16Range, 500) });
      }
      if (!retained.has(snapshot.resource.id)) { retained.add(snapshot.resource.id); result.resources.push(snapshot.resource); }
      if (matched.truncated || (result.matches.length === limit && index < candidates.length - 1)) { result.truncated = true; break; }
    } catch (error) {
      cancel();
      if (error instanceof Error && "code" in error && ["ENOENT", "EACCES", "EPERM"].includes(String(error.code))) {
        unavailable(error.code === "ENOENT" ? "not_found" : "permission_required", "候选原件在查询期间变得不可读取。");
        continue;
      }
      if (!(error instanceof RepaFault) || ["invalid_query", "cancelled", "search_failed", "tool_unavailable"].includes(error.code)) throw error;
      if (error.code === "content_limit") result.truncated = true;
      unavailable(error.code, error.message);
    }
  }
  return result;
}
