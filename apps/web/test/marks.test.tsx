import { render } from "@testing-library/react";
import { expect, test } from "vitest";

import { Markdown } from "../src/markdown";
import { addMark, findMarks, removeMark, setNote } from "../src/marks";

const links = { link: (_target: string, children: React.ReactNode) => <a>{children}</a>, image: (src: string) => src };
const BODY = "PTE 给出物理页号，把 PPN 与 VPO 拼起来就是物理地址，见 [[地址翻译]]。\n\n```c\npa = ppn << 12; // 物理地址\n```\n";

test("选中的话在原文里只有一处时勾画它，写批注、改批注、去掉勾画都只动这一处，其余原文逐字不变", () => {
  const added = addMark(BODY, "就是物理地址", 0, 1);
  expect(added?.body).toBe(BODY.replace("拼起来就是物理地址", "拼起来==就是物理地址=="));
  const [mark] = findMarks(added?.body ?? "");
  expect(mark?.text).toBe("就是物理地址");
  if (!mark || !added) throw new Error("没有勾画");
  const noted = setNote(added.body, mark, "页内偏移\n不用翻译");
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

test("对不准就不勾画：正文与原文的处数不同、落在链接或代码里、跨行，都不改原文", () => {
  // 正文里“物理地址”有两处（第二处在代码块里，原文里被遮住），处数对不上
  expect(addMark(BODY, "物理地址", 0, 2)).toBeUndefined();
  expect(addMark(BODY, "地址翻译", 0, 1)).toBeUndefined();
  expect(addMark("第一行\n第二行", "一行\n第二", 0, 1)).toBeUndefined();
  expect(addMark("甲乙甲乙", "甲乙", 1, 2)?.body).toBe("甲乙==甲乙==");
});

test("卡片里的勾画显示成淡黄底，批注是句末的小上标，批注的脚注正文不显示，别的脚注照常", () => {
  const text = "这是==勾画的话==[^a1]，这是普通脚注[^n]。\n\n[^a1]: 批注\n[^n]: 普通脚注的正文\n";
  const { container } = render(<Markdown text={text} links={links} marks />);
  expect([...container.querySelectorAll("mark.hl")].map((mark) => mark.textContent)).toEqual(["勾画的话"]);
  expect(container.querySelector("sup.fn")?.textContent).toBe("1");
  expect(container.textContent).not.toContain("批注");
  expect(container.textContent).toContain("普通脚注的正文");
});

test("段落里两个汉字之间的换行不排成空格，代码里的 == 不算勾画", () => {
  const { container } = render(<Markdown text={"第一行\n第二行\n\n`a == b`"} links={links} marks />);
  expect(container.querySelector("p")?.textContent).toBe("第一行第二行");
  expect(container.querySelector("mark")).toBeNull();
});
