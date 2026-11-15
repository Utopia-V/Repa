import { strings } from "@/strings/zh-CN";

// ui-text: ignore 占位标记，不是界面文字
const PLACEHOLDER = "〔待写〕";

// 本机看版式用的草稿：src/strings/draft.local.ts 不进仓库，只覆盖仍是占位的文字；没有这个文件时 glob 为空。测试不读。
const drafts = import.meta.env.MODE === "test" ? {} : import.meta.glob<Record<string, string>>("../strings/draft.local.ts", { eager: true, import: "draft" });
const draft: Record<string, string> = Object.values(drafts)[0] ?? {};

export type StringKey = keyof typeof strings;

type Params<S extends string> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | Params<Rest> : never;
type Args<K extends StringKey> = [Params<(typeof strings)[K]>] extends [never]
  ? []
  : [Record<Params<(typeof strings)[K]>, string | number>];

/** 取界面文字。键和 `{name}` 参数都由类型检查。 */
export function t<K extends StringKey>(key: K, ...args: Args<K>): string {
  const own: string = strings[key];
  const text = own.startsWith(PLACEHOLDER) ? draft[key] ?? own : own;
  const params: Record<string, string | number> | undefined = args[0];
  if (params === undefined) return text;
  return text.replace(/\{(\w+)\}/gu, (placeholder, name: string) => String(params[name] ?? placeholder));
}
