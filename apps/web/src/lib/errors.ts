import { ConnectionError, RpcError } from "@repa/base/client";
import { t } from "@/lib/strings";

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
      title: t("error.connection.title"),
      message: t("error.connection.message"),
    };
  }
  if (error instanceof RpcError) {
    const data = error.data;
    if (data && typeof data === "object" && "code" in data && typeof data.code === "string") {
      return {
        title: t("error.operation.title"),
        message: error.message,
        code: data.code,
        details: "details" in data ? data.details : undefined,
      };
    }
    // 参数校验和后端内部错误只带英文协议文案，不直接展示给用户。
    return {
      title: t("error.request.title"),
      message: t("error.request.message"),
      code: String(error.code),
    };
  }
  if (error instanceof Error) {
    return { title: t("error.operation.title"), message: error.message };
  }
  return { title: t("error.operation.title"), message: t("error.unknown.message") };
}

/** 后端业务错误码，用于界面按错误类型给出下一步；不是业务错误时为 undefined。 */
export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof RpcError)) return undefined;
  const data = error.data;
  return data && typeof data === "object" && "code" in data && typeof data.code === "string" ? data.code : undefined;
}
