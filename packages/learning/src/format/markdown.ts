import type { Block, Content } from "../interaction.js";
import type { ContentInput } from "./schema.js";

export interface ContentResult {
  content: Content;
  problems: string[];
}

const FENCE = /^(`{3,}|~{3,})[ \t]*([^\s`]*)[ \t]*(.*)$/;

function codeAttributes(rest: string, problems: string[]): Pick<Extract<Block, { type: "code" }>, "startLine" | "highlight"> {
  const attributes: { startLine?: number; highlight?: number[] } = {};
  for (const part of rest.split(/\s+/).filter(Boolean)) {
    const [name, value = ""] = part.split("=", 2);
    if (name === "startLine" && /^[1-9][0-9]*$/.test(value)) {
      attributes.startLine = Number(value);
    } else if (name === "highlight" && /^[1-9][0-9]*(,[1-9][0-9]*)*$/.test(value)) {
      attributes.highlight = value.split(",").map(Number);
    } else {
      problems.push(`代码块标记里有不认识的写法 ${part}；只支持 startLine=数字 和 highlight=数字,数字`);
    }
  }
  return attributes;
}

/**
 * 把一段 Markdown 拆成内容块：从第一列开始的围栏代码块成为 code 块（无语言标记的为 text），
 * 其余文字按原样成为 markdown 块。已经是内容块列表的原样返回。
 */
export function toContent(input: ContentInput): ContentResult {
  if (typeof input !== "string") return { content: input, problems: [] };
  const problems: string[] = [];
  const content: Content = [];
  let prose: string[] = [];
  const flushProse = () => {
    const text = prose.join("\n").replace(/^\s*\n/, "").trimEnd();
    if (text.trim() !== "") content.push({ type: "markdown", text });
    prose = [];
  };
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const open = FENCE.exec(lines[index] ?? "");
    if (!open) {
      prose.push(lines[index] ?? "");
      continue;
    }
    flushProse();
    const marker = open[1] ?? "```";
    const language = open[2] || "text";
    const attributes = codeAttributes(open[3] ?? "", problems);
    // 结束围栏：同一种字符，个数不少于开头，后面只有空白。
    const closing = new RegExp(`^${marker.startsWith("`") ? "`" : "~"}{${marker.length},}[ \\t]*$`);
    const code: string[] = [];
    let closed = false;
    for (index += 1; index < lines.length; index++) {
      const line = lines[index] ?? "";
      if (closing.test(line)) {
        closed = true;
        break;
      }
      code.push(line);
    }
    if (!closed) problems.push(`从 ${marker} 开始的代码块没有结束围栏`);
    content.push({ type: "code", language, text: code.join("\n"), ...attributes });
  }
  flushProse();
  return { content, problems };
}

export interface MarkdownLink {
  url: string;
  image: boolean;
}

/** 找出 Markdown 里的行内链接、图片、尖括号链接和引用式链接定义，用来检查链接协议和概念引用。 */
export function markdownLinks(text: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  const withoutCode = text.replace(/`[^`\n]*`/g, "");
  for (const match of withoutCode.matchAll(/(!?)\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)/g)) {
    links.push({ url: match[2] ?? "", image: match[1] === "!" });
  }
  for (const match of withoutCode.matchAll(/<([a-zA-Z][a-zA-Z0-9+.-]*:[^>\s]+)>/g)) {
    links.push({ url: match[1] ?? "", image: false });
  }
  for (const match of withoutCode.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*<?(\S+?)>?(?:\s+.*)?$/gm)) {
    links.push({ url: match[1] ?? "", image: false });
  }
  return links;
}

/** 内容块里全部 Markdown 文字，代码块不算。 */
export function markdownTexts(content: Content): string[] {
  return content.flatMap((block) => (block.type === "markdown" ? [block.text] : []));
}
