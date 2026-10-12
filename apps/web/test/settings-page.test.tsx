import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { RpcError } from "@repa/base/client";
import type { Result } from "@repa/base/protocol";

import { StoreProvider } from "../src/hooks/use-app-store";
import { createAppStore } from "../src/lib/store";
import { SettingsPage } from "../src/pages/settings";
import { fakeClient } from "./fake-client";

afterEach(() => { cleanup(); localStorage.clear(); });

type Provider = Result<"model.providers">[number];

/**
 * 模拟后端的提供方、凭据与应用设置：OpenAI 来自环境变量，Bedrock 只填 key 不够，登录由测试控制何时结束；
 * `settings.saveError` 有值时下一次 settings.set 以它失败。
 */
function backend() {
  const providers: Provider[] = [
    { id: "bedrock", name: "Amazon Bedrock", methods: [{ type: "api_key", name: "AWS credentials", login: true }], stored: false },
    {
      id: "anthropic", name: "Anthropic", stored: false,
      methods: [{ type: "oauth", name: "Anthropic (Claude Pro/Max)", login: true }, { type: "api_key", name: "Anthropic API key", login: true }],
    },
    { id: "deepseek", name: "DeepSeek", methods: [{ type: "api_key", name: "DeepSeek API key", login: true }], stored: false },
    { id: "openai", name: "OpenAI", methods: [{ type: "api_key", name: "OpenAI API key", login: true }], configured: "api_key", stored: false },
  ];
  const models = [
    { provider: "openai", id: "gpt-5", name: "GPT-5" },
    { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" },
    { provider: "anthropic", id: "claude", name: "Claude" },
  ];
  let chosen: { provider: string; id: string } | undefined;
  const settings: { commandPolicy: "ask" | "fullAccess"; saveError?: unknown } = { commandPolicy: "ask" };
  const logins: { provider: string; type: string; finish(error?: unknown): void }[] = [];
  const connect = (id: string, type: "api_key" | "oauth") => {
    const provider = providers.find((item) => item.id === id)!;
    provider.configured = type;
    provider.stored = true;
  };
  const available = () => models.map((model) => ({
    ...model, available: providers.some((provider) => provider.id === model.provider && provider.configured),
  }));
  const call = vi.fn((method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "model.providers":
        return Promise.resolve(structuredClone(providers));
      case "model.list":
        return Promise.resolve(available());
      case "model.getDefault": {
        const first = available().find((model) => model.available);
        return Promise.resolve(chosen ?? (first ? { provider: first.provider, id: first.id } : null));
      }
      case "model.setDefault":
        chosen = params.model as typeof chosen;
        return Promise.resolve(null);
      case "auth.setKey":
        if (params.provider === "bedrock") {
          return Promise.reject(new RpcError(-32000, "此提供方需要额外登录信息，请使用交互登录", { code: "requires_interactive_login" }));
        }
        connect(String(params.provider), "api_key");
        return Promise.resolve(null);
      case "auth.logout": {
        const provider = providers.find((item) => item.id === params.provider)!;
        delete provider.configured;
        provider.stored = false;
        return Promise.resolve(null);
      }
      case "auth.login":
        return new Promise((resolve, reject) => {
          const provider = String(params.provider);
          const type = params.type as "api_key" | "oauth";
          logins.push({ provider, type, finish: (error) => {
            if (error) return reject(error);
            connect(provider, type);
            resolve(null);
          } });
        });
      case "confirm.reply":
        return Promise.resolve(null);
      case "settings.get":
        return Promise.resolve({ commandPolicy: settings.commandPolicy, recentSpaces: [], prompts: {} });
      case "settings.set": {
        const error = settings.saveError;
        if (error !== undefined) {
          delete settings.saveError;
          return Promise.reject(error);
        }
        settings.commandPolicy = params.commandPolicy as typeof settings.commandPolicy;
        return Promise.resolve({ commandPolicy: settings.commandPolicy, recentSpaces: [], prompts: {} });
      }
      default:
        return Promise.reject(new Error(`未模拟的方法 ${method}`));
    }
  });
  return { call, logins, settings, ...fakeClient(call) };
}

async function renderSettings(fake: ReturnType<typeof backend>) {
  const store = createAppStore();
  store.getState().setClient(fake.client);
  render(<StoreProvider store={store}><MemoryRouter><SettingsPage /></MemoryRouter></StoreProvider>);
  await screen.findByRole("heading", { name: "默认模型" });
  return store;
}

const section = (name: string) => screen.getByRole("heading", { name }).closest("section")!;

it("列出已连接的提供方和默认模型，环境变量里的凭据不能在这里断开", async () => {
  await renderSettings(backend());
  const providers = within(section("模型提供方"));
  expect(providers.getByText("OpenAI")).toBeTruthy();
  expect(providers.getByText("API key，由环境变量或配置文件提供")).toBeTruthy();
  expect(providers.queryByRole("button", { name: "断开" })).toBeNull();
  expect(within(section("默认模型")).getByText("GPT-5")).toBeTruthy();
});

it("搜索提供方并填写 key 连接，之后可以断开", async () => {
  const fake = backend();
  await renderSettings(fake);
  fireEvent.click(screen.getByRole("button", { name: "添加提供方" }));
  const dialog = await screen.findByRole("dialog", { name: "添加提供方" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "搜索提供方" }), { target: { value: "deep" } });
  expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toContain("DeepSeek");
  expect(within(dialog).queryByRole("button", { name: "Anthropic" })).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "DeepSeek" }));

  // 只有一种方式时直接填 key。
  const keyDialog = await screen.findByRole("dialog", { name: "连接 DeepSeek" });
  const key = within(keyDialog).getByLabelText("DeepSeek API key");
  expect(key.getAttribute("type")).toBe("password");
  fireEvent.change(key, { target: { value: " sk-test " } });
  fireEvent.click(within(keyDialog).getByRole("button", { name: "保存" }));

  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(fake.call).toHaveBeenCalledWith("auth.setKey", { provider: "deepseek", key: "sk-test" });
  const providers = within(section("模型提供方"));
  expect(await providers.findByText("DeepSeek")).toBeTruthy();
  fireEvent.click(providers.getByRole("button", { name: "断开" }));
  await vi.waitFor(() => expect(providers.queryByText("DeepSeek")).toBeNull());
  expect(fake.call).toHaveBeenCalledWith("auth.logout", { provider: "deepseek" });
});

it("只填 key 不够的提供方改走交互登录，按提示回答后完成", async () => {
  const fake = backend();
  await renderSettings(fake);
  fireEvent.click(screen.getByRole("button", { name: "添加提供方" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Amazon Bedrock" }));
  const keyDialog = await screen.findByRole("dialog", { name: "连接 Amazon Bedrock" });
  fireEvent.change(within(keyDialog).getByLabelText("AWS credentials"), { target: { value: "key" } });
  fireEvent.click(within(keyDialog).getByRole("button", { name: "保存" }));

  await vi.waitFor(() => expect(fake.logins).toHaveLength(1));
  expect(fake.logins[0]).toMatchObject({ provider: "bedrock", type: "api_key" });
  act(() => fake.emit("confirm.request", { id: "p1", request: { kind: "input", title: "AWS region", message: "例如 us-east-1" } }));
  const dialog = await screen.findByRole("dialog", { name: "登录 Amazon Bedrock" });
  const region = within(dialog).getByRole("textbox", { name: "AWS region" });
  expect(region.getAttribute("aria-describedby")).toBeTruthy();
  fireEvent.change(region, { target: { value: "us-east-1" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "继续" }));
  expect(fake.call).toHaveBeenCalledWith("confirm.reply", { id: "p1", value: "us-east-1" });
  expect(await within(dialog).findByRole("status")).toBeTruthy();

  await act(async () => fake.logins[0]?.finish());
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await within(section("模型提供方")).findByText("Amazon Bedrock")).toBeTruthy();
});

it("账号登录显示后端给的链接和选项，关闭对话框取消等待中的提问", async () => {
  const fake = backend();
  await renderSettings(fake);
  fireEvent.click(screen.getByRole("button", { name: "添加提供方" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Anthropic" }));
  const methods = await screen.findByRole("dialog", { name: "连接 Anthropic" });
  fireEvent.click(within(methods).getByRole("button", { name: /用账号登录/ }));

  await vi.waitFor(() => expect(fake.logins).toHaveLength(1));
  expect(fake.logins[0]).toMatchObject({ provider: "anthropic", type: "oauth" });
  act(() => fake.emit("confirm.request", { id: "d1", request: { kind: "display", title: "打开链接完成登录", url: "https://example.com/auth" } }));
  const dialog = await screen.findByRole("dialog", { name: "登录 Anthropic" });
  const link = within(dialog).getByRole("link", { name: "打开链接" });
  expect(link.getAttribute("href")).toBe("https://example.com/auth");
  expect(link.getAttribute("target")).toBe("_blank");
  // 链接只是展示，收到就确认，后端不必等用户点。
  expect(fake.call).toHaveBeenCalledWith("confirm.reply", { id: "d1", value: true });

  act(() => fake.emit("confirm.request", { id: "s1", request: { kind: "select", title: "选择账户", message: "a：个人\nb：团队", options: ["a", "b"] } }));
  // 选项按钮显示 message 里对应的名称，回复的仍是选项 id。
  fireEvent.click(await within(dialog).findByRole("button", { name: "团队" }));
  expect(fake.call).toHaveBeenCalledWith("confirm.reply", { id: "s1", value: "b" });

  act(() => fake.emit("confirm.request", { id: "c1", request: { kind: "input", title: "粘贴授权码", secret: true } }));
  expect(within(dialog).getByLabelText("粘贴授权码").getAttribute("type")).toBe("password");
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭对话框" }));
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(fake.call).toHaveBeenCalledWith("confirm.reply", { id: "c1", value: null });

  // 取消后后端以失败结束登录，界面不再提示。
  await act(async () => fake.logins[0]?.finish(new RpcError(-32000, "登录失败", { code: "login_failed" })));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("登录失败显示原因，可以重试", async () => {
  const fake = backend();
  await renderSettings(fake);
  fireEvent.click(screen.getByRole("button", { name: "添加提供方" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Anthropic" }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "连接 Anthropic" })).getByRole("button", { name: /用账号登录/ }));
  await vi.waitFor(() => expect(fake.logins).toHaveLength(1));
  await act(async () => fake.logins[0]?.finish(new RpcError(-32000, "登录失败，请检查连接与输入", { code: "login_failed" })));

  const dialog = screen.getByRole("dialog", { name: "登录 Anthropic" });
  expect(within(dialog).getByRole("alert").textContent).toContain("登录失败，请检查连接与输入");
  fireEvent.click(within(dialog).getByRole("button", { name: "重试" }));
  await vi.waitFor(() => expect(fake.logins).toHaveLength(2));
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭对话框" }));
  await act(async () => fake.logins[1]?.finish());
});

it("从已连接提供方的模型里选择默认模型", async () => {
  const fake = backend();
  await renderSettings(fake);
  // 先连接 DeepSeek，让可选模型多于一个。
  fireEvent.click(screen.getByRole("button", { name: "添加提供方" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "DeepSeek" }));
  fireEvent.change(within(await screen.findByRole("dialog", { name: "连接 DeepSeek" })).getByLabelText("DeepSeek API key"), { target: { value: "sk" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  fireEvent.click(within(section("默认模型")).getByRole("button", { name: "更换" }));
  const dialog = await screen.findByRole("dialog", { name: "选择默认模型" });
  const list = within(within(dialog).getByRole("list", { name: "可用模型" }));
  // 没连接的 Anthropic 不出现；当前默认模型处于选中状态。
  expect(list.getAllByRole("button").map((option) => [option.textContent, option.getAttribute("aria-pressed")])).toEqual([
    ["GPT-5OpenAI", "true"],
    ["DeepSeek ChatDeepSeek", "false"],
  ]);
  fireEvent.change(within(dialog).getByRole("textbox", { name: "搜索模型" }), { target: { value: "deepseek" } });
  expect(list.getAllByRole("button")).toHaveLength(1);
  fireEvent.click(list.getByRole("button", { name: /DeepSeek Chat/ }));

  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(fake.call).toHaveBeenCalledWith("model.setDefault", { model: { provider: "deepseek", id: "deepseek-chat" } });
  expect(await within(section("默认模型")).findByText("DeepSeek Chat")).toBeTruthy();
});

it("开启完全访问前先说明后果，取消后仍然每次询问，确认后才保存", async () => {
  const fake = backend();
  await renderSettings(fake);
  const policy = within(section("命令授权"));
  const ask = await policy.findByRole("radio", { name: "每次询问" });
  const full = policy.getByRole("radio", { name: "完全访问" });
  expect(ask.getAttribute("aria-checked")).toBe("true");
  expect(full.getAttribute("aria-checked")).toBe("false");

  fireEvent.click(full);
  const dialog = await screen.findByRole("dialog", { name: "让 Agent 直接执行命令？" });
  expect(within(dialog).getByText(/学习空间之外的文件/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(fake.call).not.toHaveBeenCalledWith("settings.set", expect.anything());
  expect(ask.getAttribute("aria-checked")).toBe("true");

  fireEvent.click(full);
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "开启完全访问" }));
  await vi.waitFor(() => expect(full.getAttribute("aria-checked")).toBe("true"));
  expect(fake.call).toHaveBeenCalledWith("settings.set", { commandPolicy: "fullAccess" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("从完全访问改回每次询问时直接保存", async () => {
  const fake = backend();
  fake.settings.commandPolicy = "fullAccess";
  await renderSettings(fake);
  const policy = within(section("命令授权"));
  const ask = await policy.findByRole("radio", { name: "每次询问" });
  await vi.waitFor(() => expect(policy.getByRole("radio", { name: "完全访问" }).getAttribute("aria-checked")).toBe("true"));

  fireEvent.click(ask);
  await vi.waitFor(() => expect(ask.getAttribute("aria-checked")).toBe("true"));
  expect(fake.call).toHaveBeenCalledWith("settings.set", { commandPolicy: "ask" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("保存命令授权失败时显示原因，保留原来的策略", async () => {
  const fake = backend();
  fake.settings.saveError = new RpcError(-32000, "设置写入失败", { code: "storage_failed" });
  await renderSettings(fake);
  const policy = within(section("命令授权"));
  fireEvent.click(await policy.findByRole("radio", { name: "完全访问" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "开启完全访问" }));

  expect((await policy.findByRole("alert")).textContent).toContain("无法保存命令授权设置");
  expect(policy.getByRole("radio", { name: "每次询问" }).getAttribute("aria-checked")).toBe("true");
});
