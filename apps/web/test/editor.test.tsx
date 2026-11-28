import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { Editor } from "../src/card";

const puts: Array<Record<string, unknown>> = [];
vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
  if (init?.body) puts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
  return new Response(JSON.stringify({ mtime: 9, cards: [], folders: [], pages: [], materials: [] }), { status: 200 });
}));
afterEach(() => { puts.length = 0; localStorage.clear(); });

const props = { path: "甲.md", title: "甲", text: "---\nid: x\n---\n\n正文一\n", body: "\n正文一\n", mtime: 1, folder: "", onSaved: () => {} };
const done = async (container: HTMLElement) => act(async () => { fireEvent.click(container.querySelector(".edit-acts button") as HTMLElement); });

test("开始编辑以后卡片被别处改过、重新读到新的修改时间，点“完成”仍带开始编辑时的修改时间，交给后端去拒绝", async () => {
  const { container, rerender } = render(<Editor {...props} />);
  fireEvent.click(container.querySelector("button") as HTMLElement);
  expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("正文一\n");
  fireEvent.change(container.querySelector("textarea") as HTMLElement, { target: { value: "我的改动\n" } });
  rerender(<Editor {...props} text={"---\nid: x\n---\n别处写的\n"} body={"别处写的\n"} mtime={2} />);
  await done(container);
  expect(puts.at(-1)).toEqual({ path: "甲.md", text: "---\nid: x\n---\n\n我的改动\n", mtime: 1 });
});

test("隔几天回来，留在本机的草稿仍带当初的修改时间和文件头", async () => {
  localStorage.setItem("repa.draft.甲.md", JSON.stringify({ text: "旧草稿\n", head: "---\nid: x\n---\n\n", mtime: 1 }));
  const { container } = render(<Editor {...props} text={"---\nid: x\nkeep: true\n---\n后来写的\n"} body={"后来写的\n"} mtime={5} />);
  await done(container);
  expect(puts.at(-1)).toEqual({ path: "甲.md", text: "---\nid: x\n---\n\n旧草稿\n", mtime: 1 });
});

test("AGENTS.md 开头像文件头的几行，保存时不会接两次", async () => {
  const text = "---\nnote: 不是卡片\n---\n要求\n";
  const { container } = render(<Editor {...props} path="AGENTS.md" text={text} body={text} plain />);
  fireEvent.click(container.querySelector("button") as HTMLElement);
  await done(container);
  expect(puts.at(-1)).toEqual({ path: "AGENTS.md", text, mtime: 1 });
});
