import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  contentVersion,
  ItemSchema,
  requiredCapabilities,
  type AskRequest,
  type Item,
  type ItemDraft,
  type AskSubmitResult,
  type ItemResponse,
} from "./interaction.js";
import type { AskOutcome } from "./plugin.js";
import { object, RepaFault } from "./schema.js";

/** 一次询问，由路由分配 id 并决定发给哪个连接。 */
export type AskInput = Omit<AskRequest, "id">;

/** 询问路由的取消与提交处理选项，用于将插件语义校验接入卡片提交。 */
export interface AskRouteOptions {
  signal?: AbortSignal;
  /** 作答通过结构检查后交给调用方：invalid 时卡片保持打开，accepted 时关闭。省略时通过结构检查就接受。 */
  onSubmit?(response: ItemResponse): Promise<AskSubmitResult>;
}

/**
 * 对话里询问的路由：协议服务把它绑定到发起当前运行的连接。插件宿主经它实现 ToolContext.ask，
 * 运行时经它实现 ask_user；离线测试可以换成模拟用户的函数。
 */
export type AskRoute = (request: AskInput, options: AskRouteOptions) => Promise<AskOutcome>;

// 交给底座的 Item：可以带插件算好的 version；requires 由底座从结构算出，带了就必须与结构一致。
const ItemInputSchema = object({
  ...ItemSchema.properties,
  version: Type.Optional(ItemSchema.properties.version),
  requires: Type.Optional(ItemSchema.properties.requires),
});

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  return [...repeated];
}

/** schema 管不到的一致性：id 在各自范围内唯一，单元格对应已有的列，选择个数的上下限能够满足。 */
function itemProblems(item: ItemDraft): string[] {
  const problems: string[] = [];
  const repeated = (scope: string, ids: string[]) => {
    for (const id of duplicates(ids)) problems.push(`${scope}里的 id 重复：${id}`);
  };
  repeated("作答位", item.slots.map((slot) => slot.id));
  for (const slot of item.slots) {
    if (slot.type === "choice") {
      repeated(`${slot.id} 的选项`, slot.options.map((option) => option.id));
      const available = slot.options.length + (slot.other === undefined ? 0 : 1);
      if (slot.multiple === true && slot.minSelected !== undefined && slot.minSelected > Math.min(slot.maxSelected ?? available, available)) {
        problems.push(`${slot.id} 的 minSelected 无法满足`);
      }
    } else if (slot.type === "order") {
      repeated(`${slot.id} 的排列块`, slot.items.map((block) => block.id));
    } else if (slot.type === "table") {
      repeated(`${slot.id} 的列`, slot.columns.map((column) => column.id));
      repeated(`${slot.id} 的行`, slot.rows.map((row) => row.id));
      const columns = new Set(slot.columns.map((column) => column.id));
      for (const row of slot.rows) {
        for (const [columnId, cell] of Object.entries(row.cells)) {
          if (!columns.has(columnId)) problems.push(`${slot.id} 的 ${row.id} 行引用了不存在的列：${columnId}`);
          if ("input" in cell && cell.input.type === "choice") repeated(`${slot.id} 的 ${row.id} 行 ${columnId} 格`, cell.input.options.map((option) => option.id));
        }
      }
    }
  }
  return problems;
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  const names = new Set(left);
  return names.size === new Set(right).size && right.every((name) => names.has(name));
}

/**
 * 把插件或 Agent 给的内容整理成可以交付的 Item：按词汇严格校验（多带的字段在这里被拒绝），
 * 检查 id 等一致性，算出 requires；没有 version 时对公开内容计算。
 */
export async function prepareItem(input: ItemDraft | Item): Promise<Item> {
  if (!Value.Check(ItemInputSchema, input)) {
    const [first] = Value.Errors(ItemInputSchema, input);
    throw new RepaFault("invalid_item", "Item 不符合交互词汇", { path: first?.instancePath ?? "" });
  }
  const { version, requires, ...draft } = input as ItemDraft & Partial<Pick<Item, "version" | "requires">>;
  const problems = itemProblems(draft);
  if (problems.length > 0) throw new RepaFault("invalid_item", "Item 的结构不一致", { problems });
  const needed = requiredCapabilities(draft);
  if (requires !== undefined && !sameNames(requires, needed)) {
    throw new RepaFault("invalid_item", "Item 的 requires 与结构不符，应由 requiredCapabilities 计算", { requires: needed });
  }
  return { ...draft, version: version ?? await contentVersion(draft), requires: needed };
}
