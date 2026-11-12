import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { readFileSync } from "node:fs";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Button } from "../src/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../src/components/ui/dialog";
import { Input } from "../src/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../src/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../src/components/ui/sheet";
import { Textarea } from "../src/components/ui/textarea";
import { useDraftSend } from "../src/hooks/use-draft-send";
import { FluidProvider } from "../src/lib/fluid-provider";
import { mockMatchMedia } from "./match-media";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function escape() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
}

function ControlledDialog({ title, children, open: initial = true }: { title: string; children?: React.ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(initial);
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogContent>
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription>{title}的说明</DialogDescription>
      {children}
    </DialogContent>
  </Dialog>;
}

/** 焦点进了弹层，它的 Esc 监听才算就绪。 */
async function focused(name: string) {
  const dialog = await screen.findByRole("dialog", { name });
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
}

describe("输入法选字", () => {
  it.each([
    ["输入框", Input],
    ["文本框", Textarea],
  ] as const)("%s 选字时回车和方向键不交给外部处理", (_name, Control) => {
    const onKeyDown = vi.fn();
    render(<Control aria-label="内容" onKeyDown={onKeyDown} />);
    const field = screen.getByLabelText("内容");
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    fireEvent.keyDown(field, { key: "ArrowDown", isComposing: true });
    fireEvent.keyDown(field, { key: "Enter", keyCode: 229 });
    expect(onKeyDown).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onKeyDown).toHaveBeenCalledOnce();
  });

  it("Safari 确认候选词的回车不提交表单", () => {
    render(<form><Input aria-label="内容" /></form>);
    const notPrevented = fireEvent.keyDown(screen.getByLabelText("内容"), { key: "Enter", keyCode: 229 });
    expect(notPrevented).toBe(false);
  });
});

describe("Esc 逐层退出", () => {
  it("嵌套的对话框每次只关一层", async () => {
    render(<ControlledDialog title="外层"><ControlledDialog title="内层" /></ControlledDialog>);
    await focused("内层");
    escape();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "内层" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "外层" })).toBeTruthy();
    escape();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "外层" })).toBeNull());
  });

  it("互不嵌套的对话框只关最后打开的", async () => {
    function Stack() {
      const [second, setSecond] = useState(false);
      return <>
        <ControlledDialog title="设置"><Button onClick={() => setSecond(true)}>再开一个</Button></ControlledDialog>
        {second && <ControlledDialog title="确认" />}
      </>;
    }
    render(<Stack />);
    fireEvent.click(await screen.findByRole("button", { name: "再开一个" }));
    await focused("确认");
    escape();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "确认", hidden: true })).toBeNull());
    // 退场动画的兜底计时结束后再看，被一起关掉的弹窗这时才会卸载。
    await act(() => new Promise((resolve) => { setTimeout(resolve, 400); }));
    expect(screen.getByRole("dialog", { name: "设置", hidden: true })).toBeTruthy();
  });

  it("下拉打开时只关下拉", async () => {
    mockMatchMedia();
    render(<ControlledDialog title="表单">
      <Select value="a" onValueChange={() => undefined}>
        <SelectTrigger aria-label="类型" />
        <SelectContent>
          <SelectItem index={0} value="a">甲</SelectItem>
          <SelectItem index={1} value="b">乙</SelectItem>
        </SelectContent>
      </Select>
    </ControlledDialog>);
    fireEvent.click(await screen.findByRole("combobox", { name: "类型" }));
    await screen.findByRole("listbox");
    escape();
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(screen.getByRole("dialog", { name: "表单" })).toBeTruthy();
  });
});

describe("失败时保留输入", () => {
  it("没发出去时内容回到输入框，发出去后清空", async () => {
    const deliver = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { result } = renderHook(() => useDraftSend(deliver));
    act(() => result.current.setDraft("没发出去的话"));
    await act(() => result.current.send());
    expect(result.current.draft).toBe("没发出去的话");
    await act(() => result.current.send());
    expect(result.current.draft).toBe("");
  });

  it("等待期间写了新内容时不覆盖", async () => {
    let finish: (sent: boolean) => void = () => undefined;
    const deliver = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useDraftSend(deliver));
    act(() => result.current.setDraft("第一条"));
    let sending: Promise<boolean> = Promise.resolve(false);
    act(() => { sending = result.current.send(); });
    act(() => result.current.setDraft("第二条"));
    await act(async () => { finish(false); await sending; });
    expect(result.current.draft).toBe("第二条");
  });

  it("对话框里的表单提交失败后，填的内容还在", async () => {
    function Form() {
      const [value, setValue] = useState("");
      const [error, setError] = useState(false);
      return <ControlledDialog title="表单">
        <Input aria-label="名称" value={value} onChange={(event) => setValue(event.target.value)} />
        <Button onClick={() => setError(true)}>保存</Button>
        {error && <p>保存失败</p>}
      </ControlledDialog>;
    }
    render(<Form />);
    fireEvent.change(await screen.findByLabelText("名称"), { target: { value: "内容" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("保存失败");
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe("内容");
  });
});

describe("减少动效", () => {
  afterEach(() => {
    MotionGlobalConfig.skipAnimations = false;
  });

  it("按系统偏好跳过 Motion 动画，并随偏好变化", () => {
    const media = Object.assign(new EventTarget(), { matches: true });
    vi.stubGlobal("matchMedia", vi.fn(() => media));
    render(<FluidProvider><p>内容</p></FluidProvider>);
    expect(MotionGlobalConfig.skipAnimations).toBe(true);
    media.matches = false;
    act(() => { media.dispatchEvent(new Event("change")); });
    expect(MotionGlobalConfig.skipAnimations).toBe(false);
  });

  it("CSS 动画和过渡对所有元素停掉", () => {
    const css = readFileSync("src/components/ui/styles.css", "utf8");
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{\s*animation: none !important;\s*transition: none !important;/);
  });
});

describe("焦点恢复", () => {
  it("由触发器打开的对话框关闭后焦点回到触发器", async () => {
    render(<Dialog>
      <DialogTrigger asChild><Button>打开</Button></DialogTrigger>
      <DialogContent><DialogTitle>标题</DialogTitle><DialogDescription>说明</DialogDescription></DialogContent>
    </Dialog>);
    const trigger = screen.getByRole("button", { name: "打开" });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole("dialog");
    escape();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("由外部按钮受控打开的对话框关闭后焦点回到按钮", async () => {
    function Page() {
      const [open, setOpen] = useState(false);
      return <>
        <Button onClick={() => setOpen(true)}>打开</Button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent><DialogTitle>标题</DialogTitle><DialogDescription>说明</DialogDescription></DialogContent>
        </Dialog>
      </>;
    }
    render(<Page />);
    const button = screen.getByRole("button", { name: "打开" });
    button.focus();
    fireEvent.click(button);
    await screen.findByRole("dialog");
    escape();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it("抽屉关闭后焦点回到打开它的按钮", async () => {
    function Page() {
      const [open, setOpen] = useState(false);
      return <>
        <Button onClick={() => setOpen(true)}>打开</Button>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent>
            <SheetHeader><SheetTitle>抽屉</SheetTitle><SheetDescription>说明</SheetDescription></SheetHeader>
          </SheetContent>
        </Sheet>
      </>;
    }
    render(<Page />);
    const button = screen.getByRole("button", { name: "打开" });
    button.focus();
    fireEvent.click(button);
    await screen.findByRole("dialog");
    escape();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it("下拉关闭后焦点回到触发器", async () => {
    mockMatchMedia();
    render(<Select value="a" onValueChange={() => undefined}>
      <SelectTrigger aria-label="类型" />
      <SelectContent><SelectItem index={0} value="a">甲</SelectItem></SelectContent>
    </Select>);
    const trigger = screen.getByRole("combobox", { name: "类型" });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole("listbox");
    escape();
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
