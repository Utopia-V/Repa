import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  McpAuthRequiredError,
  McpClient,
  McpTimeoutError,
  StdioTransport,
  StreamableHttpTransport,
  toLlmContent,
  type McpTransport,
} from "@earendil-works/pi-mcp";
import { errorText, RepaFault } from "../schema.js";
import type { McpTarget } from "./config.js";

// MCP 客户端只在这个文件里：连接、工具列表、调用与关闭经下面的接口交给 servers.ts。换一个客户端库只改这里。

/** 服务器声明的一个工具，只取登记成 Repa 工具所需的部分。 */
export interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** 连上的一个服务器。 */
export interface McpConnection {
  listTools(): Promise<McpToolSpec[]>;
  /** 结果转成给模型的文字；服务器报告工具失败时 isError 为真。 */
  call(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<{ text: string; isError: boolean }>;
  /** 服务器通知工具列表变了。 */
  onToolsChanged(listener: () => void): void;
  /** 连接不是由 close() 结束的：进程退出、连接断开。reason 是能拿到的原因。 */
  onLost(listener: (reason: RepaFault) => void): void;
  close(): Promise<void>;
}

export interface ConnectOptions {
  /** 列工具、调用的时限，毫秒。 */
  timeoutMs: number;
  /** 起进程到握手完成的时限，毫秒。 */
  startupTimeoutMs: number;
  version: string;
  /** 连接中途被放弃（停用、删除、关闭后端）时中止，握手失败、进程随之结束。 */
  signal: AbortSignal;
}

// 失败原因里附上的 stderr 末尾。起不来的服务器多半在这里写了原因，例如缺依赖、缺环境变量。
const STDERR_TAIL = 600;

// 后端的连接令牌不交给服务器进程。服务器以使用者的身份运行，并不因此隔离，只是不主动交出去。
const WITHHELD_ENV = ["REPA_TOKEN"];

const WINDOWS = process.platform === "win32";

type StdioTarget = Extract<McpTarget, { kind: "stdio" }>;

/** 服务器进程的环境：后端的环境变量（不含 WITHHELD_ENV）加上配置的 env。 */
function serverEnv(target: StdioTarget): Record<string, string> {
  // Windows 的环境变量名不分大小写：配置写 path 而系统是 Path 时，两项同时交给 Node，Node 只留排序在前的系统值，
  // cross-spawn 找命令却用配置的值。先去掉与配置同名（不分大小写）的继承项，配置写的总是生效。
  const fold = (key: string) => WINDOWS ? key.toUpperCase() : key;
  const configured = new Set(Object.keys(target.env).map(fold));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !WITHHELD_ENV.includes(key) && !configured.has(fold(key))) env[key] = value;
  }
  return { ...env, ...target.env };
}

// 连接属于后端，不属于某个空间；没有写 cwd 时在使用者的主目录运行，不随后端的工作目录变化。
const cwdOf = (target: StdioTarget) => target.cwd ?? os.homedir();

function transportFor(target: McpTarget): McpTransport {
  if (target.kind === "http") return new StreamableHttpTransport({ url: target.url, headers: target.headers });
  return new StdioTransport({ command: target.command, args: target.args, env: serverEnv(target), inheritEnv: false, cwd: cwdOf(target) });
}

function stderrTail(transport: McpTransport): string {
  if (!(transport instanceof StdioTransport)) return "";
  const text = transport.stderr.trim();
  return text.length > STDERR_TAIL ? `…${text.slice(-STDERR_TAIL)}` : text;
}

const isFile = (file: string) => stat(file).then(info => info.isFile(), () => false);

/**
 * 命令能不能找到，与 cross-spawn 的找法相同：写了路径的看这个文件，只写名字的依次在 PATH 的各目录里找
 * （Windows 上先找工作目录），Windows 上再试 PATHEXT 的各个扩展名。
 */
async function commandExists(target: StdioTarget): Promise<boolean> {
  const env = serverEnv(target);
  const cwd = cwdOf(target);
  const variable = (name: string) => Object.entries(env).find(([key]) => (WINDOWS ? key.toUpperCase() : key) === name)?.[1] ?? "";
  const extensions = WINDOWS ? ["", ...variable("PATHEXT").split(";").filter(Boolean)] : [""];
  const directories = /[\\/]/u.test(target.command) ? [cwd] : [...(WINDOWS ? [cwd] : []), ...variable("PATH").split(path.delimiter).filter(Boolean)];
  for (const directory of directories) {
    for (const extension of extensions) {
      if (await isFile(path.resolve(cwd, directory, `${target.command}${extension}`))) return true;
    }
  }
  return false;
}

/** 把客户端库的错误换成 Repa 的原因：code 供程序判断，message 给人看。 */
async function reasonFor(error: unknown, target: McpTarget, transport: McpTransport): Promise<RepaFault> {
  if (error instanceof RepaFault) return error;
  if (error instanceof McpAuthRequiredError) return new RepaFault("mcp_auth_required", "服务器需要登录，暂不支持");
  const stderr = stderrTail(transport);
  const detail = stderr === "" ? "" : `\n${stderr}`;
  if (error instanceof McpTimeoutError) return new RepaFault("mcp_timeout", `服务器没有在时限内回答${detail}`);
  if (target.kind === "stdio") {
    // 工作目录不存在时，起进程同样报 ENOENT，并不是命令不在。
    if (!(await stat(cwdOf(target)).then(info => info.isDirectory(), () => false))) {
      return new RepaFault("mcp_cwd_not_found", `工作目录不存在 ${cwdOf(target)}`);
    }
    // 不能只看 ENOENT：Windows 上找不到的命令经 cmd.exe 起来再失败，cross-spawn 在 cmd.exe 退出以后才补发 ENOENT，
    // 这时握手常已因写 initialize 时管道断开（EPIPE）失败，客户端关闭连接，补发的 ENOENT 不再交出来。
    if (!(await commandExists(target))) return new RepaFault("mcp_command_not_found", `找不到命令 ${target.command}`);
  }
  return new RepaFault("mcp_connect_failed", `${errorText(error)}${detail}`);
}

function textOf(content: ReturnType<typeof toLlmContent>): string {
  // 第一版只交文字；图片换成一行说明，不进模型上下文。
  return content.map(part => part.type === "text" ? part.text : `[image ${part.mimeType} omitted]`).join("\n");
}

/** 连上一个服务器并完成握手；失败时进程已经结束，抛出带原因的 RepaFault。 */
export async function connect(target: McpTarget, options: ConnectOptions): Promise<McpConnection> {
  const transport = transportFor(target);
  const client = new McpClient({ name: "repa", version: options.version, requestTimeoutMs: options.startupTimeoutMs });
  let lastError: unknown;
  client.onError(error => { lastError = error; });
  let abandoned: Promise<void> | undefined;
  const abandon = () => { abandoned = client.close().catch(() => undefined); };
  options.signal.addEventListener("abort", abandon, { once: true });
  try {
    await client.connect(transport);
  } catch (error) {
    // 放弃时等进程真正结束再返回，关闭后端的人据此知道没有留下进程。
    await abandoned;
    throw await reasonFor(error, target, transport);
  } finally {
    options.signal.removeEventListener("abort", abandon);
  }
  let closing = false;
  if (options.signal.aborted) {
    await client.close();
    options.signal.throwIfAborted();
  }
  return {
    async listTools() {
      return (await client.listTools({ timeoutMs: options.timeoutMs })).map(tool => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.inputSchema,
      }));
    },
    async call(tool, input, signal) {
      const result = await client.callTool(tool, input, { signal, timeoutMs: options.timeoutMs });
      return { text: textOf(toLlmContent(result)), isError: result.isError === true };
    },
    onToolsChanged(listener) {
      client.onNotification("notifications/tools/list_changed", listener);
    },
    onLost(listener) {
      client.onClose(() => {
        if (closing) return;
        const stderr = stderrTail(transport);
        const cause = lastError === undefined ? "" : `：${errorText(lastError)}`;
        listener(new RepaFault("mcp_disconnected", `连接断开了${cause}${stderr === "" ? "" : `\n${stderr}`}`));
      });
    },
    async close() {
      closing = true;
      await client.close();
    },
  };
}
