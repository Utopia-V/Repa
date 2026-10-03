import { Type } from "typebox";
import type { BackendPlugin, CapabilityDefinition, InvocationContext } from "../capabilities/types.js";
import type { RepaCapabilityServices } from "../capabilities/services.js";
import { RepaFault } from "../errors.js";
import { methods } from "../protocol.js";
import { RepresentationSchema } from "../requests/schema.js";
import { object } from "../schema.js";
import { ContentSearchInputSchema, HistorySearchInputSchema, SearchPageInputSchema } from "./protocol.js";
import { searchContent } from "./content.js";
import { searchHistory } from "./history.js";
import { readSearchPage, saveSearchResult } from "./results.js";

export const SEARCH_PLUGIN_ID = "repa-search";
const pageLimit = Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "本页最多返回的匹配数，默认 50；后续页使用返回的游标。" }));
const ContentInputSchema = object({ ...ContentSearchInputSchema.properties, limit: pageLimit });
const HistoryInputSchema = object({ ...HistorySearchInputSchema.properties, limit: pageLimit });
const { spaceId: _spaceId, ...historyFields } = methods["session.history"].params.properties;
// TypeBox 的 Omit 会把带 not 的复合 schema 视为其他类型；保留原字段与范围互斥约束。
const ReadHistoryInputSchema = { ...object(historyFields), not: methods["session.history"].params.not };

export const SEARCH_TOOLS = [
  { name: "grep", description: "使用 ripgrep 搜索授权空间及已关联材料，返回带实际正文版本与原文定位的匹配片段。命中sourceIndex/resourceIndex指向本表示sources/resources；后续页读取同一结果，不混入后来修改。", parameters: ContentInputSchema },
  { name: "search_history", description: "搜索指定会话已保存的交流历史，返回真实消息位置；不打开或切换 Agent。", parameters: HistoryInputSchema },
  { name: "search_page", description: "读取搜索下一页：从上一表示resources[next.snapshotIndex]取得id作为cursor.snapshot，next.offset作为cursor.offset；空间由本次调用确定。", parameters: SearchPageInputSchema },
  { name: "read_history", description: "按消息位置读取指定会话历史。搜索后携带 revision 和 around 查看同一版本的原消息及邻近交流。", parameters: ReadHistoryInputSchema },
] as const;

const metadata = (tool: { name: string; description: string }) => ({ name: tool.name, description: tool.description });

function resources(context: InvocationContext<RepaCapabilityServices>) {
  if (!context.services?.resources) throw new RepaFault("capability_service", "搜索需要实际父请求的资源服务。");
  return context.services.resources;
}
function sessions(context: InvocationContext<RepaCapabilityServices>) {
  if (!context.services?.sessions) throw new RepaFault("capability_service", "历史查询需要所属空间的会话读取服务。");
  return context.services.sessions;
}

export function createSearchPlugin(): BackendPlugin<RepaCapabilityServices> {
  const content: CapabilityDefinition<typeof ContentInputSchema, typeof RepresentationSchema, RepaCapabilityServices> = {
    contract: { id: "repa.search.content", version: "1" }, implementationId: "ripgrep",
    inputSchema: ContentInputSchema, outputSchema: RepresentationSchema, scopes: ["space"], execution: "background",
    tool: metadata(SEARCH_TOOLS[0]),
    async invoke(input, context) {
      if (!context.content) throw new RepaFault("capability_service", "内容搜索需要所属空间的内容入口。");
      const current = resources(context);
      const { limit, ...query } = input;
      const result = await searchContent(context.content, current, query, { signal: context.signal, limit: 1000 });
      if (context.scope.kind !== "space") throw new RepaFault("capability_scope", "内容搜索需要所属空间。");
      return saveSearchResult({ kind: "content", query, ...result }, current, context.scope.spaceId, limit);
    },
  };
  const history: CapabilityDefinition<typeof HistoryInputSchema, typeof RepresentationSchema, RepaCapabilityServices> = {
    contract: { id: "repa.search.history", version: "1" }, implementationId: "ripgrep",
    inputSchema: HistoryInputSchema, outputSchema: RepresentationSchema, scopes: ["space"], execution: "background",
    tool: metadata(SEARCH_TOOLS[1]),
    async invoke(input, context) {
      if (context.scope.kind !== "space") throw new RepaFault("capability_scope", "历史搜索需要所属空间。");
      const { limit, ...query } = input;
      const snapshot = sessions(context).snapshot(query);
      const result = await searchHistory(snapshot, query, { signal: context.signal, limit: 1000 });
      return saveSearchResult({ kind: "history", spaceId: context.scope.spaceId, query, ...result }, resources(context), context.scope.spaceId, limit);
    },
  };
  const next: CapabilityDefinition<typeof SearchPageInputSchema, typeof RepresentationSchema, RepaCapabilityServices> = {
    contract: { id: "repa.search.page", version: "1" }, implementationId: "snapshot",
    inputSchema: SearchPageInputSchema, outputSchema: RepresentationSchema, scopes: ["space"], execution: "inline",
    tool: metadata(SEARCH_TOOLS[2]),
    inputResources: (input, scope) => scope.kind === "space"
      ? [{ spaceId: scope.spaceId, id: input.cursor.snapshot, mediaType: "application/vnd.repa.search+json" }] : [],
    invoke: (input, context) => {
      if (context.scope.kind !== "space") throw new RepaFault("capability_scope", "搜索分页需要所属空间。");
      return readSearchPage(input.cursor, resources(context), context.scope.spaceId, input.limit);
    },
  };
  const read: CapabilityDefinition<typeof ReadHistoryInputSchema, typeof methods["session.history"]["result"], RepaCapabilityServices> = {
    contract: { id: "repa.history.read", version: "1" }, implementationId: "pi",
    inputSchema: ReadHistoryInputSchema, outputSchema: methods["session.history"].result, scopes: ["space"], execution: "inline",
    tool: metadata(SEARCH_TOOLS[3]),
    outputResources: output => output.messages.flatMap(message => message.content.flatMap(block => block.type === "resource" ? [block.resource] : [])),
    invoke: (input, context) => sessions(context).history({ ...input, limit: input.limit ?? 20 }),
  };
  return { capabilities: [content, history, next, read] };
}
