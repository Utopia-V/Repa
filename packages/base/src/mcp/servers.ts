import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import type { AgentTool } from "../agent.js";
import { MCP_TOOL_PREFIX } from "../plugin.js";
import { errorText, RepaFault, type Confirm, type McpServerInfo } from "../schema.js";
import { SerialQueue } from "../storage.js";
import { connect, type McpConnection, type McpToolSpec } from "./client.js";
import { pastedServers, publicTarget, readConfig, secretValues, serverConfigs, writeConfig, type McpTarget, type ServerConfig } from "./config.js";

// 同时连接的服务器上限，也就是 stdio 服务器进程的上限。这是 Repa 的假设：常见的用法是三五个（搜索、读网页、笔记、文献库），
// 16 个留足余地；再多时每条消息都带着几百个工具声明，该停用一些。超出的按文件次序标为失败。
export const MAX_SERVERS = 16;
// 一个服务器声明的工具数上限。这是 Repa 的假设：常见服务器在 5 到 40 个之间，有的提供方一次请求最多接受 128 个工具，
// 一个服务器占去一半就太多了。超出时这个服务器整个标为失败，嫌多就换一个更小的服务器，不截掉一部分让模型看不到。
export const MAX_TOOLS = 64;
// 一个工具说明的字数上限。OpenAI 的函数说明上限是 1024 个字符，超过时整个请求被拒；更长的说明截断并标出。
export const MAX_DESCRIPTION = 1024;
// 请求的默认时限：列工具和一次调用各自计算。60 秒与 Pi 的 MCP 扩展相同；配置里写了 timeout 时用它。
const DEFAULT_TIMEOUT_MS = 60_000;
// 本机服务器握手的默认时限。npx、uvx 第一次运行要先下载：server-everything 约 43 MB，GitHub 的 Windows 机器上要 25 秒，
// 慢的网络上会超过 60 秒；超时会结束下载，重新连接也接不上前一次（实测时限 5 秒时重连 30 次，缓存停在 17 MB），
// 使用者只能去改配置。10 分钟是 Repa 的假设，容下约 70 KB/s 的下载；握手在后台进行，不拖住消息。配置里写了 timeout 时用它。
const DEFAULT_STDIO_STARTUP_TIMEOUT_MS = 600_000;
// 提供方要求工具名不超过 64 个字符、只含字母数字和 _-。
const TOOL_NAME_LIMIT = 64;

export interface McpServersOptions {
  home: string;
  version: string;
  /** 调用前询问：发给发起这次运行的连接；没有时（后台运行）拒绝。 */
  confirm: Confirm;
  /** 命令授权为完全访问时都不问。 */
  fullAccess(): boolean;
  /** 服务器的列表或状态变了。 */
  onUpdate(servers: McpServerInfo[]): void;
  onError(error: unknown): void;
}

interface Server {
  config: ServerConfig;
  state: McpServerInfo["state"];
  reason?: RepaFault;
  connection?: McpConnection;
  /** 放弃这一次连接：停用、删除、改了配置或关闭后端。 */
  abandon: AbortController;
  /** 登记给通用 Agent 的工具；同一份列表在变化之前一直是同一批对象，会话按对象判断是否替换。 */
  tools: AgentTool[];
  /** 后台的这一次连接；放弃时等它结束，进程才算关掉。 */
  opening?: Promise<void>;
}

/** 工具名里不允许的字符换成 _；过长的截到上限。重名时由调用方报告。 */
function toolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${server}__${tool.replace(/[^A-Za-z0-9_-]/gu, "_")}`.slice(0, TOOL_NAME_LIMIT);
}

function description(tool: McpToolSpec): string {
  const text = tool.description?.trim() || tool.name;
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1)}…` : text;
}

/**
 * 后端持有的 MCP 服务器：一个服务器一份连接，所有空间、会话共用。配置在应用配置目录的 mcp.json，
 * 每次协议读写和启动时与文件对照：新的连上，改了的重连，停用、删除的关掉，没变的不动。连接断了标为失败并说明原因，
 * 不自动重连；使用者在设置页重新连接。
 */
export class McpServers {
  private servers = new Map<string, Server>();
  private queue = new SerialQueue();
  private fileError?: RepaFault;
  private closed = false;

  constructor(private options: McpServersOptions) {}

  /** 后端启动时在后台对照一次配置；不等连接完成。没有 mcp.json 时什么也不做。 */
  start(): void {
    this.queue.run(() => this.reconcile()).catch(error => this.options.onError(error));
  }

  /** 通用 Agent 这一刻能用的工具：已连接的服务器的全部工具。 */
  tools(): AgentTool[] {
    return [...this.servers.values()].flatMap(server => server.state === "connected" ? server.tools : []);
  }

  list(): Promise<McpServerInfo[]> {
    return this.queue.run(async () => {
      await this.reconcile();
      return this.snapshot();
    });
  }

  /** 加入粘贴的一段配置；同名的服务器整项换成新的。 */
  add(text: string): Promise<McpServerInfo[]> {
    const pasted = pastedServers(text);
    return this.edit(servers => Object.assign(servers, pasted));
  }

  remove(name: string): Promise<McpServerInfo[]> {
    return this.edit(servers => {
      this.known(servers, name);
      delete servers[name];
    });
  }

  /** 停用或启用、切换调用前询问。只改 Repa 自己的两个字段，这一项的其余内容原样保留。 */
  set(name: string, change: { enabled?: boolean; ask?: boolean }): Promise<McpServerInfo[]> {
    return this.edit(servers => {
      const entry = { ...this.known(servers, name) };
      if (change.enabled !== undefined) {
        if (change.enabled) delete entry.disabled;
        else entry.disabled = true;
      }
      if (change.ask !== undefined) {
        if (change.ask) delete entry.askBeforeCall;
        else entry.askBeforeCall = false;
      }
      servers[name] = entry;
    });
  }

  /** 重新连接一个失败或断开的服务器。 */
  reconnect(name: string): Promise<McpServerInfo[]> {
    return this.queue.run(async () => {
      const server = this.servers.get(name);
      if (server === undefined) throw new RepaFault("mcp_server_not_found", "没有这个 MCP 服务器", { name });
      await this.stop(server);
      this.servers.delete(name);
      await this.reconcile();
      const list = this.snapshot();
      this.options.onUpdate(list);
      return list;
    });
  }

  /** 配置里可能是令牌的值，供反馈包与导出脱敏。文件读不了时抛错，与凭据读不到时一样不出包。 */
  async secrets(): Promise<string[]> {
    return secretValues(await readConfig(this.options.home));
  }

  /** 关闭全部连接，等服务器进程结束。 */
  close(): Promise<void> {
    this.closed = true;
    return this.queue.run(async () => {
      await Promise.all([...this.servers.values()].map(server => this.stop(server)));
      this.servers.clear();
    });
  }

  private known(servers: Record<string, unknown>, name: string): Record<string, unknown> {
    const entry = servers[name];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new RepaFault("mcp_server_not_found", "没有这个 MCP 服务器", { name });
    return { ...entry };
  }

  private edit(change: (servers: Record<string, unknown>) => void): Promise<McpServerInfo[]> {
    return this.queue.run(async () => {
      if (this.closed) throw new RepaFault("closed", "服务正在关闭");
      const config = await readConfig(this.options.home);
      const current = config.mcpServers;
      const servers = current !== null && typeof current === "object" && !Array.isArray(current) ? { ...current as Record<string, unknown> } : {};
      change(servers);
      await writeConfig(this.options.home, { ...config, mcpServers: servers });
      await this.reconcile();
      const list = this.snapshot();
      this.options.onUpdate(list);
      return list;
    });
  }

  /** 让连接与文件一致。只在队列里调用。文件读不了时保留现有连接，错误由 list 报告。 */
  private async reconcile(): Promise<void> {
    if (this.closed) return;
    let configs: ServerConfig[];
    try {
      configs = serverConfigs(await readConfig(this.options.home));
      this.fileError = undefined;
    } catch (error) {
      this.fileError = error instanceof RepaFault ? error : new RepaFault("mcp_config_invalid", `读不了 mcp.json：${errorText(error)}`);
      throw this.fileError;
    }
    const wanted = new Map(configs.map(config => [config.name, config]));
    for (const [name, server] of this.servers) {
      const config = wanted.get(name);
      // 只有询问开关变了时不重连：工具调用时读这一项的 ask。
      if (config === undefined || !sameConnection(config, server.config)) {
        await this.stop(server);
        this.servers.delete(name);
      } else {
        server.config = config;
      }
    }
    let active = [...this.servers.values()].filter(server => server.state === "connecting" || server.state === "connected").length;
    for (const config of configs) {
      if (this.servers.has(config.name)) continue;
      const server: Server = { config, state: "disabled", abandon: new AbortController(), tools: [] };
      this.servers.set(config.name, server);
      const target = config.target;
      if (!config.enabled) continue;
      if (target.kind === "invalid") {
        this.fail(server, new RepaFault(target.code, target.message));
      } else if (active >= MAX_SERVERS) {
        this.fail(server, new RepaFault("mcp_too_many_servers", `最多同时连接 ${MAX_SERVERS} 个服务器，先停用一些`));
      } else {
        active += 1;
        server.state = "connecting";
        server.opening = this.open(server, target).catch(error => this.options.onError(error));
      }
    }
  }

  /** 在后台连接；连上以后列出工具，期间不占队列，不拖住别的操作。 */
  private async open(server: Server, target: McpTarget): Promise<void> {
    const name = server.config.name;
    const signal = server.abandon.signal;
    let connection: McpConnection | undefined;
    try {
      const timeoutMs = server.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const startupTimeoutMs = server.config.timeoutMs ?? (target.kind === "stdio" ? DEFAULT_STDIO_STARTUP_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
      connection = await connect(target, { timeoutMs, startupTimeoutMs, version: this.options.version, signal });
      const tools = this.toolsFor(server, connection, await connection.listTools());
      if (signal.aborted) {
        await connection.close();
        return;
      }
      server.connection = connection;
      server.tools = tools;
      server.state = "connected";
      const current = connection;
      current.onLost(reason => {
        if (server.connection !== current) return;
        server.connection = undefined;
        this.fail(server, reason);
        this.publish();
      });
      current.onToolsChanged(() => {
        this.refreshTools(server, current).catch(error => this.options.onError(error));
      });
    } catch (error) {
      await connection?.close().catch(() => undefined);
      if (signal.aborted) return;
      this.fail(server, error instanceof RepaFault ? error : new RepaFault("mcp_connect_failed", errorText(error)));
    }
    if (this.servers.get(name) === server) this.publish();
  }

  /** 服务器通知工具变了：重新列出，换成新的一批工具对象。列不出来时这个服务器标为失败。 */
  private async refreshTools(server: Server, connection: McpConnection): Promise<void> {
    try {
      const tools = this.toolsFor(server, connection, await connection.listTools());
      if (server.connection !== connection) return;
      server.tools = tools;
    } catch (error) {
      if (server.connection !== connection) return;
      server.connection = undefined;
      await connection.close().catch(() => undefined);
      this.fail(server, error instanceof RepaFault ? error : new RepaFault("mcp_list_failed", `列不出工具：${errorText(error)}`));
    }
    this.publish();
  }

  private toolsFor(server: Server, connection: McpConnection, specs: McpToolSpec[]): AgentTool[] {
    const serverName = server.config.name;
    if (specs.length > MAX_TOOLS) throw new RepaFault("mcp_too_many_tools", `服务器声明了 ${specs.length} 个工具，超过上限 ${MAX_TOOLS}`);
    const names = new Set<string>();
    return specs.map((spec): AgentTool => {
      const name = toolName(serverName, spec.name);
      if (names.has(name)) throw new RepaFault("mcp_tool_name_conflict", `工具名 ${spec.name} 换成 ${name} 以后与另一个工具重名`);
      names.add(name);
      return {
        name,
        description: description(spec),
        // 参数照服务器给的 JSON Schema；提供方要求是带 properties 的对象。
        parameters: Type.Unsafe({ ...spec.inputSchema, type: "object", properties: spec.inputSchema.properties ?? {} }),
        execute: async (input, context) => {
          await this.approve(server, spec.name, input, context.signal);
          // 确认期间连接可能断了或换了；用这一刻的连接，没有时如实失败。
          const current = server.connection === connection ? connection : undefined;
          if (current === undefined) throw new RepaFault("mcp_unavailable", `MCP 服务器 ${serverName} 现在没有连接${server.reason === undefined ? "" : `：${server.reason.message}`}`);
          const args = input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
          let result: { text: string; isError: boolean };
          try {
            result = await current.call(spec.name, args, context.signal);
          } catch (error) {
            throw new RepaFault("mcp_call_failed", `调用 MCP 工具失败：${errorText(error)}`, { server: serverName, tool: spec.name });
          }
          if (result.isError) throw new RepaFault("mcp_tool_error", result.text || "MCP 工具报告失败", { server: serverName, tool: spec.name });
          return { text: result.text, data: { server: serverName, tool: spec.name } };
        },
      };
    });
  }

  /** 开着调用前询问的服务器，每次调用先请使用者确认；命令授权为完全访问时不问。没有人可问或被拒绝时抛错，交回模型。 */
  private async approve(server: Server, tool: string, input: unknown, signal: AbortSignal): Promise<void> {
    if (!server.config.ask || this.options.fullAccess()) return;
    const call = { server: server.config.name, tool, input };
    let answer: string | boolean | null;
    try {
      answer = await this.options.confirm({ kind: "mcp", title: "", mcp: call }, signal);
    } catch (error) {
      throw new RepaFault("mcp_call_not_confirmed", `这个服务器开着调用前询问，没有得到使用者的确认，调用没有进行：${errorText(error)}`, { server: call.server, tool });
    }
    if (answer !== true) throw new RepaFault("mcp_call_denied", "使用者拒绝了这次调用", { server: call.server, tool });
  }

  private fail(server: Server, reason: RepaFault): void {
    server.state = "failed";
    server.reason = reason;
    server.tools = [];
  }

  private async stop(server: Server): Promise<void> {
    server.abandon.abort();
    const connection = server.connection;
    server.connection = undefined;
    server.tools = [];
    await Promise.all([connection?.close(), server.opening]);
  }

  /** 后台连接的结果变了时通知；文件读不了时不发，list 会报告那个错误。 */
  private publish(): void {
    if (this.closed || this.fileError !== undefined) return;
    this.options.onUpdate(this.snapshot());
  }

  private snapshot(): McpServerInfo[] {
    const secrets = this.secretsInMemory();
    return [...this.servers.values()].map(server => {
      const { config } = server;
      const target = config.target;
      return {
        name: config.name,
        transport: target.kind === "invalid" ? target.transport : target.kind,
        target: publicTarget(target),
        enabled: config.enabled,
        ask: config.ask,
        state: server.state,
        tools: server.tools.map(tool => tool.name),
        ...(server.reason === undefined || server.state !== "failed" ? {} : { reason: { code: server.reason.code, message: redact(server.reason.message, secrets) } }),
      };
    });
  }

  /** 状态说明里可能带着服务器写到 stderr 的令牌；按配置里的值换掉。 */
  private secretsInMemory(): string[] {
    return [...this.servers.values()].flatMap(server => secretValues({ mcpServers: { [server.config.name]: server.config.entry } }));
  }
}

function sameConnection(left: ServerConfig, right: ServerConfig): boolean {
  return left.enabled === right.enabled && isDeepStrictEqual(left.target, right.target) && left.timeoutMs === right.timeoutMs;
}

function redact(text: string, secrets: string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (secret.length >= 4) output = output.split(secret).join("***");
  }
  return output;
}
