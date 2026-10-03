import { JSDOM } from "jsdom";
import { Type } from "repa/plugin";
import { Check } from "typebox/value";
import { RepaFault } from "repa/protocol";
import { fetchBytes } from "./fetch.js";
import type { SearchData, SearchInput } from "./schema.js";

// 只校验实际使用的 API 字段，保留上游增加其他字段的空间。
const ResponseSchema = Type.Object({
  query: Type.Object({
    search: Type.Array(Type.Object({
      pageid: Type.Integer({ minimum: 1 }), title: Type.String(),
      snippet: Type.Optional(Type.String()), timestamp: Type.Optional(Type.String()),
    })),
    searchinfo: Type.Optional(Type.Object({ totalhits: Type.Optional(Type.Integer({ minimum: 0 })) })),
  }),
  continue: Type.Optional(Type.Object({ sroffset: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) })),
});
const ErrorSchema = Type.Object({ error: Type.Object({ code: Type.String(), info: Type.String() }) });

/** 仅使用 Wikipedia 官方全文搜索 API；搜索片段不是已经取得的原文。 */
export async function searchWikipedia(input: SearchInput, signal: AbortSignal): Promise<SearchData> {
  if (!input.query.trim()) throw new RepaFault("invalid_material_query", "请输入实际的百科搜索词。");
  const language = input.language ?? "zh";
  const limit = input.limit ?? 10;
  const offset = input.offset ?? 0;
  const endpoint = new URL(`https://${language}.wikipedia.org/w/api.php`);
  endpoint.search = new URLSearchParams({ action: "query", list: "search", srsearch: input.query,
    srlimit: String(limit), sroffset: String(offset), srprop: "snippet|timestamp", srinfo: "totalhits",
    format: "json", formatversion: "2", utf8: "1" }).toString();
  const received = await fetchBytes(endpoint.href, signal);
  signal.throwIfAborted();
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(received.bytes)); }
  catch { throw new RepaFault("material_search_response", "Wikipedia 搜索 API 没有返回有效的 JSON。"); }
  if (Check(ErrorSchema, raw)) throw new RepaFault("material_search_api", `Wikipedia 搜索 API：${raw.error.info}`, {
    provider: "wikipedia", code: raw.error.code,
  });
  if (!Check(ResponseSchema, raw)) throw new RepaFault("material_search_response", "Wikipedia 搜索 API 的结果格式无法识别。");
  const dom = new JSDOM();
  try {
    const results = raw.query.search.map(item => {
      // curid 是官方页面身份定位参数；标题重命名不改变这个页面 ID。
      const page = new URL(`https://${language}.wikipedia.org/w/index.php`);
      page.searchParams.set("curid", String(item.pageid));
      const snippet = dom.window.document.createElement("div");
      snippet.innerHTML = item.snippet ?? "";
      const updated = item.timestamp === undefined ? undefined : Date.parse(item.timestamp);
      if (updated !== undefined && !Number.isFinite(updated))
        throw new RepaFault("material_search_response", "Wikipedia 搜索 API 的页面时间无法识别。");
      return { pageId: item.pageid, title: item.title, url: page.href, snippet: snippet.textContent ?? "",
        ...(updated !== undefined ? { pageUpdatedAt: updated } : {}) };
    });
    return {
      provider: { id: "wikipedia", name: "Wikipedia", scope: "encyclopedia" },
      query: input.query, language, fetchedAt: received.fetchedAt, offset, limit,
      ...(raw.query.searchinfo?.totalhits !== undefined ? { total: raw.query.searchinfo.totalhits } : {}), results,
      ...(raw.continue ? { next: { query: input.query, language, limit, offset: raw.continue.sroffset } } : {}),
    };
  } finally { dom.window.close(); }
}
