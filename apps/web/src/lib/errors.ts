import { ConnectionError, RpcError } from "@repa/base/client";

export type ErrorDescription = {
  title: string;
  message: string;
  /** 后端业务错误码或 JSON-RPC 错误码，仅供开发排查。 */
  code?: string;
  details?: unknown;
};

/** 把调用失败统一转成界面可显示的说明；后端业务错误的文案已是面向用户的中文。 */
export function describeError(error: unknown): ErrorDescription {
  if (error instanceof ConnectionError) {
    return {
      title: "连接中断",
      message: "操作结果未确定，重新连接后会重新读取状态。",
    };
  }
  if (error instanceof RpcError) {
    const data = error.data;
    if (data && typeof data === "object" && "code" in data && typeof data.code === "string") {
      return {
        title: "操作失败",
        message: error.message,
        code: data.code,
        details: "details" in data ? data.details : undefined,
      };
    }
    // 参数校验和后端内部错误只带英文协议文案，不直接展示给用户。
    return {
      title: "请求失败",
      message: "后端无法完成这次请求。",
      code: String(error.code),
    };
  }
  if (error instanceof Error) {
    return { title: "操作失败", message: error.message };
  }
  return { title: "操作失败", message: "发生未知错误。" };
}

/** 后端业务错误码，用于界面按错误类型给出下一步；不是业务错误时为 undefined。 */
export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof RpcError)) return undefined;
  const data = error.data;
  return data && typeof data === "object" && "code" in data && typeof data.code === "string" ? data.code : undefined;
}
