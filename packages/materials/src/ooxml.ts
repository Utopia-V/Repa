import { strFromU8, unzipSync } from "fflate";

import { ConversionFailure, PICTURE, type Converted } from "./result.js";

const XML_TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/gu;
const ENTITY = /&(?:#x([0-9a-fA-F]+)|#(\d+)|(lt|gt|amp|quot|apos));/gu;
const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (_match, hex: string | undefined, decimal: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED[name] ?? "";
    return String.fromCodePoint(Number.parseInt(hex ?? decimal ?? "0", hex === undefined ? 10 : 16));
  });
}

/** DrawingML（幻灯片，前缀 a）与 WordprocessingML（Word，前缀 w）的段落、表格和文字元素名不同，读法相同。 */
interface Vocabulary {
  paragraph: string;
  text: string;
  cell: string;
  row: string;
  /** 段内换行与制表符。 */
  breaks: Record<string, string>;
  /** 出现一次就在所在段落记一张图片的元素。 */
  pictures: Set<string>;
}

const DRAWING: Vocabulary = {
  paragraph: "a:p",
  text: "a:t",
  cell: "a:tc",
  row: "a:tr",
  breaks: { "a:br": "\n" },
  pictures: new Set(["p:pic"]),
};

const WORD: Vocabulary = {
  paragraph: "w:p",
  text: "w:t",
  cell: "w:tc",
  row: "w:tr",
  breaks: { "w:br": "\n", "w:cr": "\n", "w:tab": "\t" },
  pictures: new Set(["w:drawing", "w:pict"]),
};

// mc:Fallback 是同一内容给旧程序看的另一份，文本框里的字在其中会读两遍；w:tabs 是段落的制表位定义，其中的 w:tab 不是正文里的制表符。
const SKIPPED = new Set(["mc:Fallback", "w:tabs"]);

/**
 * 把一段 OOXML 读成文字块：表格外的每个段落一块，表格的每一行一块，行内各格用“ | ”隔开。
 * 只取文字元素的内容，删除修订、域代码这类不在文字元素里的东西因此不会混进来。
 */
function blocks(xml: string, vocabulary: Vocabulary): string[] {
  const out: string[] = [];
  let line = "";
  let inText = false;
  let paragraphDepth = 0;
  let skipped = 0;
  let cellDepth = 0;
  let cell: string[] = [];
  let row: string[] = [];
  for (const match of xml.matchAll(XML_TOKEN)) {
    const [, cdata, closing, name, , selfClosing, text] = match;
    if (text !== undefined || cdata !== undefined) {
      if (inText && skipped === 0) line += cdata ?? decodeEntities(text ?? "");
      continue;
    }
    if (name === undefined) continue;
    if (SKIPPED.has(name)) {
      if (!selfClosing) skipped += closing ? -1 : 1;
      continue;
    }
    if (skipped > 0) continue;
    if (name === vocabulary.text) {
      inText = !closing && !selfClosing;
      continue;
    }
    // 段落里的图片（Word 的嵌入图）记在段落里；段落外的（幻灯片上的图片形状）自成一块。
    if (!closing && vocabulary.pictures.has(name)) {
      if (paragraphDepth > 0) line += PICTURE;
      else if (cellDepth > 0) cell.push(PICTURE);
      else out.push(PICTURE);
      continue;
    }
    const breakText = vocabulary.breaks[name];
    if (breakText !== undefined && !closing) {
      line += breakText;
      continue;
    }
    if (name === vocabulary.paragraph && !closing && !selfClosing) {
      paragraphDepth += 1;
      continue;
    }
    if (name === vocabulary.paragraph) {
      if (closing) paragraphDepth -= 1;
      const finished = line.replace(/[ \t]+$/gmu, "");
      line = "";
      if (cellDepth > 0) cell.push(finished);
      else if (finished.trim() !== "") out.push(finished);
      continue;
    }
    if (name === vocabulary.cell) {
      if (!closing && !selfClosing) {
        cellDepth += 1;
        if (cellDepth === 1) cell = [];
      } else if (closing) {
        cellDepth -= 1;
        if (cellDepth === 0) row.push(cell.filter((part) => part.trim() !== "").join(" ").replace(/\n/gu, " "));
      }
      continue;
    }
    // 嵌在格子里的表格并进外层格子，只在最外层的行结束时出一块。
    if (name === vocabulary.row && cellDepth === 0) {
      if (!closing) row = [];
      else if (row.some((part) => part.trim() !== "")) out.push(row.join(" | "));
    }
  }
  return out;
}

type Entries = Record<string, Uint8Array>;

function readZip(data: Uint8Array, wanted: (name: string) => boolean): Entries {
  try {
    return unzipSync(data, { filter: (file) => wanted(file.name) });
  } catch (error) {
    throw new ConversionFailure("damaged", error instanceof Error ? error.message : String(error));
  }
}

function text(entries: Entries, name: string): string {
  const entry = entries[name];
  if (entry === undefined) throw new ConversionFailure("damaged", `缺少 ${name}`);
  return strFromU8(entry);
}

/** 关系文件里 Id 到目标的对照，目标按关系文件所在目录解析成包内路径。 */
function relationships(xml: string, baseDirectory: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?>/gu)) {
    const attributes = match[1] ?? "";
    const id = /\bId="([^"]*)"/u.exec(attributes)?.[1];
    const target = /\bTarget="([^"]*)"/u.exec(attributes)?.[1];
    if (id === undefined || target === undefined) continue;
    result.set(id, resolvePart(baseDirectory, decodeEntities(target)));
  }
  return result;
}

function resolvePart(baseDirectory: string, target: string): string {
  const parts = target.startsWith("/") ? [] : baseDirectory.split("/").filter((part) => part !== "");
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

// 页脚、日期和页码占位符每张都有，读出来只是“第 3 页”一类的噪声。p:sp 不嵌套，所以匹配到第一个 </p:sp> 为止就是同一个形状。
const FOOTER_SHAPE = /<p:sp>(?:(?!<\/p:sp>)[\s\S])*?<p:ph\b[^>]*\btype="(?:sldNum|dt|ftr)"[\s\S]*?<\/p:sp>/gu;

function presentation(data: Uint8Array): Converted {
  const entries = readZip(data, (name) =>
    name === "ppt/presentation.xml" || name === "ppt/_rels/presentation.xml.rels" || /^ppt\/slides\/slide\d+\.xml$/u.test(name));
  const order = relationships(text(entries, "ppt/_rels/presentation.xml.rels"), "ppt");
  const parts: string[] = [];
  for (const match of text(entries, "ppt/presentation.xml").matchAll(/<p:sldId\b[^>]*\br:id="([^"]*)"/gu)) {
    const target = order.get(match[1] ?? "");
    if (target === undefined) throw new ConversionFailure("damaged", `幻灯片 ${match[1] ?? ""} 没有对应的文件`);
    parts.push(blocks(text(entries, target).replace(FOOTER_SHAPE, ""), DRAWING).join("\n"));
  }
  return { status: "text", format: "pptx", parts };
}

function wordDocument(data: Uint8Array): Converted {
  const entries = readZip(data, (name) => name === "word/document.xml");
  return { status: "text", format: "docx", parts: blocks(text(entries, "word/document.xml"), WORD) };
}

/** 按包里有没有演示文稿或文档的主部件分辨 PPTX 与 DOCX，不看扩展名。 */
export function convertOoxml(data: Uint8Array): Converted {
  const names = new Set<string>();
  readZip(data, (name) => {
    names.add(name);
    return false;
  });
  if (names.has("ppt/presentation.xml")) return presentation(data);
  if (names.has("word/document.xml")) return wordDocument(data);
  throw new ConversionFailure("unsupported");
}
