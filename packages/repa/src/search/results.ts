import { Check } from "typebox/value";
import type { RepaCapabilityServices } from "../capabilities/services.js";
import type { ContentTarget, ResourceRef } from "../content/schema.js";
import { RepaFault } from "../errors.js";
import type { ProcessingResult } from "../requests/schema.js";
import { StoredSearchSnapshotSchema, type SearchSnapshot, type SearchCursor, type SearchPageData } from "./protocol.js";

type Resources = NonNullable<RepaCapabilityServices["resources"]>;

/** 搜索格式只解释自己的引用；历史字节不改写，真实跨空间来源也不投影。 */
function project(result: SearchSnapshot, origin: string, current: string): SearchSnapshot {
  const projected = structuredClone(result);
  const target = (value: ContentTarget) => {
    if (value.kind === "content") {
      if (value.ref.spaceId === origin) value.ref.spaceId = current;
    } else if (value.spaceId === origin) value.spaceId = current;
  };
  if (projected.kind === "content") {
    for (const match of projected.matches) {
      target(match.target);
      if (match.resource.spaceId === origin) match.resource.spaceId = current;
    }
    for (const item of projected.unavailable) target(item.target);
    for (const resource of projected.resources) if (resource.spaceId === origin) resource.spaceId = current;
  } else if (projected.spaceId === origin) projected.spaceId = current;
  return projected;
}

/** 页从不可变查询结果读取；业务数据只索引当前表示的标准来源和资源。 */
function page(result: SearchSnapshot, snapshot: ResourceRef, offset: number, limit: number): ProcessingResult {
  if (offset > result.matches.length) throw new RepaFault("invalid_cursor", "搜索分页位置不属于该结果。");
  const end = Math.min(offset + limit, result.matches.length);
  const sources: ProcessingResult["sources"] = [];
  const resources = [snapshot, ...(result.kind === "content" ? result.resources : [])];
  const next = end < result.matches.length ? { snapshotIndex: 0, offset: end } : undefined;
  const common = { total: result.matches.length, ...(next ? { next } : {}) };
  let data: SearchPageData;
  if (result.kind === "content") {
    const sourceIndexes = new Map<string, number>();
    for (const match of result.matches) {
      const key = JSON.stringify([match.target, match.revision]);
      if (sourceIndexes.has(key)) continue;
      sourceIndexes.set(key, sources.length);
      sources.push({ target: match.target, revision: match.revision });
    }
    const resourceIndexes = new Map(resources.map((resource, index) => [JSON.stringify(resource), index]));
    data = { kind: "content", query: result.query, truncated: result.truncated, ...common,
      matches: result.matches.slice(offset, end).map(match => {
        const sourceIndex = sourceIndexes.get(JSON.stringify([match.target, match.revision]));
        const resourceIndex = resourceIndexes.get(JSON.stringify(match.resource));
        if (sourceIndex === undefined || resourceIndex === undefined)
          throw new RepaFault("invalid_cursor", "搜索命中没有对应的标准来源或资源。");
        return { sourceIndex, resourceIndex, line: match.line, range: match.range, byteRange: match.byteRange, snippet: match.snippet };
      }),
      unavailable: result.unavailable.map(item => {
        const spaceId = item.target.kind === "content" ? item.target.ref.spaceId : item.target.spaceId;
        if (spaceId !== snapshot.spaceId) throw new RepaFault("invalid_cursor", "不可用目标不属于结果快照的作用域。");
        return { target: item.target.kind === "content" ? { kind: "content", id: item.target.ref.id } : { kind: "file", location: item.target.location },
        code: item.code, message: item.message };
      }),
    };
  } else {
    const { spaceId: _spaceId, ...history } = result;
    data = { ...history, matches: result.matches.slice(offset, end), ...common };
  }
  return { format: { id: "repa.search-results", version: "1" }, value: { kind: "inline", data }, sources, resources,
    summary: `找到 ${result.matches.length} 项匹配${result.truncated ? "（查询已达上限）" : ""}，本页 ${end - offset} 项。` };
}

export async function saveSearchResult(result: SearchSnapshot, resources: Resources, originSpaceId: string, limit = 50): Promise<ProcessingResult> {
  const snapshot = await resources.create(Buffer.from(JSON.stringify({ format: "repa.search-snapshot", version: 1, originSpaceId, result })),
    "application/vnd.repa.search+json");
  return page(project(result, originSpaceId, snapshot.spaceId), snapshot, 0, limit);
}

export async function readSearchPage(cursor: SearchCursor, resources: Resources, spaceId: string, limit = 50): Promise<ProcessingResult> {
  const snapshot = { spaceId, id: cursor.snapshot, mediaType: "application/vnd.repa.search+json" };
  const bytes = await resources.read(snapshot);
  let stored: unknown;
  try { stored = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new RepaFault("invalid_cursor", "搜索游标没有指向可读取的结果快照。"); }
  if (!Check(StoredSearchSnapshotSchema, stored)) throw new RepaFault("invalid_cursor", "搜索结果格式不可识别。");
  const result = project(stored.result, stored.originSpaceId, snapshot.spaceId);
  if (result.kind === "content") resources.retain(result.resources);
  return page(result, snapshot, cursor.offset, limit);
}
