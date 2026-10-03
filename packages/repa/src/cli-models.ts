import { createInterface } from "node:readline";
import { Writable, type Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { RepaClient } from "./client.js";
import type { AuthChallenge, AuthQuery, ConnectionInput, ModelConnection, ModelSelection } from "./models/schema.js";

export interface ConfigurationTerminal {
  write(text: string): void;
  read(prompt: string, options?: { secret?: boolean; signal?: AbortSignal }): Promise<string>;
  signal?: AbortSignal;
}

/** readline 的终端编辑继续生效，但 secret 输入不进入输出或历史。 */
export function createConfigurationTerminal(
  input: Readable & { isTTY?: boolean },
  output: Writable & { isTTY?: boolean },
): ConfigurationTerminal & { close(): void } {
  let muted = false;
  let ended = false;
  const lines: string[] = [];
  const controller = new AbortController();
  let waiting: { resolve(value: string): void; reject(error: Error): void } | undefined;
  const proxy = new Writable({
    write(chunk, encoding, callback) {
      if (muted) callback();
      else output.write(chunk, encoding, callback);
    },
  });
  const terminal = Boolean(input.isTTY && output.isTTY);
  const readline = createInterface({ input, output: proxy, terminal, historySize: 0 });
  const cancelled = () => new Error("配置已取消。");
  readline.on("line", (line) => {
    if (waiting) waiting.resolve(line);
    else lines.push(line);
  });
  readline.on("close", () => {
    ended = true;
    waiting?.reject(cancelled());
    if (!lines.length) controller.abort();
  });
  const cancel = () => {
    controller.abort();
    readline.close();
  };
  readline.on("SIGINT", cancel);
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  process.on("SIGHUP", cancel);
  return {
    signal: controller.signal,
    write: (text) => { output.write(`${text}\n`); },
    async read(prompt, options = {}) {
      options.signal?.throwIfAborted();
      controller.signal.throwIfAborted();
      output.write(prompt);
      if (lines.length) return lines.shift() ?? "";
      if (ended) throw cancelled();
      muted = terminal && options.secret === true;
      try {
        return await new Promise<string>((resolve, reject) => {
          const finish = () => {
            options.signal?.removeEventListener("abort", abort);
            waiting = undefined;
          };
          const abort = () => {
            if (terminal) readline.write(null, { ctrl: true, name: "u" });
            finish();
            reject(cancelled());
          };
          waiting = {
            resolve: (line) => { finish(); resolve(line); },
            reject: (error) => { finish(); reject(error); },
          };
          options.signal?.addEventListener("abort", abort, { once: true });
        });
      } finally {
        if (muted) output.write("\n");
        muted = false;
      }
    },
    close() {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
      process.off("SIGHUP", cancel);
      readline.close();
      proxy.destroy();
    },
  };
}

async function choose<T extends { id: string }>(terminal: ConfigurationTerminal, values: T[], prompt: string): Promise<T> {
  const answer = (await terminal.read(prompt)).trim();
  const value = /^\d+$/.test(answer) ? values[Number(answer) - 1] : values.find((item) => item.id === answer);
  if (!value) throw new Error("选择无效，请重新运行 repa configure。");
  return value;
}

async function createConnection(client: RepaClient, terminal: ConfigurationTerminal): Promise<ModelConnection> {
  const name = (await terminal.read("连接名称：")).trim();
  const provider = (await terminal.read("Pi provider ID（例如 openai、anthropic）：")).trim();
  const baseUrl = (await terminal.read("Endpoint（留空使用 provider 默认值）：")).trim();
  const mode = (await terminal.read("认证模式：1. 凭据  2. 无凭据本地服务 [1]：")).trim() || "1";
  if (!["1", "2"].includes(mode)) throw new Error("认证模式无效。");
  return client.call("connection.create", {
    name, provider, authMode: mode === "2" ? "none" : "credentials",
    ...(baseUrl ? { baseUrl } : {}),
  });
}

function notifications(terminal: ConfigurationTerminal, query: AuthQuery, shown: Set<string>): void {
  for (const event of query.notifications) {
    const key = JSON.stringify(event);
    if (shown.has(key)) continue;
    shown.add(key);
    if (event.type === "auth_url") terminal.write(`${event.instructions ?? "打开认证链接："}\n${event.url}`);
    else if (event.type === "device_code") terminal.write(`打开 ${event.verificationUri}\n认证代码：${event.userCode}`);
    else if (event.type === "info") {
      terminal.write(event.message);
      for (const link of event.links ?? []) terminal.write(`${link.label ?? "链接"}：${link.url}`);
    } else terminal.write(event.message);
  }
}

async function answerChallenge(client: RepaClient, terminal: ConfigurationTerminal, query: AuthQuery, challenge: AuthChallenge): Promise<AuthQuery> {
  if (challenge.type === "select")
    for (const option of challenge.options) terminal.write(`${option.id}. ${option.label}${option.description ? ` — ${option.description}` : ""}`);
  const controller = new AbortController();
  const answer = terminal.read(`${challenge.message}${"placeholder" in challenge && challenge.placeholder ? `（${challenge.placeholder}）` : ""}：`, {
    secret: challenge.type === "secret", signal: controller.signal,
  }).then((value) => ({ kind: "answer" as const, value }), (error: unknown) => ({ kind: "error" as const, error }));
  try {
    for (;;) {
      terminal.signal?.throwIfAborted();
      const tick = new AbortController();
      const result = await Promise.race([
        answer,
        delay(200, undefined, { signal: tick.signal }).then(() => ({ kind: "poll" as const })),
      ]).finally(() => tick.abort());
      if (result.kind === "error") throw result.error;
      if (result.kind === "answer") {
        // OAuth callback 可能已在键盘提交前完成；过期 challenge 不再投递。
        const current = await client.call("auth.get", { loginId: query.loginId });
        if (current.status !== "pending" || current.challenge?.id !== challenge.id) return current;
        return client.call("auth.reply", { loginId: query.loginId, challengeId: challenge.id, value: result.value });
      }
      const current = await client.call("auth.get", { loginId: query.loginId });
      if (current.status !== "pending" || current.challenge?.id !== challenge.id) return current;
    }
  } finally {
    controller.abort();
    await answer;
  }
}

async function authenticate(client: RepaClient, terminal: ConfigurationTerminal, connection: ModelConnection): Promise<void> {
  if (connection.authMode === "none") return;
  if (connection.authentication.configured) {
    const existing = (await terminal.read("已有认证：1. 使用现有认证  2. 重新登录 [1]：")).trim() || "1";
    if (existing === "1") return;
    if (existing !== "2") throw new Error("认证选择无效。");
  }
  const type = (await terminal.read("登录方式：1. API key  2. OAuth [1]：")).trim() || "1";
  if (!["1", "2"].includes(type)) throw new Error("登录方式无效。");
  let query = await client.call("auth.start", { connectionId: connection.id, type: type === "2" ? "oauth" : "api_key" });
  const shown = new Set<string>();
  try {
    for (;;) {
      terminal.signal?.throwIfAborted();
      notifications(terminal, query, shown);
      if (query.status !== "pending") break;
      if (query.challenge) query = await answerChallenge(client, terminal, query, query.challenge);
      else {
        await delay(200, undefined, { signal: terminal.signal });
        query = await client.call("auth.get", { loginId: query.loginId });
      }
    }
    if (query.status !== "completed") throw new Error(query.error?.message ?? "登录已取消。");
    terminal.write(query.synchronizationRequired ? "凭据已保存，认证状态需要重新查询。" : "认证已配置。");
  } finally {
    // EOF、Ctrl-C 和远端 prompt 取消都进入可等待的 SDK 收尾。
    if (query.status === "pending") await client.call("auth.cancel", { loginId: query.loginId });
  }
}

export async function configureModels(
  client: RepaClient,
  options: { terminal: ConfigurationTerminal; connectionInput?: ConnectionInput },
): Promise<ModelSelection> {
  const { terminal } = options;
  let connection: ModelConnection;
  if (options.connectionInput) connection = await client.call("connection.create", options.connectionInput);
  else {
    const connections = await client.call("connection.list", {});
    if (!connections.length) connection = await createConnection(client, terminal);
    else {
      for (const [index, item] of connections.entries())
        terminal.write(`${index + 1}. ${item.name} (${item.provider})${item.authentication.configured ? " — 已配置认证" : " — 未配置认证"}`);
      const answer = (await terminal.read("连接序号或 ID；输入 n 创建连接：")).trim();
      if (answer.toLowerCase() === "n") connection = await createConnection(client, terminal);
      else {
        const selected = /^\d+$/.test(answer) ? connections[Number(answer) - 1] : connections.find((item) => item.id === answer);
        if (!selected) throw new Error("连接选择无效。");
        connection = selected;
      }
    }
  }
  await authenticate(client, terminal, connection);
  const catalog = await client.call("model.list", { connectionId: connection.id });
  if (!catalog.models.length) throw new Error("连接没有可选模型；可通过 --connection-config 声明自定义模型。");
  for (const [index, model] of catalog.models.entries()) terminal.write(`${index + 1}. ${model.name} (${model.id})`);
  const model = await choose(terminal, catalog.models, "模型序号或 ID：");
  const selection = { connectionId: connection.id, id: model.id };
  const settings = await client.call("settings.get", { scope: { kind: "application" }, namespace: "runtime" });
  const current = settings.entries.find((entry) => entry.key === "model");
  if (!current) throw new Error("后端没有提供 runtime.model 设置。");
  await client.call("settings.set", { scope: { kind: "application" }, namespace: "runtime", key: "model", value: selection, base: current.revision });
  terminal.write(`已设置应用默认模型：${connection.name} / ${model.name}。`);
  return selection;
}
