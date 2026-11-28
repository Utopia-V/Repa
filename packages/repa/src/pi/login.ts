// repa login [提供方] [--api-key] / repa logout <提供方>：把模型的凭据写进 Repa 自己的配置目录。
// 照 Pi 1.6.1 自己的 `pi auth login`（dist/cli/auth-login.js）调用 ModelRuntime.login 与 logout，终端的读写由这里做。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import type { AuthInteraction } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { configDir } from "../config.js";

const [command, ...args] = process.argv.slice(2);
const dir = configDir();
const authPath = path.join(dir, "auth.json");
const runtime = await ModelRuntime.create({ authPath, modelsPath: path.join(dir, "models.json") });
const signal = new AbortController().signal;
const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
const ask = async (message: string) => {
  const line = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await line.question(message)).trim();
  } finally {
    line.close();
  }
};
// 粘贴 API key 不回显：原始模式下逐字读到回车，Ctrl+C 退出
const secret = (message: string) => new Promise<string>((resolve) => {
  let value = "";
  process.stdout.write(message);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", function onData(data: Buffer) {
    for (const char of data.toString("utf8")) {
      if (char === "\u0003") process.exit(130);
      if (char === "\r" || char === "\n") {
        process.stdin.off("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        return resolve(value);
      }
      value = char === "\u007f" ? value.slice(0, -1) : char >= " " ? value + char : value;
    }
  });
});
const choose = async (message: string, options: ReadonlyArray<{ id: string; label: string }>) => {
  process.stdout.write(`${message}\n${options.map((option, index) => `  ${index + 1}. ${option.label}`).join("\n")}\n`);
  for (;;) {
    const option = options[Number(await ask(`选 1-${options.length}：`)) - 1];
    if (option) return option.id;
  }
};
const open = (url: string) => spawn("xdg-open", [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();

if (!process.stdin.isTTY || !process.stdout.isTTY) fail("repa login 和 repa logout 要在终端里运行。");
const providers = runtime.getProviders().filter((provider) => provider.auth.oauth || provider.auth.apiKey?.login);
if (command === "logout") {
  const provider = providers.find((item) => item.id === args[0]) ?? fail(`用法：repa logout <提供方>。提供方：${providers.map((item) => item.id).join("、")}`);
  await runtime.logout(provider.id, { signal });
  process.stdout.write(`已从 ${authPath} 删去 ${provider.name} 的凭据。\n`);
  process.exit(0);
}
const named = args.find((arg) => !arg.startsWith("-"));
const providerId = named ?? await choose("登录哪个提供方：", providers.map((item) => ({ id: item.id, label: `${item.id}  ${item.name}` })));
const provider = providers.find((item) => item.id === providerId) ?? fail(`没有提供方 ${providerId}。`);
const both = provider.auth.oauth && provider.auth.apiKey?.login;
const type = args.includes("--api-key") || !provider.auth.oauth ? "api_key" : both ? await choose("怎样登录：", [{ id: "oauth", label: "账号订阅" }, { id: "api_key", label: "API key" }]) : "oauth";
const interaction: AuthInteraction = {
  signal,
  prompt: async (prompt) => {
    if (prompt.type === "select") return choose(prompt.message, prompt.options);
    const message = `${prompt.message}${prompt.placeholder ? `（${prompt.placeholder}）` : ""}：`;
    return prompt.type === "secret" ? secret(message) : ask(message);
  },
  notify: (event) => {
    if (event.type === "auth_url") {
      process.stdout.write(`在浏览器里打开这个地址登录：\n  ${event.url}\n${event.instructions ?? ""}\n`);
      open(event.url);
    } else if (event.type === "device_code") {
      process.stdout.write(`打开 ${event.verificationUri}，输入 ${event.userCode}\n`);
      open(event.verificationUri);
    } else {
      process.stdout.write(`${event.message}\n`);
    }
  },
};
// 有的提供方（ChatGPT）要一个这台机器上固定不变的编号：第一次用时生成，存在配置目录里
const getDeviceId = () => {
  const file = path.join(dir, "device-id");
  const saved = (() => { try { return readFileSync(file, "utf8").trim(); } catch { return ""; } })();
  if (saved) return saved;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, randomUUID());
  return readFileSync(file, "utf8").trim();
};
await runtime.login(provider.id, type as "oauth" | "api_key", interaction, { getDeviceId, agentName: "Repa" });
// 有的提供方的模型目录要登录以后才取得到，和 Pi 一样登录后刷新一次
await runtime.refresh({ providers: [provider.id], signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
process.stdout.write(`已登录 ${provider.name}，凭据保存在 ${authPath}。\n`);
process.exit(0);
