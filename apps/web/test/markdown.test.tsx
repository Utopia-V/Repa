import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { Markdown } from "../src/components/ui/markdown";

afterEach(cleanup);

/** KaTeX 同时输出 MathML，读出其中保存的 TeX 原文。 */
function formulas(container: HTMLElement): string[] {
  return [...container.querySelectorAll("annotation")].map((node) => node.textContent ?? "");
}

it("标题、列表、表格、代码按 Markdown 显示，标题层级低于页面标题，中文标点旁的加粗生效", () => {
  const { container } = render(<Markdown text={[
    "# 导数",
    "**定义：**变化率。20~25 是范围，~~删掉~~。",
    "- 第一点\n- 第二点",
    "| 函数 | 导数 |\n| --- | --- |\n| x² | 2x |",
    "用 `diff` 求导：",
    "```python\nprint(1)\n```",
  ].join("\n\n")} />);

  expect(screen.getByRole("heading", { level: 3, name: "导数" })).toBeTruthy();
  expect(screen.getByText("定义：").tagName).toBe("STRONG");
  expect(screen.getByText(/20~25 是范围/).querySelector("del")?.textContent).toBe("删掉");
  expect(within(screen.getByRole("list")).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["第一点", "第二点"]);
  expect(screen.getByRole("cell", { name: "2x" })).toBeTruthy();
  expect(screen.getByText("diff").tagName).toBe("CODE");
  expect(container.querySelector("pre code")?.textContent).toBe("print(1)");
  expect(screen.getByText("python")).toBeTruthy();
});

it("代码块按标注的语言高亮，没注册或没标语言的按纯文本显示", () => {
  const { container } = render(<Markdown text={[
    "```py\ndef f(x):\n    return 'ok'  # 注释\n```",
    "```ts\nconst n: number = 1;\n```",
    "```json\n{\"a\": true}\n```",
    "```bash\necho $HOME\n```",
    "```rust\nfn main() {}\n```",
    "```\nplain text\n```",
  ].join("\n\n")} />);

  const blocks = [...container.querySelectorAll("pre code")];
  // 颜色来自 Catppuccin Mocha：mauve 关键字、blue 函数和键名、green 字符串、peach 常量、overlay2 注释、red 内置命令。
  const tokens = (index: number) => [...blocks[index]!.querySelectorAll("span[style]")]
    .map((span) => [(span as HTMLElement).style.color, span.textContent?.trim()]);
  const mauve = "rgb(203, 166, 247)", blue = "rgb(137, 180, 250)", green = "rgb(166, 227, 161)", peach = "rgb(250, 179, 135)", overlay = "rgb(147, 153, 178)", red = "rgb(243, 139, 168)";
  expect(tokens(0)).toEqual(expect.arrayContaining([[mauve, "def"], [blue, "f"], [green, "'ok'"], [overlay, "# 注释"]]));
  expect(tokens(1)).toEqual(expect.arrayContaining([[mauve, "const"], [mauve, "number"], [peach, "1"]]));
  expect(tokens(2)).toEqual(expect.arrayContaining([[blue, "a"], [peach, "true"]]));
  expect(tokens(3)).toEqual(expect.arrayContaining([[red, "echo"]]));
  expect([...container.querySelectorAll("figcaption")].map((caption) => caption.textContent)).toEqual(["py", "ts", "json", "bash", "rust"]);
  expect(blocks[4]!.querySelector("span")).toBeNull();
  expect(blocks[4]!.textContent).toBe("fn main() {}\n");
  expect(blocks[5]!.querySelector("span")).toBeNull();
});

it("公式支持美元符号和反斜杠两种写法，代码里的符号保持原样", () => {
  const { container } = render(<Markdown text={[
    "设 $f(x)=x^2$，极限 \\(\\lim_{x\\to 0} x\\)。",
    "\\[\na^2+b^2=c^2\n\\]",
    "$$\n\\int_0^1 x\\,dx\n$$",
    "代码 `$y$` 和 `\\(z\\)`",
  ].join("\n\n")} />);

  expect(formulas(container)).toEqual(["f(x)=x^2", "\\lim_{x\\to 0} x", "a^2+b^2=c^2", "\\int_0^1 x\\,dx"]);
  expect(screen.getByText("$y$").tagName).toBe("CODE");
  expect(screen.getByText("\\(z\\)").tagName).toBe("CODE");
});

it("写错的公式显示原文，不影响其他内容", () => {
  render(<Markdown text={"错的 $\\frac{1}$ 后面还在"} />);
  expect(screen.getByText(/后面还在/)).toBeTruthy();
  expect(screen.getByText("\\frac{1}")).toBeTruthy();
});

it("只有外部地址渲染成新标签页链接；图片不加载，原始 HTML 按文本显示", () => {
  const { container } = render(<Markdown text={[
    "[资料](https://example.com/a) [脚本](javascript:alert(1)) [笔记](notes/a.md)",
    "![函数图像](https://example.com/plot.png)",
    "<b>粗</b>",
  ].join("\n\n")} />);

  const link = screen.getByRole("link", { name: "资料" });
  expect(link.getAttribute("href")).toBe("https://example.com/a");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  expect(screen.queryByRole("link", { name: "脚本" })).toBeNull();
  expect(screen.getByText("脚本")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "笔记" })).toBeNull();

  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByRole("link", { name: "[图片：函数图像]" }).getAttribute("href")).toBe("https://example.com/plot.png");

  expect(container.querySelector("b")).toBeNull();
  expect(screen.getByText("<b>粗</b>")).toBeTruthy();
});

it("生成中补全还没写完的语法，写完后按原文解析", () => {
  const { container, rerender } = render(<Markdown streaming text={"这是 **加粗，看 [这里](https://exa"} />);
  expect(screen.getByText("加粗，看 这里").tagName).toBe("STRONG");
  expect(screen.queryByRole("link")).toBeNull();

  rerender(<Markdown streaming text={"块公式：\n\n$$\nx^2"} />);
  expect(formulas(container)).toEqual(["x^2"]);

  rerender(<Markdown text={"这是 **加粗**，看 [这里](https://example.com)"} />);
  expect(screen.getByText("加粗").tagName).toBe("STRONG");
  expect(screen.getByRole("link", { name: "这里" })).toBeTruthy();
});
