/** 能读出文字的格式。 */
export type Format = "pdf" | "pptx" | "ppt" | "docx" | "doc";

/** 读不出文字的原因。 */
export type FailureReason = "scanned" | "garbled" | "no_text" | "encrypted" | "unsupported" | "old_format" | "damaged";

/** PDF 里没有文字的一页，或者字体给不出字符对照、读出来是乱码的一页。 */
export type MissingPage = { missing: "no_text" | "garbled" };

/**
 * 一个文件转换的结果，按源文件内容的摘要缓存。parts 按页（PDF）、张（幻灯片）或段（Word 文档）排列，
 * 第 i 项是第 i + 1 页、张或段。幻灯片可以有空白的一张，Word 文档只收有文字的段落。
 */
export type Converted =
  | { status: "text"; format: Format; parts: Array<string | MissingPage> }
  | { status: "failed"; format?: Format; reason: FailureReason; detail?: string };

/** 转换中途确定读不出文字时抛出，由转换入口变成 failed 结果。 */
export class ConversionFailure extends Error {
  constructor(readonly reason: FailureReason, readonly detail?: string) {
    super(detail ?? reason);
  }
}

/** 图片在文字里留下的标记。 */
export const PICTURE = "[图片]";

export const UNIT: Record<Format, string> = { pdf: "页", pptx: "张", ppt: "张", docx: "段", doc: "段" };

export const FORMAT_NAME: Record<Format, string> = {
  pdf: "PDF",
  pptx: "PowerPoint 幻灯片",
  ppt: "PowerPoint 97-2003 幻灯片",
  docx: "Word 文档",
  doc: "Word 97-2003 文档",
};

/** 能转述给学习者的一句话。 */
export function failureMessage(result: Extract<Converted, { status: "failed" }>): string {
  switch (result.reason) {
    case "scanned":
      return "这份 PDF 没有文字层，可能是扫描件或图片，读不出文字。";
    case "garbled":
      return "这份 PDF 的字体没有给出字符对照，读出来是乱码，读不出文字。";
    case "no_text":
      return "文件里没有文字，内容可能都在图片里。";
    case "encrypted":
      return "文件设了打开密码，读不出文字；去掉密码后再放进来。";
    case "unsupported":
      return "不支持这种格式；能读出文字的是 PDF、PPTX、PPT、DOCX 和 DOC。";
    case "old_format":
      return "这是 Office 97 以前的旧格式，读不了；用 Office 或 WPS 另存为 PPTX 或 DOCX 后再放进来。";
    case "damaged":
      return `文件已损坏或不完整，打不开${result.detail === undefined ? "" : `（${result.detail}）`}。`;
  }
}
