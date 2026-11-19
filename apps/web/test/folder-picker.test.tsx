import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { RpcError, type RepaClient } from "@repa/base/client";

import { StoreProvider } from "../src/hooks/use-app-store";
import { createAppStore } from "../src/lib/store";
import { LearningSpacePage } from "../src/pages/learning-space";
import { fakeClient } from "./fake-client";

// 选位置这几处的文字还是占位，测试里换成键名（参数照常跟在后面），按键名找元素。
vi.mock("../src/strings/zh-CN", async (importOriginal) => {
  const { strings } = await importOriginal<typeof import("../src/strings/zh-CN")>();
  const byKey = /^(folderPicker\.location|learningSpace\.first\.location)/u;
  return {
    strings: Object.fromEntries(Object.entries(strings).map(([key, value]) => [key, byKey.test(key) ? key + (value.match(/\{\w+\}/gu) ?? []).join("") : value])),
  };
});

afterEach(() => { cleanup(); localStorage.clear(); });

type Folder = { space?: boolean; children?: string[]; error?: unknown };

/** 模拟 Windows 盘符布局的后端：浏览按路径返回子文件夹，打开空间后记入最近列表。 */
function fakeBackend(folders: Record<string, Folder>, options: { failOpen?: unknown } = {}) {
  const recent: string[] = [];
  const parentOf = (path: string) => {
    const index = path.replace(/\\$/, "").lastIndexOf("\\");
    if (path.endsWith(":\\")) return null;
    return index === 2 ? path.slice(0, 3) : path.slice(0, index);
  };
  const join = (path: string, name: string) => path.endsWith("\\") ? `${path}${name}` : `${path}\\${name}`;
  const call = vi.fn((method: string, params: { path?: string; root?: string }) => {
    switch (method) {
      case "space.list":
        return Promise.resolve([...recent]);
      case "space.roots":
        return Promise.resolve([{ path: "C:\\", label: "C:" }, { path: "D:\\", label: "D:" }]);
      case "space.browse": {
        const path = params.path ?? "C:\\Users\\aqua";
        const folder = folders[path];
        if (!folder) return Promise.reject(new RpcError(-32000, "文件夹不存在。", { code: "not_found" }));
        if (folder.error) return Promise.reject(folder.error);
        return Promise.resolve({
          path,
          parent: parentOf(path),
          space: folder.space ?? false,
          entries: (folder.children ?? []).map((name) => ({
            name,
            path: join(path, name),
            space: folders[join(path, name)]?.space ?? false,
          })),
          truncated: false,
        });
      }
      case "space.open":
      case "space.create": {
        if (options.failOpen) return Promise.reject(options.failOpen);
        const root = params.root ?? "";
        recent.unshift(root);
        return Promise.resolve({ root, opening: "opening-1", plugins: [] });
      }
    }
    return Promise.reject(new Error(`未模拟的方法 ${method}`));
  });
  return { call, ...fakeClient(call) };
}

function renderPage(client: RepaClient) {
  const store = createAppStore();
  store.getState().setClient(client);
  render(<StoreProvider store={store}>
    <MemoryRouter initialEntries={["/learning-space"]}>
      <Routes>
        <Route path="/learning-space" element={<LearningSpacePage />} />
        <Route path="/conversation" element={<h2>对话页</h2>} />
      </Routes>
    </MemoryRouter>
  </StoreProvider>);
}

async function openPicker() {
  // 等最近列表读完、页面布局稳定后再点，避免点到即将被替换的按钮。
  await screen.findByRole("heading", { name: "创建第一门课" });
  fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
  const dialog = await screen.findByRole("dialog", { name: "选择文件夹" });
  await within(dialog).findByRole("list", { name: "子文件夹" });
  return dialog;
}

const tree: Record<string, Folder> = {
  "C:\\": { children: ["Users"] },
  "C:\\Users": { children: ["aqua"] },
  "C:\\Users\\aqua": { children: ["notes", "physics"] },
  "C:\\Users\\aqua\\notes": { children: [] },
  "C:\\Users\\aqua\\physics": { space: true },
  "D:\\": { children: ["courses"] },
};

it("从用户目录开始浏览，标出已有空间，进入后提示这是已有空间", async () => {
  renderPage(fakeBackend(tree).client);
  const dialog = await openPicker();

  expect(within(dialog).getByRole("heading", { name: "C:\\Users\\aqua" })).toBeTruthy();
  const physics = within(dialog).getByRole("button", { name: /physics/ });
  expect(physics.textContent).toContain("已有空间");
  fireEvent.click(physics);

  expect(await within(dialog).findByRole("heading", { name: "C:\\Users\\aqua\\physics" })).toBeTruthy();
  expect(within(dialog).getByText("这是已有的学习空间。")).toBeTruthy();
});

it("在普通文件夹点打开后打开空间、关闭选择框并进入对话", async () => {
  const { call, client } = fakeBackend(tree);
  renderPage(client);
  const dialog = await openPicker();
  fireEvent.click(within(dialog).getByRole("button", { name: "notes" }));
  await within(dialog).findByRole("heading", { name: "C:\\Users\\aqua\\notes" });
  expect(within(dialog).getByText("会在这个文件夹里保存 Repa 的数据。")).toBeTruthy();

  fireEvent.click(within(dialog).getByRole("button", { name: "打开" }));

  expect(await screen.findByRole("heading", { name: "对话页" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(call).toHaveBeenCalledWith("space.open", { root: "C:\\Users\\aqua\\notes" });
});

it("走到盘的根目录后上一级列出磁盘，可以换到另一个盘继续浏览", async () => {
  renderPage(fakeBackend(tree).client);
  const dialog = await openPicker();
  const up = within(dialog).getByRole("button", { name: "上一级" });

  fireEvent.click(up);
  await within(dialog).findByRole("heading", { name: "C:\\Users" });
  fireEvent.click(up);
  await within(dialog).findByRole("heading", { name: "C:\\" });
  fireEvent.click(up);
  const disks = await within(dialog).findByRole("list", { name: "磁盘" });
  expect((within(dialog).getByRole("button", { name: "打开" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(disks).getByRole("button", { name: "D:" }));

  expect(await within(dialog).findByRole("heading", { name: "D:\\" })).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "courses" })).toBeTruthy();
});

it("无权限的文件夹显示原因并停留在原来的位置", async () => {
  const locked = new RpcError(-32000, "没有访问这个文件夹的权限。", { code: "permission_denied" });
  renderPage(fakeBackend({ ...tree, "C:\\Users\\aqua\\notes": { error: locked } }).client);
  const dialog = await openPicker();

  fireEvent.click(within(dialog).getByRole("button", { name: "notes" }));

  expect((await within(dialog).findByRole("alert")).textContent).toContain("没有访问这个文件夹的权限。");
  expect(within(dialog).getByRole("heading", { name: "C:\\Users\\aqua" })).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "notes" })).toBeTruthy();
});

it("打开失败时在选择框里显示原因，可以换一个文件夹", async () => {
  const failOpen = new RpcError(-32000, "空间正由另一个 Repa 使用；上次没有正常关闭时，约 30 秒后可重新打开", { code: "space_locked" });
  renderPage(fakeBackend(tree, { failOpen }).client);
  const dialog = await openPicker();

  fireEvent.click(within(dialog).getByRole("button", { name: "打开" }));

  expect((await within(dialog).findByRole("alert")).textContent).toContain("空间正由另一个 Repa 使用；上次没有正常关闭时，约 30 秒后可重新打开");
  expect((within(dialog).getByRole("button", { name: "打开" }) as HTMLButtonElement).disabled).toBe(false);
});

it("读取最近列表期间打开的选择框，在页面切换到首次引导后仍保持打开", async () => {
  const { call, client } = fakeBackend(tree);
  let finishList: (value: string[]) => void = () => {};
  const list = new Promise<string[]>((resolve) => { finishList = resolve; });
  const original = call.getMockImplementation();
  if (!original) throw new Error("模拟后端缺少默认实现");
  call.mockImplementation((method, params) => method === "space.list" ? list : original(method, params));
  renderPage(client);

  fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
  const dialog = await screen.findByRole("dialog", { name: "选择文件夹" });
  finishList([]);

  // 模态框打开时页面其余部分对辅助技术隐藏，因此按 hidden 查找背后的标题。
  expect(await screen.findByRole("heading", { name: "创建第一门课", hidden: true })).toBeTruthy();
  expect(screen.getByRole("dialog", { name: "选择文件夹" })).toBe(dialog);
});

it("新建课程时可以换位置：选 D 盘得到 D:\\Repa，它就是空间，课建在其中的 courses 下；下次新建仍放在那里", async () => {
  const { call, client } = fakeBackend(tree);
  renderPage(client);
  await screen.findByRole("heading", { name: "创建第一门课" });
  // 起名之前就看得到放在哪：缺省是用户目录下的 Repa。
  expect(await screen.findByText("learningSpace.first.location.hintC:\\Users\\aqua\\Repa")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "learningSpace.first.location.change.action" }));
  const dialog = await screen.findByRole("dialog", { name: "folderPicker.location.title" });
  await within(dialog).findByRole("heading", { name: "C:\\Users\\aqua" });
  const up = within(dialog).getByRole("button", { name: "上一级" });
  fireEvent.click(up);
  await within(dialog).findByRole("heading", { name: "C:\\Users" });
  fireEvent.click(up);
  await within(dialog).findByRole("heading", { name: "C:\\" });
  fireEvent.click(up);
  fireEvent.click(within(await within(dialog).findByRole("list", { name: "磁盘" })).getByRole("button", { name: "D:" }));
  await within(dialog).findByRole("heading", { name: "D:\\" });
  expect(within(dialog).getByText("folderPicker.location.hintD:\\Repa")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "folderPicker.location.action" }));

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.change(screen.getByLabelText("课程名称"), { target: { value: "操作系统" } });
  expect(screen.getByText("learningSpace.first.location.hintD:\\Repa\\courses\\操作系统")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "创建" }));
  await waitFor(() => expect(call).toHaveBeenCalledWith("space.create", { root: "D:\\Repa", fresh: true }));
  cleanup();

  // 重开应用：位置保存在浏览器里，不再从用户目录算。这里只留下位置，免得页面列出刚建的课而不显示新建课程。
  const saved = JSON.parse(localStorage.getItem("repa.web.preferences") ?? "{}") as { state: { repaFolder?: string } };
  expect(saved.state.repaFolder).toBe("D:\\Repa");
  localStorage.setItem("repa.web.preferences", JSON.stringify({ state: { repaFolder: saved.state.repaFolder }, version: 0 }));
  const next = fakeBackend(tree);
  renderPage(next.client);
  await screen.findByRole("heading", { name: "创建第一门课" });
  expect(await screen.findByText("learningSpace.first.location.hintD:\\Repa")).toBeTruthy();
  expect(next.call).not.toHaveBeenCalledWith("space.browse", expect.anything());
});

it("选位置时选到的文件夹已经叫 Repa 就直接用它；已有的学习空间不能作为位置", async () => {
  renderPage(fakeBackend({ ...tree, "C:\\Users\\aqua": { children: ["Repa", "physics"] }, "C:\\Users\\aqua\\Repa": { children: [] } }).client);
  await screen.findByRole("heading", { name: "创建第一门课" });
  fireEvent.click(await screen.findByRole("button", { name: "learningSpace.first.location.change.action" }));
  const dialog = await screen.findByRole("dialog", { name: "folderPicker.location.title" });
  await within(dialog).findByRole("list", { name: "子文件夹" });

  fireEvent.click(within(dialog).getByRole("button", { name: /physics/ }));
  await within(dialog).findByRole("heading", { name: "C:\\Users\\aqua\\physics" });
  expect(within(dialog).getByText("这是已有的学习空间。")).toBeTruthy();
  expect((within(dialog).getByRole("button", { name: "folderPicker.location.action" }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.click(within(dialog).getByRole("button", { name: "上一级" }));
  fireEvent.click(await within(dialog).findByRole("button", { name: "Repa" }));
  await within(dialog).findByRole("heading", { name: "C:\\Users\\aqua\\Repa" });
  expect(within(dialog).getByText("folderPicker.location.hintC:\\Users\\aqua\\Repa")).toBeTruthy();
});
