import { readFileSync } from "node:fs";
const css = readFileSync("src/globals.css", "utf8");
import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "../src/components/ui/button";
import { SelectableCard } from "../src/components/ui/selectable-card";
import { Progress } from "../src/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "../src/components/ui/dialog";

afterEach(cleanup);

describe("语义组件契约", () => {
  it("卡片获得键盘焦点不改变选择，按下后选择仍保留", () => {
    function Example() {
      const [selected, setSelected] = useState(false);
      return (
        <SelectableCard
          selected={selected}
          onClick={() => setSelected(!selected)}
        >
          知识卡片
        </SelectableCard>
      );
    }
    render(<Example />);
    const card = screen.getByRole("button", { name: "知识卡片" });
    card.focus();
    expect(card.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(card);
    expect(card.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(card);
  });
  it("普通操作按钮不意外提交表单", () => {
    let submissions = 0;
    render(
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submissions++;
        }}
      >
        <Button>辅助操作</Button>
        <Button type="submit">保存</Button>
      </form>,
    );
    fireEvent.click(screen.getByText("辅助操作"));
    expect(submissions).toBe(0);
    fireEvent.click(screen.getByText("保存"));
    expect(submissions).toBe(1);
  });
  it("进度的可访问值与视觉值一致", () => {
    render(<Progress value={72} aria-label="学习进度" />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "72",
    );
  });
  it("弹窗有名称和描述，Escape 关闭后恢复触发器焦点", async () => {
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>新建</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>新建知识</DialogTitle>
          <DialogDescription>填写知识名称</DialogDescription>
          <input aria-label="名称" />
        </DialogContent>
      </Dialog>,
    );
    const trigger = screen.getByRole("button", { name: "新建" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "新建知识" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

const values = Object.fromEntries(
  [...css.matchAll(/--([\w-]+):\s*(#[\da-f]{6}|var\(--[\w-]+\));/g)].map(
    (m) => [m[1]!, m[2]!],
  ),
);
function resolve(name: string, seen = new Set<string>()): string {
  if (seen.has(name)) throw new Error(`循环 token: ${name}`);
  seen.add(name);
  const value = values[name];
  if (!value) throw new Error(`缺少 token: ${name}`);
  const alias = /var\(--([\w-]+)\)/.exec(value);
  return alias ? resolve(alias[1]!, seen) : value;
}
function luminance(hex: string) {
  const rgb = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
}
function contrast(a: string, b: string) {
  const x = luminance(resolve(a)),
    y = luminance(resolve(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe("主题可读性", () => {
  it.each([
    ["foreground", "background"],
    ["card-foreground", "card"],
    ["muted-foreground", "background"],
    ["muted-foreground", "muted"],
    ["muted-foreground", "card"],
    ["primary-foreground", "primary"],
    ["accent-foreground", "accent"],
    ["status-complete-foreground", "status-complete"],
    ["destructive-foreground", "destructive"],
    ["status-complete", "card"],
  ])("%s 在 %s 上符合正文 AA", (fg, bg) =>
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5),
  );
  it.each([
    ["input", "card"],
    ["ring", "card"],
    ["ring", "accent"],
  ])("%s 在 %s 上有可辨识的控件边界", (fg, bg) =>
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(3),
  );
});

it("拓扑选择复用按钮焦点，切换节点后保留独立选择状态", async () => {
  const { TopologyNode } = await import("../src/components/domain/topology-node");
  function Graph() {
    const [selected, setSelected] = useState("A");
    return <>{["A", "B"].map(name => <TopologyNode key={name} label={name} icon={<span aria-hidden="true">○</span>} selected={selected === name} onClick={() => setSelected(name)} />)}</>;
  }
  render(<Graph />);
  const a = screen.getByRole("button", { name: "A" });
  const b = screen.getByRole("button", { name: "B" });
  b.focus();
  expect(a.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(b);
  expect(a.getAttribute("aria-pressed")).toBe("false");
  expect(b.getAttribute("aria-pressed")).toBe("true");
  expect(document.activeElement).toBe(b);
});

it("搜索清空不会意外提交所在表单", async () => {
  const { SearchInput } = await import("../src/components/ui/search-input");
  let submissions = 0;
  function SearchForm() {
    const [query, setQuery] = useState("知识");
    return <form onSubmit={e => { e.preventDefault(); submissions++; }}><SearchInput label="搜索组件" value={query} onChange={e => setQuery(e.target.value)} onClear={() => setQuery("")} /></form>;
  }
  render(<SearchForm />);
  fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
  expect(screen.getByLabelText("搜索组件")).toBe(screen.getByRole("textbox", { name: "搜索组件" }));
  expect((screen.getByRole("textbox", { name: "搜索组件" }) as HTMLInputElement).value).toBe("");
  expect(screen.queryByRole("button", { name: "清空搜索" })).toBeNull();
  expect(submissions).toBe(0);
});
