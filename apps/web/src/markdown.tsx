// 卡片正文和 Agent 回复的渲染：GFM、公式、代码高亮，[[链接]] 按标题找到卡片后可点，找不到的标出来。
// 渲染器沿用旧主线的 Markdown 组件；代码配色换成亮暗两套的 min 主题，底色仍是纸面上的浅色块。
import rehypeShikiFromHighlighter from "@shikijs/rehype/core";
import bash from "@shikijs/langs/shellscript";
import c from "@shikijs/langs/c";
import cpp from "@shikijs/langs/cpp";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import python from "@shikijs/langs/python";
import typescript from "@shikijs/langs/typescript";
import minDark from "@shikijs/themes/min-dark";
import minLight from "@shikijs/themes/min-light";
import { memo, useMemo, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type Options } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkCjkFriendlyStrikethrough from "remark-cjk-friendly-gfm-strikethrough/parseOnly";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math-extended";
import remend from "remend";
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import "katex/dist/katex.min.css";

import { WIKI_LINK } from "@repa/links";

import { remarkMarks } from "./marks";

interface TextNode { type: string; value?: string; children?: TextNode[] }
const HAN = "\\p{Script=Han}，。、；：！？（）「」『』《》“”‘’";
const SOFT_BREAK = new RegExp(`([${HAN}])\\n(?=[${HAN}])`, "gu");
/** 段落里两个汉字之间的换行不显示成空格：浏览器把软换行排成空格，中文里这是多出来的空隙。 */
function remarkCjkBreaks() {
  const walk = (node: TextNode) => {
    if (node.type === "text" && node.value) node.value = node.value.replace(SOFT_BREAK, "$1");
    node.children?.forEach(walk);
  };
  return walk;
}

// 中文里 `20~25` 常表示范围，只认双波浪线为删除线。
const remarkPlugins: NonNullable<Options["remarkPlugins"]> = [[remarkGfm, { singleTilde: false }], remarkCjkFriendly, [remarkCjkFriendlyStrikethrough, { singleTilde: false }], remarkMath, remarkCjkBreaks, remarkWikiLinks];
const cardPlugins = [...remarkPlugins, remarkMarks];

// 按 Shiki 的细粒度引入只带几种常用语言，同步创建，渲染时不需要等待；没标语言或没加载的语言按纯文本显示。
const highlighter = createHighlighterCoreSync({
  themes: [minLight, minDark],
  langs: [bash, c, cpp, javascript, json, python, typescript],
  engine: createJavaScriptRegexEngine(),
});
// 写错的公式显示原文，不让整段出错；高亮出错时保留原样的代码块。
const rehypePlugins: Options["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false, strict: false, errorColor: "var(--sting)" }],
  [rehypeShikiFromHighlighter, highlighter, { themes: { light: "min-light", dark: "min-dark" }, defaultColor: false, onError: () => undefined }],
];

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/iu;

interface MdNode { type: string; value?: string; url?: string; alt?: string; children?: MdNode[] }
/**
 * remark 插件：文字里的 [[链接]] 换成 repa: 链接，![[图片]] 换成 repa-file: 图片；代码里的不是文字节点，不动。
 * 在语法树上换而不在原文上换，块的位置仍是原文的位置，勾画靠它把选区对回原文。
 */
function remarkWikiLinks() {
  const walk = (node: MdNode) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child) => {
      walk(child);
      if (child.type !== "text" || !child.value?.includes("[[")) return [child];
      const out: MdNode[] = [];
      let last = 0;
      for (const match of child.value.matchAll(WIKI_LINK)) {
        const [whole, bang, target = "", label] = match;
        if (match.index > last) out.push({ type: "text", value: child.value.slice(last, match.index) });
        const name = target.trim();
        out.push(bang && IMAGE.test(name)
          ? { type: "image", url: `repa-file:${encodeURI(name)}`, alt: name }
          : { type: "link", url: `repa:${encodeURIComponent(name)}`, children: [{ type: "text", value: label ?? name }] });
        last = match.index + whole.length;
      }
      if (last < child.value.length) out.push({ type: "text", value: child.value.slice(last) });
      return out;
    });
  };
  return walk;
}

/** 链接与图片怎样处理：link 给出 [[目标]] 的渲染，image 把相对路径换成可以显示的地址。 */
export interface MarkdownLinks {
  link: (target: string, children: ReactNode) => ReactNode;
  image: (src: string) => string;
}

type Block = "p" | "li" | "td" | "th" | "blockquote" | "h3" | "h4" | "h5" | "h6";
function block(Tag: Block) {
  return function Block({ node, ...props }: React.HTMLAttributes<HTMLElement> & { node?: { position?: { start: { offset?: number }; end: { offset?: number } } } }) {
    return <Tag {...props} data-start={node?.position?.start.offset} data-end={node?.position?.end.offset} />;
  };
}

const external = (url: string | undefined) => (url && /^(https?:|mailto:)/iu.test(url) ? url : undefined);

/** 渲染 Markdown。streaming 时先补全还没写完的语法，免得排版来回跳；marks 时显示卡片里的勾画与批注。 */
export const Markdown = memo(function Markdown({ text, links, streaming = false, marks = false, className }: { text: string; links: MarkdownLinks; streaming?: boolean; marks?: boolean; className?: string }) {
  const components = useMemo<Components>(() => ({
    // 正文位于卡片标题之下，标题层级整体下移两级。段落一级的块带上它在原文里的起止位置，勾画按它把选区对回原文。
    h1: block("h3"), h2: block("h4"), h3: block("h5"), h4: block("h6"), h5: block("h6"), h6: block("h6"),
    p: block("p"), li: block("li"), td: block("td"), th: block("th"), blockquote: block("blockquote"),
    a: ({ node: _node, href, children }) => {
      if (href?.startsWith("repa:")) return links.link(decodeURIComponent(href.slice(5)), children);
      const url = external(href);
      return url ? <a href={url} target="_blank" rel="noopener noreferrer" className="wl">{children}</a> : <span>{children}</span>;
    },
    // 外部图片会把浏览记录暴露给第三方，只给出链接；知识库里的图片照常显示。
    img: ({ node: _node, src, alt }) => {
      const source = typeof src === "string" ? src : "";
      if (external(source)) return <a href={source} target="_blank" rel="noopener noreferrer" className="wl">[{alt || source}]</a>;
      return <img src={links.image(decodeURI(source.replace(/^repa-file:/u, "")))} alt={alt ?? ""} />;
    },
  }), [links]);
  const source = streaming ? remend(text, { inlineKatex: true, linkMode: "text-only" }) : text;
  return <div className={className}>
    <ReactMarkdown remarkPlugins={marks ? cardPlugins : remarkPlugins} rehypePlugins={rehypePlugins} components={components}
      urlTransform={(url) => (url.startsWith("repa:") || url.startsWith("repa-file:") ? url : defaultUrlTransform(url))}>{source}</ReactMarkdown>
  </div>;
});
