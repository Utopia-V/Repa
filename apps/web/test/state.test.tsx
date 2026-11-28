import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { Item, Pending } from "@repa/protocol";

import { Items } from "../src/items";
import { addExtra, extraToday, useData } from "../src/store";

const posts: Array<{ url: string; body: unknown }> = [];
vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.body) posts.push({ url, body: JSON.parse(String(init.body)) });
  return new Response(JSON.stringify({ due: [], fresh: [] }), { status: 200 });
}));
vi.stubGlobal("EventSource", class { close() {} });
afterEach(() => { posts.length = 0; vi.useRealTimers(); });

const quiz = (id: string, questions: Array<{ text: string; options?: string[] }>): [Item, Pending] => [
  { type: "tool", id, name: "quiz", args: { questions }, done: false, isError: false, output: "" },
  { kind: "quiz", id, questions },
];

test("最后一题是单选时在选项上按回车，交上去的是刚选的那一项", async () => {
  const [item, pending] = quiz("q1", [{ text: "选哪个", options: ["甲", "乙"] }]);
  render(<Items items={[item]} pending={[pending]} running folder="" review={false} />);
  await act(async () => { fireEvent.keyDown(screen.getByRole("radio", { name: "乙" }), { key: "Enter" }); });
  expect(posts).toEqual([{ url: "/api/pending/q1", body: { answers: ["乙"] } }]);
});

test("题目卡片写了一半，对话重新挂载（复习中点开卡片、关掉面板）以后作答还在", () => {
  const [item, pending] = quiz("q2", [{ text: "为什么" }]);
  const first = render(<Items items={[item]} pending={[pending]} running folder="" review={false} />);
  fireEvent.change(screen.getByRole("textbox", { name: "第 1 题的回答" }), { target: { value: "写了一半" } });
  first.unmount();
  render(<Items items={[item]} pending={[pending]} running folder="" review={false} />);
  expect((screen.getByRole("textbox", { name: "第 1 题的回答" }) as HTMLTextAreaElement).value).toBe("写了一半");
});

test("“再来几张”只算当天：过了凌晨 4 点换日以后归零", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 28, 23, 0));
  addExtra(5);
  vi.setSystemTime(new Date(2026, 10, 29, 3, 59));
  expect(extraToday()).toBe(5);
  vi.setSystemTime(new Date(2026, 10, 29, 4, 1));
  expect(extraToday()).toBe(0);
});

function Shown({ path, load }: { path: string; load: (path: string) => Promise<string> }) {
  const { data } = useData(() => load(path), [path]);
  return <p>{data ?? "空"}</p>;
}

test("换了路径以后不再显示上一张的内容，新路径读不出来时也不显示旧的", async () => {
  const load = (path: string) => (path === "甲" ? Promise.resolve("甲的内容") : Promise.reject(new Error("没有")));
  const view = render(<Shown path="甲" load={load} />);
  await act(async () => {});
  expect(view.container.textContent).toBe("甲的内容");
  view.rerender(<Shown path="乙" load={load} />);
  await act(async () => {});
  expect(view.container.textContent).toBe("空");
});

test("复习对话里判过一次以后，末尾有“下一张”和“返回今日”；Agent 又出了一道题在等作答时也照放", async () => {
  const done: Item = { type: "tool", id: "q3", name: "quiz", args: { questions: [{ text: "一" }] }, done: true, isError: false, output: "", details: { quiz: "p1", card: "甲.md", answers: ["答"] } };
  const grade: Item = { type: "tool", id: "g3", name: "grade", args: {}, done: true, isError: false, output: "", details: { quiz: "p1", result: "partial", note: "漏了一点" } };
  const [again, waiting] = quiz("q4", [{ text: "再来一道" }]);
  const view = render(<Items items={[done, grade, again]} pending={[waiting]} running folder="" review />);
  await act(async () => {});
  expect(view.getByRole("button", { name: "返回今日" })).toBeTruthy();
  view.rerender(<Items items={[done, grade, again]} pending={[]} running folder="" review />);
  expect(view.queryByRole("button", { name: "返回今日" })).toBeNull();
});
