/**
 * 课件插件给前端的方法：列出 materials/ 里的课件，把本机的文件复制进来。
 *
 * 本文件经 @repa/materials/protocol 导出，只依赖 typebox 与 @repa/base/protocol，浏览器里也能用。
 * 规则与学习插件的协议相同：插件按当前版本严格校验，前端经 readMaterialsResult 宽松读取。
 */
import { Type, type Static } from "typebox";

import { identifier, object, readLenient, type ReadResult } from "@repa/base/protocol";

/** 能读出文字的格式；与 result.ts 的 Format 相同。 */
const FORMATS = ["pdf", "pptx", "ppt", "docx", "doc"] as const;
const FormatSchema = Type.Enum(FORMATS);

/** 选课件的窗口列出的文件扩展名：上面几种格式的文件都以格式名作扩展名，另加常见的文字文件（笔记、提纲）。插件读文件时看内容，不看扩展名。 */
export const MATERIAL_EXTENSIONS: readonly string[] = [...FORMATS.map((format) => `.${format}`), ".txt", ".md"];

/**
 * materials/ 里的一个文件。path 相对空间根目录，用 /；size 是字节数。
 * text：读得出文字，parts 是页数（PDF）、张数（幻灯片）或段数（Word 文档）；plain：文字文件，直接读；
 * failed：读不出文字，reason 是原因的代码，message 是能转述给学习者的一句话。
 */
export const MaterialSchema = Type.Union([
  object({ path: identifier, size: Type.Integer({ minimum: 0 }), status: Type.Literal("text"), format: FormatSchema, parts: Type.Integer({ minimum: 0 }) }),
  object({ path: identifier, size: Type.Integer({ minimum: 0 }), status: Type.Literal("plain") }),
  object({
    path: identifier, size: Type.Integer({ minimum: 0 }), status: Type.Literal("failed"),
    format: Type.Optional(FormatSchema),
    reason: Type.Enum(["scanned", "garbled", "no_text", "encrypted", "unsupported", "old_format", "damaged"]),
    message: Type.String(),
  }),
]);
/** materials/ 里的一个文件及其能否读出文字。 */
export type Material = Static<typeof MaterialSchema>;

/** list 与 add 的结果：materials/ 下的全部文件，按路径排序；还没有 materials/ 时为空。 */
const MaterialsListSchema = object({ files: Type.Array(MaterialSchema) });

/**
 * 本表是 materials 插件方法的 input/result，经底座的 plugin.call 调用。
 * add 把本机的文件（绝对路径）复制进 materials/，文件名不变；返回复制以后的列表。
 */
export const materialsMethods = {
  list: { input: object({}), result: MaterialsListSchema },
  add: { input: object({ paths: Type.Array(identifier, { minItems: 1, maxItems: 100 }) }), result: MaterialsListSchema },
} as const;
/** materials 插件的方法名。 */
export type MaterialsMethod = keyof typeof materialsMethods;
/** 一个 materials 插件方法的输入。 */
export type MaterialsInput<M extends MaterialsMethod> = Static<(typeof materialsMethods)[M]["input"]>;
/** 一个 materials 插件方法的结果。 */
export type MaterialsResult<M extends MaterialsMethod> = Static<(typeof materialsMethods)[M]["result"]>;

/** 前端宽松读取一个方法的结果：不认识的字段丢掉，认不出的文件连同所在的一项丢掉。 */
export function readMaterialsResult<M extends MaterialsMethod>(method: M, value: unknown): ReadResult<MaterialsResult<M>> {
  return readLenient<MaterialsResult<M>>(materialsMethods[method].result, value);
}
