import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { RepaFault } from "../schema.js";
import { writeJson } from "../storage.js";

/**
 * 一个服务器的配置，按各家 MCP 客户端通行的 mcpServers 写法：stdio 写 command、args、env（可选 cwd），
 * Streamable HTTP 写 url、headers。timeout 是请求的时限（秒），与 Pi、Cline 的写法相同。
 * disabled 与 Cline 的同名字段含义相同；askBeforeCall 是 Repa 自己的，省略时为询问。
 * 别的客户端写的字段（例如 type、alwaysAllow）原样保留，Repa 不读。
 */
export const McpServerEntrySchema = Type.Object({
  type: Type.Optional(Type.String()),
  command: Type.Optional(Type.String({ minLength: 1 })),
  args: Type.Optional(Type.Array(Type.String())),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  cwd: Type.Optional(Type.String({ minLength: 1 })),
  url: Type.Optional(Type.String({ minLength: 1 })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  disabled: Type.Optional(Type.Boolean()),
  askBeforeCall: Type.Optional(Type.Boolean()),
}, { additionalProperties: true });
/** mcp.json 里一个服务器的配置。 */
export type McpServerEntry = Static<typeof McpServerEntrySchema>;

/** 应用配置目录下的 mcp.json：服务器名到配置。别的客户端写的顶层字段原样保留。 */
export const McpConfigSchema = Type.Object({
  mcpServers: Type.Optional(Type.Record(Type.String(), McpServerEntrySchema)),
}, { additionalProperties: true });
// 读文件时只核对外形，服务器各项逐个校验：一项写错只影响这一个服务器，别的照常连接。
const McpConfigShape = Type.Object({
  mcpServers: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: true });

/** 服务器名进工具名 mcp__<服务器>__<工具>，提供方只接受这些字符；长度给工具名留出余地。 */
export const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/u;

/** 连接用的目标，由配置的一项推出；推不出时是这一项的错误。 */
export type McpTarget =
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { kind: "http"; url: string; headers: Record<string, string> };

/** 读取后的一项：可以连接的目标，或这一项为什么不能用。 */
export interface ServerConfig {
  name: string;
  entry: unknown;
  enabled: boolean;
  ask: boolean;
  /** 请求的时限，毫秒。 */
  timeoutMs?: number;
  target: McpTarget | { kind: "invalid"; code: string; message: string; transport: "stdio" | "http"; label: string };
}

export function configFile(home: string): string {
  return path.join(home, "mcp.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeEntry(name: string, entry: unknown): ServerConfig {
  const record = isRecord(entry) ? entry : {};
  const enabled = record.disabled !== true;
  const ask = record.askBeforeCall !== false;
  const label = typeof record.command === "string" ? record.command : typeof record.url === "string" ? record.url : "";
  const transport = typeof record.url === "string" && typeof record.command !== "string" ? "http" : "stdio";
  const invalid = (code: string, message: string): ServerConfig => ({ name, entry, enabled, ask, target: { kind: "invalid", code, message, transport, label } });
  if (!SERVER_NAME.test(name)) return invalid("invalid_server_name", "服务器名只能用字母、数字、下划线和连字符，最长 32 个字符");
  if (!Value.Check(McpServerEntrySchema, entry)) return invalid("invalid_server_config", "这一项不符合 mcpServers 的写法");
  const timeoutMs = entry.timeout === undefined ? undefined : entry.timeout * 1000;
  const base = { name, entry, enabled, ask, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
  if (entry.command !== undefined && entry.url !== undefined) return invalid("invalid_server_config", "command 与 url 只能写一个");
  if (entry.type === "sse") return invalid("unsupported_transport", "旧的 HTTP+SSE 连接方式不支持，只支持 Streamable HTTP");
  if (entry.command !== undefined) {
    return { ...base, target: { kind: "stdio", command: entry.command, args: entry.args ?? [], env: entry.env ?? {}, ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }) } };
  }
  if (entry.url !== undefined) {
    if (!URL.canParse(entry.url) || !/^https?:$/u.test(new URL(entry.url).protocol)) return invalid("invalid_server_config", "url 不是 http 或 https 地址");
    return { ...base, target: { kind: "http", url: entry.url, headers: entry.headers ?? {} } };
  }
  return invalid("invalid_server_config", "要写 command（本机命令）或 url（远程地址）");
}

/** mcp.json 的全部内容，保留别的客户端写的字段；没有文件时为空。文件读不了或写坏了时抛错，不当作没有配置。 */
export async function readConfig(home: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(configFile(home), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new RepaFault("mcp_config_invalid", `mcp.json 不是有效的 JSON：${error instanceof Error ? error.message : String(error)}`, { file: configFile(home) });
  }
  if (!isRecord(value) || !Value.Check(McpConfigShape, value)) throw new RepaFault("mcp_config_invalid", "mcp.json 应当是带 mcpServers 对象的 JSON 对象", { file: configFile(home) });
  return value;
}

/** 文件里的服务器，按文件里的次序。 */
export function serverConfigs(config: Record<string, unknown>): ServerConfig[] {
  const servers = isRecord(config.mcpServers) ? config.mcpServers : {};
  return Object.entries(servers).map(([name, entry]) => describeEntry(name, entry));
}

export async function writeConfig(home: string, config: Record<string, unknown>): Promise<void> {
  await writeJson(configFile(home), config);
}

/**
 * 粘贴进来的一段配置里的服务器。服务器的说明里给的通常是整段 {"mcpServers": {...}}，也常只给里面的
 * "名字": {...} 一行；两种都接受。逐项校验不在这里，写进文件以后与手写的一样按项报告。
 */
export function pastedServers(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    try {
      value = JSON.parse(`{${text}}`);
    } catch {
      throw new RepaFault("invalid_mcp_config", "粘贴的内容不是 JSON");
    }
  }
  if (!isRecord(value)) throw new RepaFault("invalid_mcp_config", "粘贴的内容应当是 JSON 对象");
  const servers = "mcpServers" in value ? value.mcpServers : value;
  if (!isRecord(servers) || Object.keys(servers).length === 0) throw new RepaFault("invalid_mcp_config", "粘贴的内容里没有服务器");
  for (const [name, entry] of Object.entries(servers)) {
    if (!isRecord(entry) || (typeof entry.command !== "string" && typeof entry.url !== "string")) {
      throw new RepaFault("invalid_mcp_config", `${name} 不是一个服务器的配置：要有 command 或 url`, { name });
    }
  }
  return servers;
}

/**
 * 配置里可能是令牌的值：请求头和环境变量的全部值，以及地址查询串里的值（有的服务把密钥放在那里）。
 * 反馈包和导出据此脱敏，状态说明里也换掉。
 */
export function secretValues(config: Record<string, unknown>): string[] {
  const servers = isRecord(config.mcpServers) ? Object.values(config.mcpServers) : [];
  return servers.flatMap(entry => {
    if (!isRecord(entry)) return [];
    const maps = [entry.env, entry.headers].flatMap(map => isRecord(map) ? Object.values(map).filter((value): value is string => typeof value === "string") : []);
    const query = typeof entry.url === "string" && URL.canParse(entry.url) ? [...new URL(entry.url).searchParams.values()] : [];
    return [...maps, ...query];
  });
}

/** 设置页上显示的去处：stdio 是命令名，http 是去掉凭据和查询串的地址。 */
export function publicTarget(target: ServerConfig["target"]): string {
  if (target.kind === "stdio") return target.command;
  if (target.kind === "invalid" && target.transport === "stdio") return target.label;
  const text = target.kind === "http" ? target.url : target.label;
  if (!URL.canParse(text)) return "";
  const url = new URL(text);
  return `${url.protocol}//${url.host}${url.pathname}`;
}
