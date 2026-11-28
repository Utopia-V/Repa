import { render } from "@testing-library/react";
import { expect, test } from "vitest";

import { pickOf } from "../src/card";
import { Markdown } from "../src/markdown";
import { addMark, findMarks, removeMark, setNote } from "../src/marks";

const links = { link: (_target: string, children: React.ReactNode) => <a>{children}</a>, image: (src: string) => src };

/** 渲染卡片正文，选中第 nth 处 needle（按页面上所有文字节点数，链接里的也算），走一遍界面的“勾画”，返回写回的原文。 */
function markIn(body: string, needle: string, nth = 0): string | undefined {
  const { container } = render(<Markdown className="md" text={body} links={links} marks />);
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    for (let at = node.data.indexOf(needle); at >= 0; at = node.data.indexOf(needle, at + 1)) {
      if (seen++ !== nth) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      const pick = pickOf(range, container);
      return pick && addMark(body, pick.text, pick.index, pick.rendered, pick.block)?.body;
    }
  }
  throw new Error(`页面上没有第 ${nth} 处 ${needle}`);
}

const BODY = "PTE 给出物理页号，把 PPN 与 VPO 拼起来就是物理地址，见 [[地址翻译]]。\n\n```c\npa = ppn << 12; // 物理地址\n```\n";

test("选中的话在这一段里只有一处时勾画它，写批注、改批注、去掉勾画都只动这一处，其余原文逐字不变", () => {
  const added = markIn(BODY, "就是物理地址");
  expect(added).toBe(BODY.replace("拼起来就是物理地址", "拼起来==就是物理地址=="));
  const [mark] = findMarks(added ?? "");
  if (!mark || !added) throw new Error("没有勾画");
  const noted = setNote(added, mark, "页内偏移\n不用翻译");
  expect(noted).toBe(`${BODY.replace("拼起来就是物理地址", "拼起来==就是物理地址==[^a1]").trimEnd()}\n\n[^a1]: 页内偏移 不用翻译\n`);
  const [withNote] = findMarks(noted);
  expect(withNote).toMatchObject({ id: "a1", note: "页内偏移 不用翻译" });
  if (!withNote) throw new Error("没有批注");
  const changed = setNote(noted, withNote, "改过的批注");
  expect(changed.match(/\[\^a1\]/gu)).toHaveLength(2);
  expect(changed).toContain("[^a1]: 改过的批注\n");
  const [again] = findMarks(changed);
  if (!again) throw new Error("没有勾画");
  expect(removeMark(changed, again).trimEnd()).toBe(BODY.trimEnd());
});

test("批注的脚注正文写在勾画前面时，改批注、清空批注、去掉勾画都不截掉勾画后面的文字", () => {
  const body = "[^a1]: 旧批注\n\n第一段 ==页表是映射==[^a1] 之后的文字。\n";
  const [mark] = findMarks(body);
  if (!mark) throw new Error("没有勾画");
  expect(setNote(body, mark, "新批注")).toBe("\n第一段 ==页表是映射==[^a1] 之后的文字。\n\n[^a1]: 新批注\n");
  expect(setNote(body, mark, "")).toBe("\n第一段 ==页表是映射== 之后的文字。\n");
  expect(removeMark(body, mark)).toBe("\n第一段 页表是映射 之后的文字。\n");
});

test("对不准就不勾画：选在链接里、链接文字与隐藏的批注或图片的 alt 同名、跨了汉字之间的软换行，都不改原文", () => {
  const withNote = "页表是映射。\n\n参见 [[页表]]。\n\n==重点==[^a1]\n\n[^a1]: 页表要再看\n";
  expect(markIn(withNote, "页表", 1)).toBeUndefined();
  expect(markIn(withNote, "页表", 0)).toBe(withNote.replace("页表是映射", "==页表==是映射"));
  const withImage = "![页表](a.png)\n\n参见 [[页表]]。\n\n页表很重要。\n";
  expect(markIn(withImage, "页表", 0)).toBeUndefined();
  expect(markIn(withImage, "页表", 1)).toBe(withImage.replace("页表很重要", "==页表==很重要"));
  // 原文两行，页面上排成一行“第一行第二行”：跨行的选区对不回原文，不勾；落在一行里的照常
  expect(markIn("第一行\n第二行\n", "一行第二")).toBeUndefined();
  expect(markIn("第一行\n第二行\n", "第二")).toBe("第一行\n==第二==行\n");
  expect(markIn("甲乙甲乙\n", "甲乙", 1)).toBe("甲乙==甲乙==\n");
});

test("卡片里的勾画显示成淡黄底，批注是句末的小上标，批注的脚注正文不显示，别的脚注照常", () => {
  const text = "这是==勾画的话==[^a1]，这是普通脚注[^n]。\n\n[^a1]: 批注\n[^n]: 普通脚注的正文\n";
  const { container } = render(<Markdown text={text} links={links} marks />);
  expect([...container.querySelectorAll("mark.hl")].map((mark) => mark.textContent)).toEqual(["勾画的话"]);
  expect(container.querySelector("sup.fn")?.textContent).toBe("1");
  expect(container.textContent).not.toContain("批注");
  expect(container.textContent).toContain("普通脚注的正文");
});

test("段落里两个汉字之间的换行不排成空格，代码里的 == 不算勾画，[[链接]] 渲染成链接", () => {
  const { container } = render(<Markdown text={"第一行\n第二行 [[页表|PT]]\n\n`a == b [[不是链接]]`"} links={links} marks />);
  expect(container.querySelector("p")?.textContent).toBe("第一行第二行 PT");
  expect(container.querySelector("a")?.textContent).toBe("PT");
  expect(container.querySelector("code")?.textContent).toBe("a == b [[不是链接]]");
  expect(container.querySelector("mark")).toBeNull();
});
