import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Item, ItemResponse } from "@repa/base/protocol";

import { buildResponse, emptyDraft, ItemSlots } from "../src/components/domain/item-form";

afterEach(cleanup);

const version = `sha256:${"0".repeat(64)}`;

function block(id: string, text: string) {
  return { id, content: [{ type: "code" as const, language: "python", text }] };
}

/** 和学习任务区一样组合 ItemSlots：作答后点提交，交出 buildResponse 的结果。 */
function Harness({ item, onSubmit }: { item: Item; onSubmit(response: ItemResponse): void }) {
  const [draft, setDraft] = useState(() => emptyDraft(item));
  return <>
    <ItemSlots item={item} draft={draft} onChange={setDraft} problems={[]} disabled={false} />
    <button type="button" onClick={() => onSubmit(buildResponse(item, draft))}>提交</button>
  </>;
}

function submitted(onSubmit: ReturnType<typeof vi.fn>): ItemResponse {
  fireEvent.click(screen.getByRole("button", { name: "提交" }));
  return onSubmit.mock.calls.at(-1)?.[0] as ItemResponse;
}

it("排列题用按钮调整顺序和缩进，交出的顺序与缩进和界面一致", () => {
  const item: Item = {
    id: "q", version, requires: ["slot.order", "block.code"], body: [],
    slots: [{ id: "lines", type: "order", prompt: [{ type: "markdown", text: "排好这段代码" }], indent: 1, items: [block("a", "total = 0"), block("b", "for n in data:"), block("c", "total += n")] }],
  };
  const onSubmit = vi.fn();
  render(<Harness item={item} onSubmit={onSubmit} />);

  // 没动过也是一份作答：按给出的顺序交。
  expect(submitted(onSubmit).answers.lines).toEqual({ type: "order", items: ["a", "b", "c"], indents: [0, 0, 0] });

  fireEvent.click(screen.getByRole("button", { name: "下移：total = 0" }));
  fireEvent.click(screen.getByRole("button", { name: "上移：total = 0" }));
  fireEvent.click(screen.getByRole("button", { name: "增加缩进：total += n" }));
  expect(screen.getByRole("button", { name: "增加缩进：total += n" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "上移：total = 0" }).hasAttribute("disabled")).toBe(true);

  expect(submitted(onSubmit).answers.lines).toEqual({ type: "order", items: ["a", "b", "c"], indents: [0, 0, 1] });
  fireEvent.click(screen.getByRole("button", { name: "下移：for n in data:" }));
  expect(submitted(onSubmit).answers.lines).toEqual({ type: "order", items: ["a", "c", "b"], indents: [0, 1, 0] });
});

it("可以留下不用的块时从空开始，加入、移出后只交排进去的块", () => {
  const item: Item = {
    id: "q", version, requires: ["slot.order", "block.code"], body: [],
    slots: [{ id: "lines", type: "order", partial: true, items: [block("a", "x = 1"), block("b", "x = 2"), block("c", "print(x)")] }],
  };
  const onSubmit = vi.fn();
  render(<Harness item={item} onSubmit={onSubmit} />);

  expect(submitted(onSubmit).answers.lines).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "加入：x = 2" }));
  fireEvent.click(screen.getByRole("button", { name: "加入：print(x)" }));
  fireEvent.click(screen.getByRole("button", { name: "加入：x = 1" }));
  fireEvent.click(screen.getByRole("button", { name: "移出：x = 1" }));

  // 没有声明缩进的排列题不带 indents。
  expect(submitted(onSubmit).answers.lines).toEqual({ type: "order", items: ["b", "c"] });
  expect(screen.getByRole("button", { name: "加入：x = 1" })).toBeTruthy();
});

it("表格题按行列标题命名输入格，只交填过的格", () => {
  const item: Item = {
    id: "q", version, requires: ["slot.table"], body: [],
    slots: [{
      id: "trace",
      type: "table",
      columns: [{ id: "n", header: "n" }, { id: "kind", header: "类型" }],
      rows: [
        { id: "r1", header: "第 1 行", cells: { n: { input: { type: "text" } }, kind: { input: { type: "choice", options: [{ id: "int", label: "int" }, { id: "str", label: "str" }] } } } },
        { id: "r2", header: "第 2 行", cells: { n: { value: "`5`" }, kind: { input: { type: "choice", options: [{ id: "int", label: "int" }, { id: "str", label: "str" }] } } } },
      ],
    }],
  };
  const onSubmit = vi.fn();
  render(<Harness item={item} onSubmit={onSubmit} />);

  expect(screen.getByRole("combobox", { name: "第 2 行，类型" })).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "第 1 行，n" }), { target: { value: "3" } });

  expect(submitted(onSubmit).answers.trace).toEqual({ type: "table", cells: { r1: { n: { type: "text", text: "3" } } } });
});

it("代码题从起始代码开始，Tab 插入 4 个空格；先按 Esc 再按 Tab 不拦截，可以离开编辑框", () => {
  const item: Item = {
    id: "q", version, requires: ["slot.code"], body: [],
    slots: [{ id: "code", type: "code", language: "python", prompt: [{ type: "markdown", text: "改正它" }], starter: "hours = minutes * 60\n" }],
  };
  const onSubmit = vi.fn();
  render(<Harness item={item} onSubmit={onSubmit} />);
  const editor = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "改正它" });
  expect(editor.value).toBe("hours = minutes * 60\n");

  editor.setSelectionRange(0, 0);
  const tab = fireEvent.keyDown(editor, { key: "Tab" });
  expect(tab).toBe(false);
  expect(submitted(onSubmit).answers.code).toEqual({ type: "code", code: "    hours = minutes * 60\n" });

  fireEvent.keyDown(editor, { key: "Escape" });
  expect(fireEvent.keyDown(editor, { key: "Tab" })).toBe(true);
  expect(editor.value).toBe("    hours = minutes * 60\n");
});
