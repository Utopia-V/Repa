import { RepaFault, Type } from "@repa/base/plugin";
import type { Plugin, Tool } from "@repa/base/plugin";

import { Materials, MATERIALS_DIRECTORY, type Outcome } from "./materials.js";
import { failureMessage, FORMAT_NAME, UNIT, type Converted, type MissingPage } from "./result.js";

export { conversionCount } from "./convert.js";

/**
 * 一次 materials_read 最多交给模型的字节数与行数。底座在 50 KiB 或 2,000 行处截断工具输出（见 @repa/base 的“处理工具输出”），
 * 这里留出余量，正常情况下由本插件自己分页，模型拿到的总是整页、整张或整段。
 */
export const READ_BYTE_LIMIT = 40_000;
export const READ_LINE_LIMIT = 1_500;

const ListParameters = Type.Object({}, { additionalProperties: false });

const ReadParameters = Type.Object({
  path: Type.String({ description: `相对空间根目录的路径，照 materials_list 列出的写，例如 ${MATERIALS_DIRECTORY}/第一章.pdf` }),
  from: Type.Optional(Type.Integer({ minimum: 1, description: "从第几页（PDF）、第几张（幻灯片）或第几段（Word 文档）读起，默认 1" })),
  to: Type.Optional(Type.Integer({ minimum: 1, description: "读到第几页、张或段为止（含），默认读到本次能交回的上限" })),
}, { additionalProperties: false });

function summary(outcome: Outcome): string {
  switch (outcome.status) {
    case "plain":
      return "文字文件，用 read 直接读";
    case "text":
      return `${FORMAT_NAME[outcome.format]}，${outcome.parts.length} ${UNIT[outcome.format]}`;
    case "failed":
      return `读不出文字：${failureMessage(outcome)}`;
  }
}

function partText(part: string | MissingPage, unit: string): string {
  if (typeof part !== "string") {
    return part.missing === "garbled" ? "（这一页的字体没有给出字符对照，读出来是乱码，略去）" : "（这一页没有文字，可能是图片或扫描）";
  }
  return part.trim() === "" ? `（这一${unit}没有文字）` : part;
}

function span(first: number, last: number, unit: string): string {
  return first === last ? `第 ${first} ${unit}` : `第 ${first}–${last} ${unit}`;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function lineCount(text: string): number {
  return text.split("\n").length;
}

/**
 * 从 from 起按页、张或段拼出文字，到 to 或输出上限为止。至少给出一页：单独一页就超过上限时整页给出，
 * 由底座把全文存进工具输出文件、模型用 read 续读。
 */
export function renderRead(file: string, result: Extract<Converted, { status: "text" }>, from: number, to: number | undefined): string {
  const unit = UNIT[result.format];
  const total = result.parts.length;
  if (from > total) {
    throw new RepaFault("invalid_range", `${file} 只有 ${total} ${unit}，from 不能大于 ${total}。`);
  }
  const last = Math.min(to ?? total, total);
  if (last < from) throw new RepaFault("invalid_range", `to（${last}）不能小于 from（${from}）。`);
  const label = (index: number) => `〔第 ${index} ${unit}〕`;

  const head = `${file}（${FORMAT_NAME[result.format]}，共 ${total} ${unit}）`;
  const blocks: string[] = [];
  let bytes = byteLength(head);
  let lines = 1;
  let end = from - 1;
  for (let index = from; index <= last; index++) {
    const part = result.parts[index - 1] ?? "";
    // Word 文档的段落短而多，一段一行；页和张各自成块，中间空一行。
    const block = unit === "段" ? `${label(index)} ${partText(part, unit)}` : `${label(index)}\n${partText(part, unit)}`;
    const blockBytes = byteLength(block) + 2;
    const blockLines = lineCount(block) + 1;
    if (blocks.length > 0 && (bytes + blockBytes > READ_BYTE_LIMIT || lines + blockLines > READ_LINE_LIMIT)) break;
    blocks.push(block);
    bytes += blockBytes;
    lines += blockLines;
    end = index;
  }
  const separator = unit === "段" ? "\n" : "\n\n";
  let text = `${head}${span(from, end, unit)}：\n\n${blocks.join(separator)}`;
  if (end < last) {
    text += `\n\n一次交回的文字到了上限，${span(end + 1, last, unit)}没有读；接着读时 from 填 ${end + 1}。`;
  } else if (last < total) {
    text += `\n\n（后面还有${span(last + 1, total, unit)}。）`;
  }
  return text;
}

/** 课件转文字插件：把空间 materials/ 下的 PDF、幻灯片和 Word 文档读成文字，交给通用 Agent。 */
export const materialsPlugin = {
  id: "materials",
  async open(host) {
    const materials = new Materials(host.space.root, host.space.dataDir);

    const list: Tool = {
      name: "materials_list",
      description: `列出空间 ${MATERIALS_DIRECTORY}/ 下的文件：每个文件的格式和页数（PDF）、张数（幻灯片）或段数（Word 文档），读不出文字的写明原因。第一次列出时要逐个解析文件，之后用缓存。`,
      parameters: ListParameters,
      async execute(_input, context) {
        const files = await materials.list(context.signal);
        if (files === undefined) return { text: `空间里还没有 ${MATERIALS_DIRECTORY}/ 文件夹，学习者还没有放进课件。` };
        if (files.length === 0) return { text: `${MATERIALS_DIRECTORY}/ 里还没有文件。` };
        const lines = files.map((file) => `- ${file.path}：${summary(file.outcome)}`);
        return { text: `${MATERIALS_DIRECTORY}/ 里有 ${files.length} 个文件：\n${lines.join("\n")}` };
      },
    };

    const read: Tool = {
      name: "materials_read",
      description: `把一个课件读成文字：PDF 按页、幻灯片（PPTX、PPT）按张、Word 文档（DOCX、DOC）按段，每一块前标出页码、张号或段号，引用出处时照着写。一次最多交回约 ${Math.round(READ_BYTE_LIMIT / 1000)} KB，读不完时结果末尾写明从哪里接着读。`,
      parameters: ReadParameters,
      async execute(input, context) {
        const { path: file, from = 1, to } = input as { path: string; from?: number; to?: number };
        const { path: normalized, outcome } = await materials.read(file, context.signal);
        switch (outcome.status) {
          case "plain":
            return { text: `${normalized} 是文字文件，用 read 直接读。` };
          case "failed":
            return { text: `${normalized} 读不出文字：${failureMessage(outcome)}` };
          case "text":
            return { text: renderRead(normalized, outcome, from, to) };
        }
      },
    };

    return {
      instructions: () => `学习者的课件放在空间的 ${MATERIALS_DIRECTORY}/ 里。PDF、幻灯片和 Word 文档用 materials_list 查看、用 materials_read 读出文字，不要用 read 直接读这些文件；读不出文字时，把工具给出的原因告诉学习者，不要凭空补出内容。`,
      tools: () => [list, read],
    };
  },
} satisfies Plugin;

export default materialsPlugin;
