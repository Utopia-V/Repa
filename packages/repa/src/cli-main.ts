import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import lockfile from "proper-lockfile";
import { Check } from "typebox/value";
import { configureModels, createConfigurationTerminal } from "./cli-models.js";
import { ConnectionInputSchema, type ConnectionInput } from "./models/schema.js";
import { ConnectionError, RepaClient } from "./client.js";
import {
  isTerminal,
  type Delivery,
  type Interaction,
  type SessionView,
  type Snapshot,
} from "./protocol.js";
import { startRepaServer, type Connection } from "./server.js";

export interface CliApplication {
  entry: string;
  name?: string;
  startServer?: typeof startRepaServer;
}
interface CliRuntime {
  entry: string;
  name: string;
  startServer: typeof startRepaServer;
}

interface Options {
  serve: boolean;
  configure: boolean;
  connectionConfig?: string;
  directory?: string;
  connectionFile?: string;
  trustExtensions: boolean;
  agentDir?: string;
  newSession: boolean;
  port: number;
  exitWhenDetached: boolean;
}
interface Endpoint extends Connection {
  pid: number;
  trustExtensions: boolean;
  agentDir?: string;
}
const usage = (name: string) => `用法：${name} <space> [--new-session] [--trust-extensions] [--connect <连接文件>]
      ${name} configure [--connect <连接文件>] [--connection-config <JSON文件>]
      ${name} serve --connection-file <文件> [--port <端口>] [--trust-extensions]

  --agent-dir <目录>       Pi 资源与默认选项目录；Repa 连接凭据由应用目录独立管理
  --exit-when-detached     最后一个客户端离开后，完成已启动任务再退出

诊断输出到 stderr。REPA_LOG_LEVEL 可设为 debug、info、warn、error 或 off，默认 info。

普通启动自动连接或启动本机后端。首次使用先运行 ${name} configure 选择应用默认模型。--trust-extensions 启用的插件代码拥有宿主进程权限。`;

function parse(args: string[]): Options | undefined {
  const options: Options = {
    serve: false,
    configure: false,
    trustExtensions: false,
    newSession: false,
    port: 0,
    exitWhenDetached: false,
  };
  if (args[0] === "serve" || args[0] === "configure") {
    options.serve = args[0] === "serve";
    options.configure = args[0] === "configure";
    args = args.slice(1);
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") return undefined;
    if (arg === "--trust-extensions") options.trustExtensions = true;
    else if (arg === "--new-session") options.newSession = true;
    else if (arg === "--exit-when-detached") options.exitWhenDetached = true;
    else if (
      ["--connect", "--connection-file", "--connection-config", "--agent-dir", "--port"].includes(arg)
    ) {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} 缺少参数。`);
      if (arg === "--connection-config") options.connectionConfig = path.resolve(value);
      else if (arg === "--agent-dir") options.agentDir = path.resolve(value);
      else if (arg === "--port") {
        options.port = Number(value);
        if (
          !Number.isInteger(options.port) ||
          options.port < 0 ||
          options.port > 65535
        )
          throw new Error("端口无效。");
      } else options.connectionFile = path.resolve(value);
    } else if (arg.startsWith("-") || options.directory || options.serve || options.configure)
      throw new Error(`未知参数：${arg}`);
    else options.directory = path.resolve(arg);
  }
  if (options.serve && !options.connectionFile)
    throw new Error("独立后端需要 --connection-file。");
  if (options.connectionConfig && !options.configure)
    throw new Error("--connection-config 只用于 repa configure。");
  return options.serve || options.configure || options.directory ? options : undefined;
}

async function readEndpoint(file: string): Promise<Endpoint | undefined> {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (
      typeof value.url !== "string" ||
      typeof value.token !== "string" ||
      !Number.isInteger(value.pid)
    )
      throw new Error("连接文件无效。");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
async function removeOwned(file: string, token: string): Promise<void> {
  if ((await readEndpoint(file))?.token === token) await unlink(file);
}

async function serve(options: Options, runtime: CliRuntime): Promise<void> {
  const file = options.connectionFile!;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const server = await runtime.startServer({
    port: options.port,
    agentDir: options.agentDir,
    trustExtensions: options.trustExtensions,
    exitWhenDetached: options.exitWhenDetached,
  });
  try {
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({
          ...server.connection,
          pid: process.pid,
          trustExtensions: options.trustExtensions,
          agentDir: options.agentDir,
        }) + "\n",
      );
      await handle.sync();
      // Publishing a complete file prevents another launcher from reading a partial token record.
      await link(temporary, file);
    } finally {
      await handle.close();
      await unlink(temporary);
    }
  } catch (error) {
    await server.close();
    throw error;
  }
  process.send?.({ type: "ready" });
  console.log(`Repa 后端已启动，连接文件：${file}`);
  const quit = () => {
    void server.close("cancel");
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  process.on("SIGHUP", quit);
  try {
    await server.closed;
  } finally {
    process.off("SIGINT", quit);
    process.off("SIGTERM", quit);
    process.off("SIGHUP", quit);
    await removeOwned(file, server.connection.token);
  }
}

async function connect(
  options: Options, runtime: CliRuntime,
): Promise<{ client: RepaClient; file: string }> {
  const runtimeDirectory = path.join(
    process.env.XDG_RUNTIME_DIR ?? os.tmpdir(),
    `${runtime.name}-${process.getuid?.() ?? os.userInfo().username}`,
  );
  const file =
    options.connectionFile ?? path.join(runtimeDirectory, "connection.json");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 15000;
  for (;;) {
    const endpoint = await readEndpoint(file);
    if (endpoint) {
      if (alive(endpoint.pid)) {
        if (options.trustExtensions && !endpoint.trustExtensions)
          throw new Error(
            "已有后端未启用扩展信任；可使用独立连接文件启动已授权的后端。",
          );
        if (options.agentDir && options.agentDir !== endpoint.agentDir)
          throw new Error("已有后端使用不同的 Pi 资源与默认选项目录。");
        try {
          return { client: await RepaClient.connect(endpoint), file };
        } catch (error) {
          if (!(error instanceof ConnectionError) || Date.now() > deadline)
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }
      }
    }
    if (options.connectionFile) throw new Error("指定的连接文件没有可用后端。");
    const lockPath = `${file}.starting`;
    const release = await lockfile.lock(file, {
      realpath: false,
      lockfilePath: lockPath,
      retries: { retries: 60, minTimeout: 250, maxTimeout: 250, factor: 1 },
    });
    try {
      // Another launcher may have published its endpoint immediately before this lock was acquired.
      const current = await readEndpoint(file);
      if (current) {
        if (alive(current.pid)) continue;
        await removeOwned(file, current.token);
      }
      const log = await open(`${file}.log`, "a", 0o600);
      const args = [
        "serve",
        "--connection-file",
        file,
        "--exit-when-detached",
        ...(options.trustExtensions ? ["--trust-extensions"] : []),
        ...(options.agentDir ? ["--agent-dir", options.agentDir] : []),
      ];
      const child = fork(runtime.entry, args, {
        detached: true,
        env: { ...process.env, REPA_MANAGED_STDERR: "1" },
        stdio: ["ignore", "ignore", log.fd, "ipc"],
      });
      await log.close();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("后端启动超时。"));
        }, 15000);
        child.once("message", (message) => {
          if (
            message &&
            typeof message === "object" &&
            "type" in message &&
            message.type === "ready"
          ) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`后端启动失败（${code}），日志：${file}.log`));
        });
      });
      child.disconnect();
      child.unref();
    } finally {
      await release();
    }
  }
}

async function configure(options: Options, runtime: CliRuntime): Promise<void> {
  let connectionInput: ConnectionInput | undefined;
  if (options.connectionConfig) {
    const bytes = await readFile(options.connectionConfig, "utf8");
    let value: unknown;
    try { value = JSON.parse(bytes); } catch { throw new Error("连接配置文件不是有效 JSON；不要在其中保存凭据。"); }
    if (!Check(ConnectionInputSchema, value)) throw new Error("连接配置文件不符合 ConnectionInput；不要在其中保存凭据。");
    connectionInput = value;
  }
  const { client } = await connect(options, runtime);
  const terminal = createConfigurationTerminal(process.stdin, process.stdout);
  try {
    await configureModels(client, { terminal, connectionInput });
  } catch (error) {
    if (terminal.signal?.aborted) throw new Error("配置已取消。");
    throw error;
  } finally {
    terminal.close();
    await client.close();
  }
}

function textOf(message: SessionView["messages"][number]): string {
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

async function tui(options: Options, runtime: CliRuntime): Promise<void> {
  const { client, file } = await connect(options, runtime);
  let watch: Awaited<ReturnType<RepaClient["watch"]>> | undefined;
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "You> ",
  });
  readline.pause();
  let current: SessionView | undefined;
  let finished = false;
  let openLineId: string | undefined;
  let rendered = new Map<string, string>();
  const noticeIds = new Set<string>();
  let shownQuestions = new Set<string>();
  const finishLine = () => {
    if (openLineId !== undefined) process.stdout.write("\n");
    openLineId = undefined;
  };
  const render = (snapshot: Snapshot, delivery: Delivery) => {
    if (snapshot.lifecycle === "stopped") {
      finished = true;
      readline.close();
      return;
    }
    current = snapshot.sessions[0];
    if (!current) return;
    if (delivery.type === "changes")
      for (const change of delivery.changes) {
        if (
          change.type === "message" &&
          change.replaces &&
          rendered.has(change.replaces)
        ) {
          rendered.set(change.message.id, rendered.get(change.replaces)!);
          rendered.delete(change.replaces);
          if (openLineId === change.replaces) openLineId = change.message.id;
        }
        if (change.type === "tool") {
          finishLine();
          console.log(`  [tool] ${change.name} ${change.status}`);
        }
      }
    for (const message of current.messages) {
      if (message.role !== "assistant") continue;
      const value = textOf(message);
      const previous = rendered.get(message.id) ?? "";
      if (value !== previous) {
        if (openLineId !== message.id) {
          finishLine();
          process.stdout.write("Repa> ");
          openLineId = message.id;
        }
        process.stdout.write(
          value.startsWith(previous)
            ? value.slice(previous.length)
            : `\n${value}`,
        );
        rendered.set(message.id, value);
      }
      if (!message.streaming && openLineId === message.id) finishLine();
    }
    for (const notice of current.notices)
      if (!noticeIds.has(notice.id)) {
        noticeIds.add(notice.id);
        finishLine();
        console.log(`[${notice.code}] ${notice.message}`);
      }
    for (const question of current.interactions)
      if (!shownQuestions.has(question.id)) {
        finishLine();
        console.log(
          `需要回答：${question.title}\n${question.message ?? question.initialValue ?? ""}\n${question.options?.map((x, i) => `${i + 1}. ${x}`).join("\n") ?? ""}`,
        );
        readline.prompt();
      }
    shownQuestions = new Set(
      current.interactions.map((question) => question.id),
    );
    if (delivery.type === "changes")
      for (const change of delivery.changes)
        if (change.type === "run" && isTerminal(change.run)) {
          finishLine();
          console.log(
            `[任务 ${change.run.status}]${change.run.requestIds?.[0] ? ` 请求 ${change.run.requestIds[0]}` : ""}${change.run.error ? ` ${change.run.error.message}` : ""}`,
          );
          readline.prompt();
        }
  };
  try {
    const space = await client.call("space.open", { path: options.directory! });
    const sessions = await client.call("session.list", { spaceId: space.id });
    const initial =
      options.newSession || !sessions.length
        ? await client.call("session.create", { spaceId: space.id })
        : await client.call("session.get", {
            spaceId: space.id,
            sessionId: sessions[0]!.sessionId,
          });
    const select = async (session: SessionView) => {
      await watch?.stop();
      finishLine();
      rendered = new Map();
      shownQuestions = new Set();
      current = session;
      console.log(`会话 ${session.sessionId}（${space.path}）`);
      const runtime = await client.call("settings.get", {
        scope: { kind: "session", spaceId: space.id, sessionId: session.sessionId }, namespace: "runtime",
      });
      if (runtime.entries.find((entry) => entry.key === "model")?.effective === null)
        console.log("尚未选择模型连接，请先运行 ${name} configure 配置应用默认模型。");
      watch = await client.watch(
        { spaceId: space.id, sessionId: session.sessionId },
        render,
      );
    };
    await select(initial);
    console.log(
      `连接文件：${file}\n命令：/cancel /new /sessions /use <会话ID> /branch <消息ID> /status <请求ID> /queue [输入] /cancel-queued <请求ID> /resume /continue <请求ID> /exit /quit`,
    );
    const replyAttempts = new Map<string, { responseId: string; value: string | boolean | null }>();
    const answer = async (question: Interaction, input: string) => {
      let value: string | boolean | null = input === "/dismiss" ? null : input;
      if (question.kind === "confirm" && value !== null) {
        if (!["yes", "no", "是", "否"].includes(input.toLowerCase()))
          throw new Error("请回复 yes 或 no。");
        value = input === "是" || input.toLowerCase() === "yes";
      } else if (question.kind === "select" && /^\d+$/.test(input))
        value = question.options?.[Number(input) - 1] ?? input;
      const previous = replyAttempts.get(question.id);
      const attempt = previous?.value === value ? previous : { responseId: randomUUID(), value };
      replyAttempts.set(question.id, attempt);
      const confirmation = await client.call("interaction.reply", {
        spaceId: space.id,
        ...("sessionId" in question ? { sessionId: question.sessionId } : {}),
        id: question.id,
        ...attempt,
      });
      replyAttempts.delete(question.id);
      if (confirmation.status === "already_processed") console.log("该问题已经由其他入口回答。");
    };
    const handle = async (line: string) => {
      if (!current || finished) return;
      const input = line.trim();
      if (input === "/exit") {
        finished = true;
        readline.close();
        return;
      }
      if (input === "/quit") {
        await client.call("shutdown", { mode: "cancel" });
        finished = true;
        readline.close();
        return;
      }
      if (input === "/cancel") {
        const run = current.runs.findLast((x) => !isTerminal(x));
        if (run)
          await client.call("run.cancel", {
            spaceId: space.id,
            runId: run.id,
          });
      } else if (input.startsWith("/cancel-queued ")) {
        await client.call("queue.cancel", { spaceId: space.id, sessionId: current.sessionId, requestId: input.slice(15).trim() });
      } else if (input === "/queue") {
        console.log(await client.call("queue.list", { spaceId: space.id, sessionId: current.sessionId }));
      } else if (input === "/resume") {
        await client.call("queue.resume", { spaceId: space.id, sessionId: current.sessionId });
      } else if (input.startsWith("/queue ")) {
        await client.call("session.submit", {
          target: { spaceId: space.id, sessionId: current.sessionId }, requestId: randomUUID(),
          input: { parts: [{ kind: "text", text: input.slice(7) }] }, dispatch: { kind: "queue" },
        });
      } else if (input.startsWith("/continue ")) {
        await client.call("session.continue", {
          target: { spaceId: space.id, sessionId: current.sessionId }, requestId: randomUUID(), previousRequestId: input.slice(10).trim(),
        });
      } else if (input === "/new")
        await select(
          await client.call("session.create", { spaceId: space.id }),
        );
      else if (input === "/sessions") {
        finishLine();
        for (const session of await client.call("session.list", {
          spaceId: space.id,
        }))
          console.log(`${session.sessionId}  ${session.title}`);
      } else if (input.startsWith("/use "))
        await select(
          await client.call("session.get", {
            spaceId: space.id,
            sessionId: input.slice(5).trim(),
          }),
        );
      else if (input.startsWith("/branch "))
        await select(
          await client.call("session.branch", {
            spaceId: space.id,
            sessionId: current.sessionId,
            messageId: input.slice(8).trim(),
          }),
        );
      else if (input.startsWith("/status "))
        console.log(
          await client.call("request.get", {
            spaceId: space.id,
            requestId: input.slice(8).trim(),
          }),
        );
      else if (current.interactions[0])
        await answer(current.interactions[0], input);
      else {
        const requestId = randomUUID();
        try {
          const active = current.runs.findLast(run => !isTerminal(run));
          const receipt = await client.call("session.submit", {
            target: { spaceId: space.id, sessionId: current.sessionId }, requestId,
            input: { parts: [{ kind: "text", text: line }] },
            dispatch: active ? { kind: "steer", expectedRunId: active.id } : { kind: "start" },
          });
          if (receipt.delivery.status === "not_entered")
            console.error(`请求 ${requestId} 未接入：${receipt.delivery.reason}\n原输入：${line}`);
        } catch (error) {
          console.error(`请求 ${requestId}：${String(error)}\n原输入：${line}`);
        }
      }
      readline.prompt();
    };
    let commands = Promise.resolve();
    readline.on("line", (line) => {
      commands = commands
        .then(() => handle(line))
        .catch((error) => console.error(String(error)));
    });
    readline.on("SIGINT", () => {
      if (current?.runs.some((x) => !isTerminal(x))) void handle("/cancel");
      else readline.close();
    });
    client.onConnectionChange((connected) => {
      if (!finished) {
        finishLine();
        console.log(
          connected
            ? "已重新连接后端。"
            : "连接已断开，正在重连；请求结果需要接回后核对。",
        );
      }
    });
    readline.prompt();
    readline.resume();
    await new Promise<void>((resolve) => readline.once("close", resolve));
    await commands;
  } finally {
    finished = true;
    readline.close();
    await client.close();
    finishLine();
  }
}

/** 产品提供服务装配和自身启动入口，共用连接、配置与终端生命周期。 */
export async function runCli(args: string[], application: CliApplication): Promise<void> {
  try {
    const runtime: CliRuntime = {
      entry: application.entry,
      name: application.name ?? "repa",
      startServer: application.startServer ?? startRepaServer,
    };
    if (!path.isAbsolute(runtime.entry) || !/^[a-z][a-z0-9-]*$/.test(runtime.name))
      throw new Error("CLI 入口必须是绝对路径，名称使用小写字母、数字和连字符。");
    const options = parse(args);
    if (!options) console.log(usage(runtime.name));
    else if (options.serve) await serve(options, runtime);
    else if (options.configure) await configure(options, runtime);
    else await tui(options, runtime);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
