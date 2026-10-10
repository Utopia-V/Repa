import { Type, type BackendPlugin, type CapabilityDefinition, type RepaCapabilityServices } from "repa/plugin";
import { RepaFault, type ProcessingResult, type ResourceRef } from "repa/protocol";
import { fetchBytes } from "./fetch.js";
import { extractBytes } from "./readers.js";
import { searchWikipedia } from "./search.js";
import { EXTRACT_CONTRACT, EXTRACT_FORMAT, ExtractInputSchema, ExtractOutputSchema, MAX_BYTES, FetchInputSchema, FETCH_CONTRACT, FETCH_FORMAT, SearchInputSchema, SEARCH_CONTRACT, SEARCH_FORMAT, type FetchSource, type FetchData, type ExtractData } from "./schema.js";
export { EXTRACT_CONTRACT, EXTRACT_FORMAT, ExtractInputSchema, ExtractOutputSchema, ExtractDataSchema } from "./schema.js";
export { FetchInputSchema, FetchDataSchema, FetchSourceSchema, FETCH_CONTRACT, FETCH_FORMAT } from "./schema.js";
export { SearchInputSchema, SearchDataSchema, SEARCH_CONTRACT, SEARCH_FORMAT } from "./schema.js";
export type { ExtractInput, ExtractData, FetchInput, FetchData, FetchSource, SearchInput, SearchData } from "./schema.js";

export default function materials(): BackendPlugin<RepaCapabilityServices> {
  const extract: CapabilityDefinition<typeof ExtractInputSchema, typeof ExtractOutputSchema, RepaCapabilityServices> = {
    contract: EXTRACT_CONTRACT, implementationId: "local", inputSchema: ExtractInputSchema, outputSchema: ExtractOutputSchema,
    scopes: ["space"], execution: "background",
    tool: { name: "read_material", description: "读取文件、关联材料或固定资源的实际字节。target.kind 为 resource 时直接使用 ResourceRef，不重取当前文件或网页。支持原文行范围、HTML 正文、PDF 页范围和图片信息；文本或 HTML 可指定 encoding，不修改原件或人工稿。" },
    inputResources: input => input.target.kind === "resource" ? [input.target.resource] : [],
    async invoke(input, context): Promise<ProcessingResult> {
      const services = context.services;
      if (!services?.resources) throw new RepaFault("capability_service", "材料读取需要真实父请求的资源服务。");
      context.signal.throwIfAborted();
      let bytes: Uint8Array;
      let resource: ResourceRef;
      let file = "";
      let source: ProcessingResult["sources"][number] | undefined;
      try {
        if (input.target.kind === "resource") {
          resource = input.target.resource;
          if (input.expectedBodyRevision !== undefined && input.expectedBodyRevision !== resource.id)
            throw new RepaFault("revision_conflict", "指定的原件版本与资源标识不一致。", {
              expected: input.expectedBodyRevision, actual: resource.id,
            });
          bytes = await services.resources.read(resource, { maxBytes: MAX_BYTES });
        } else {
          const snapshot = await services.resources.snapshot({
            target: input.target,
            maxBytes: MAX_BYTES,
            ...(input.expectedBodyRevision !== undefined ? { revision: input.expectedBodyRevision } : {}),
          });
          bytes = snapshot.bytes;
          resource = snapshot.resource;
          file = snapshot.content.location.path;
          const target = snapshot.content.ref ? { kind: "content" as const, ref: snapshot.content.ref } : snapshot.content.target;
          const revision = snapshot.content.bodyRevision;
          if (!revision) throw new RepaFault("revision_unavailable", "原件没有实际字节修订。");
          source = { target, revision };
        }
      } catch (error) {
        context.signal.throwIfAborted();
        if (!(error instanceof RepaFault) || error.code !== "content_limit") throw error;
        const data: ExtractData = {
          status: "limit_exceeded",
          kind: "unknown",
          reader: { name: "none" },
          segments: [],
          truncated: false,
          issues: [{ code: "input_limit", message: "原件超过材料读取的 32 MiB 限额，本次未提取正文或完成字节校验。" }],
        };
        // 文件未形成快照；资源引用则早已存在，保留它不表示本次已经读过这些字节。
        return {
          format: EXTRACT_FORMAT,
          value: { kind: "inline", data },
          sources: [],
          resources: input.target.kind === "resource" ? [input.target.resource] : [],
        };
      }
      context.signal.throwIfAborted();
      const data = await extractBytes(bytes, resource.mediaType, file, input, context.signal, services, input.encoding);
      context.signal.throwIfAborted();
      let sources: ProcessingResult["sources"] = [];
      if (source) {
        const origin = source;
        sources = data.segments.length ? data.segments.map(segment => ({ ...origin, locator: segment.locator })) : [origin];
      }
      return {
        format: EXTRACT_FORMAT,
        value: { kind: "inline", data },
        sources,
        resources: [resource],
      };
    },
  };
  const online: CapabilityDefinition<typeof FetchInputSchema, typeof ExtractOutputSchema, RepaCapabilityServices> = {
    contract: FETCH_CONTRACT, implementationId: "http", inputSchema: FetchInputSchema, outputSchema: ExtractOutputSchema,
    scopes: ["space"], execution: "background",
    tool: { name: "fetch_material", description: "获取明确 HTTP(S) URL 的原件，保留请求地址、重定向后地址及原字节资源，并用本地读取器提取。不会自动关联材料、覆盖文档或抓取子资源。" },
    async invoke(input, context): Promise<ProcessingResult> {
      const services = context.services;
      if (!services?.resources) throw new RepaFault("capability_service", "在线材料获取需要真实父请求的资源服务。");
      services.progress?.("正在获取在线材料");
      const received = await fetchBytes(input.url, context.signal);
      context.signal.throwIfAborted();
      const { bytes, ...origin } = received;
      const original = await services.resources.create(bytes, received.mediaType);
      const source: FetchSource = { kind: "url", ...origin, bodyRevision: original.id };
      const charset = /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(received.contentType ?? "");
      const extraction = await extractBytes(bytes, received.mediaType, new URL(received.finalUrl).pathname,
        input, context.signal, services, charset?.[1] ?? charset?.[2] ?? "utf-8");
      context.signal.throwIfAborted();
      const data: FetchData = { source, origin: { kind: "url", url: source.finalUrl, retrievedAt: source.fetchedAt },
        extraction, originalResourceIndex: 0 };
      // URL 属于材料格式的来源，不能伪装为 ContentTarget；关联时由实际内容接手原件及 origin。
      return { format: FETCH_FORMAT, value: { kind: "inline", data }, sources: [], resources: [original] };
    },
  };
  const search: CapabilityDefinition<typeof SearchInputSchema, typeof ExtractOutputSchema, RepaCapabilityServices> = {
    contract: SEARCH_CONTRACT, implementationId: "wikipedia", inputSchema: SearchInputSchema, outputSchema: ExtractOutputSchema,
    scopes: ["space"], execution: "background",
    tool: { name: "search_wikipedia", description: "只搜索指定语言版 Wikipedia 百科条目，不是全网搜索。返回标题、条目 URL 和索引片段；片段不代表已经阅读正文，后续用 fetch_material 获取原件。" },
    async invoke(input, context): Promise<ProcessingResult> {
      context.services?.progress?.("正在查询 Wikipedia 百科条目");
      const data = await searchWikipedia(input, context.signal);
      return { format: SEARCH_FORMAT, value: { kind: "inline", data }, sources: [], resources: [] };
    },
  };
  return { capabilities: [extract, online, search], settings: [{ namespace: "repa.materials", settings: {
    pdfinfo: { schema: Type.String({ minLength: 1 }), default: "pdfinfo", scopes: ["application"] },
    pdftotext: { schema: Type.String({ minLength: 1 }), default: "pdftotext", scopes: ["application"] },
  } }] };
}
