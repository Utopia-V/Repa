import { memo, useMemo, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type ExtraProps, type Options } from "react-markdown";
import rehypeShikiFromHighlighter from "@shikijs/rehype/core";
import bash from "@shikijs/langs/shellscript";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import python from "@shikijs/langs/python";
import typescript from "@shikijs/langs/typescript";
import catppuccinMocha from "@shikijs/themes/catppuccin-mocha";
import rehypeKatex from "rehype-katex";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkCjkFriendlyStrikethrough from "remark-cjk-friendly-gfm-strikethrough/parseOnly";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math-extended";
import remend from "remend";
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import "katex/dist/katex.min.css";

import { cn } from "@/lib/utils";

// 中文里 `20~25` 常表示范围，只认双波浪线为删除线。
const textPlugins: NonNullable<Options["remarkPlugins"]> = [
  [remarkGfm, { singleTilde: false }],
  remarkCjkFriendly,
  [remarkCjkFriendlyStrikethrough, { singleTilde: false }],
];
const remarkPlugins: Options["remarkPlugins"] = [...textPlugins, remarkMath];

// 按 Shiki 的细粒度引入只带几种常用语言，同步创建，渲染时不需要等待。
// 语法颜色直接用 Catppuccin Mocha 主题；代码块底色和正文色由 Code token 提供，与主题一致。
const highlighter = createHighlighterCoreSync({
  themes: [catppuccinMocha],
  langs: [bash, javascript, json, python, typescript],
  engine: createJavaScriptRegexEngine(),
});

// 写错的公式显示原文，不让整条消息出错；中文写进公式不在控制台告警。
// 代码只高亮标了语言且已加载的几种，其他语言和没标语言的代码块按纯文本显示。
// 高亮出错时保留原样的代码块，不让整条消息渲染失败。
const highlight: NonNullable<Options["rehypePlugins"]>[number] = [rehypeShikiFromHighlighter, highlighter, { theme: "catppuccin-mocha", addLanguageClass: true, onError: () => undefined }];
const rehypePlugins: Options["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false, strict: false, errorColor: "var(--muted-foreground)" }],
  highlight,
];
const plainRehypePlugins: Options["rehypePlugins"] = [highlight];

const codeText = "font-mono text-[length:var(--type-code-size)] leading-[var(--type-code-line)]";
const headingText = "m-0 font-(family-name:--font-heading) font-semibold";
const linkText = "rounded-sm text-primary underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** 只有浏览器能直接打开的外部地址才渲染成链接，相对路径对 Web 页面没有意义。 */
function externalUrl(url: string | undefined): string | undefined {
  return url && /^(https?:|mailto:)/i.test(url) ? url : undefined;
}

/** Markdown 解析出的类名是数组，Shiki 高亮后是空格分隔的字符串。 */
function codeLanguage(className: unknown): string | undefined {
  const names = Array.isArray(className) ? className : typeof className === "string" ? className.split(" ") : [];
  const language = names.find((name): name is string => typeof name === "string" && name.startsWith("language-"));
  return language?.slice("language-".length);
}

/** 非外部地址的链接（例如课程里的 `repa:concept/…`）交给调用方渲染；返回 undefined 时按普通文字显示。 */
export type RenderLink = (href: string, children: ReactNode) => ReactNode | undefined;

function Anchor({ node: _node, href, children, ...props }: ComponentProps<"a"> & ExtraProps) {
  const url = externalUrl(href);
  if (!url) return <span>{children}</span>;
  return <a
    {...props}
    href={url}
    target="_blank"
    rel="noopener noreferrer"
    className={linkText}
  >{children}</a>;
}

const baseComponents: Components = {
  // 消息位于页面标题之下，标题层级整体下移两级。
  h1: ({ node: _node, ...props }) => <h3 className={cn(headingText, "text-base")} {...props} />,
  h2: ({ node: _node, ...props }) => <h4 className={cn(headingText, "text-base")} {...props} />,
  h3: ({ node: _node, ...props }) => <h5 className={cn(headingText, "text-sm")} {...props} />,
  h4: ({ node: _node, ...props }) => <h6 className={cn(headingText, "text-sm")} {...props} />,
  h5: ({ node: _node, ...props }) => <h6 className={cn(headingText, "text-sm")} {...props} />,
  h6: ({ node: _node, ...props }) => <h6 className={cn(headingText, "text-sm")} {...props} />,
  p: ({ node: _node, ...props }) => <p className="m-0" {...props} />,
  ul: ({ node: _node, className, ...props }) => <ul
    className={cn("m-0 flex flex-col gap-1", className?.includes("contains-task-list") ? "list-none pl-0" : "list-disc pl-5")}
    {...props}
  />,
  ol: ({ node: _node, ...props }) => <ol className="m-0 flex flex-col gap-1 list-decimal pl-5" {...props} />,
  blockquote: ({ node: _node, ...props }) => <blockquote className="m-0 flex flex-col gap-3 border-l border-border pl-3 text-muted-foreground" {...props} />,
  hr: () => <hr className="m-0 h-px border-0 bg-border" />,
  a: Anchor,
  // 外部图片会把浏览记录暴露给第三方，地址也可能是模型编的；只给出说明和链接，由用户决定是否打开。
  img: ({ src, alt }) => {
    const label = `图片：${alt || "未命名"}`;
    const url = typeof src === "string" ? externalUrl(src) : undefined;
    if (!url) return <span className="text-muted-foreground">[{label}]</span>;
    return <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={linkText}
    >[{label}]</a>;
  },
  code: ({ node: _node, className, ...props }) => <code
    className={cn(codeText, "rounded-sm border border-border bg-card px-1 in-[pre]:rounded-none in-[pre]:border-0 in-[pre]:bg-transparent in-[pre]:p-0", className)}
    {...props}
  />,
  pre: ({ node, children }) => {
    const first = node?.children[0];
    const language = first?.type === "element" ? codeLanguage(first.properties.className ?? first.properties.class) : undefined;
    // 代码块统一用深色底，没高亮的代码块也一样；滚动条跟着用深色。
    return <figure className="m-0 flex min-w-0 flex-col rounded-md bg-code-background text-code-foreground [color-scheme:dark]">
      {language && <figcaption className="px-3 pt-2 text-xs text-code-caption">{language}</figcaption>}
      <pre className="m-0 overflow-x-auto p-3">{children}</pre>
    </figure>;
  },
  table: ({ node: _node, ...props }) => <div className="min-w-0 overflow-x-auto">
    <table className="border-collapse" {...props} />
  </div>,
  // 列对齐由 GFM 生成的行内 style 决定，覆盖默认的左对齐。
  th: ({ node: _node, ...props }) => <th className="border border-border px-2 py-1 text-left align-top font-semibold" {...props} />,
  td: ({ node: _node, ...props }) => <td className="border border-border px-2 py-1 text-left align-top" {...props} />,
};

// react-markdown 默认清掉不安全协议的地址；课程里的 repa: 链接要原样交给 renderLink。
// 其他地址照旧清理，Anchor 也只把 http、https、mailto 渲染成真正的链接。
function keepRepaLinks(url: string): string {
  return url.startsWith("repa:") ? url : defaultUrlTransform(url);
}

function withLinks(renderLink: RenderLink): Components {
  return {
    ...baseComponents,
    a: (props) => {
      const { href, children } = props;
      const custom = href !== undefined && !externalUrl(href) ? renderLink(href, children) : undefined;
      return custom ?? <Anchor {...props} />;
    },
  };
}

/**
 * 渲染模型写的 Markdown：GFM、公式（`$…$`、`$$…$$`、`\(…\)`、`\[…\]`）和代码块。
 * 原始 HTML 按文本显示。`streaming` 时先补全还没写完的语法，避免排版来回跳。
 * `math` 为 false 时不排公式，`$` 就是普通字符，用于交互词汇里没有声明公式的内容块。
 * 外部地址在新窗口打开；其他地址交给 `renderLink`，没有处理时只显示链接文字。
 */
export const Markdown = memo(function Markdown({ text, streaming = false, math = true, className, renderLink }: {
  text: string;
  streaming?: boolean;
  math?: boolean;
  className?: string;
  renderLink?: RenderLink | undefined;
}) {
  const components = useMemo(() => renderLink ? withLinks(renderLink) : baseComponents, [renderLink]);
  const source = streaming ? remend(text, { inlineKatex: true, linkMode: "text-only" }) : text;
  return <div
    data-slot="markdown"
    className={cn(
      "flex min-w-0 flex-col gap-3",
      "[&_.katex-display]:m-0 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-1",
      className,
    )}
  >
    <ReactMarkdown
      remarkPlugins={math ? remarkPlugins : textPlugins}
      rehypePlugins={math ? rehypePlugins : plainRehypePlugins}
      components={components}
      urlTransform={renderLink ? keepRepaLinks : defaultUrlTransform}
    >{source}</ReactMarkdown>
  </div>;
});
