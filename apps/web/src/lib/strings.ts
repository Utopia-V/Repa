import { strings } from "@/strings/zh-CN";

export type StringKey = keyof typeof strings;

type Params<S extends string> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | Params<Rest> : never;
type Args<K extends StringKey> = [Params<(typeof strings)[K]>] extends [never]
  ? []
  : [Record<Params<(typeof strings)[K]>, string | number>];

/** 取界面文字。键和 `{name}` 参数都由类型检查。 */
export function t<K extends StringKey>(key: K, ...args: Args<K>): string {
  const text: string = strings[key];
  const params: Record<string, string | number> | undefined = args[0];
  if (params === undefined) return text;
  return text.replace(/\{(\w+)\}/gu, (placeholder, name: string) => String(params[name] ?? placeholder));
}
