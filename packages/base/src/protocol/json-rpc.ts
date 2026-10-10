export type RpcId = string | number | null;

export class RpcFault extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface RpcRequest {
  jsonrpc: "2.0";
  method: string;
  id?: RpcId;
  params?: unknown;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function parseRequest(value: unknown): RpcRequest {
  const request = record(value);
  if (
    !request ||
    request.jsonrpc !== "2.0" ||
    typeof request.method !== "string" ||
    (Object.hasOwn(request, "id") &&
      request.id !== null &&
      typeof request.id !== "string" &&
      !(typeof request.id === "number" && Number.isFinite(request.id)))
  ) {
    throw new RpcFault(-32600, "Invalid Request");
  }
  // 请求中未知的扩展字段按 JSON-RPC 规范忽略，params 由方法 schema 校验。
  return {
    jsonrpc: "2.0",
    method: request.method,
    ...(Object.hasOwn(request, "id") ? { id: request.id as RpcId } : {}),
    ...(Object.hasOwn(request, "params") ? { params: request.params } : {}),
  };
}

export function errorResponse(id: RpcId, error: RpcFault): unknown {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    },
  };
}
