import { RepaFault, type ModelFailure } from "../schema.js";

/**
 * 运行时交回的只有一段报错文字。Pi 把提供方的 HTTP 报错写成“状态码: 原文”或“前缀 (状态码): 原文”（pi-ai 的 formatProviderError），
 * 报错没有能单独取出的正文时是 OpenAI SDK 的“状态码 原文”；这里只认开头的状态码，不读各家报错的正文。
 */
const STATUS = /^(?:([1-5]\d\d)[: ]|[^\n(]*\(([1-5]\d\d)\): )/u;
/** 429 里有一类是额度或账单用完（OpenAI 的 insufficient_quota），等一会儿不会好，归入余额不足。 */
const QUOTA = /insufficient_quota|quota|billing|balance/iu;
/**
 * 没有状态码时认得出的连接失败：OpenAI SDK 的 “Request timed out.”“Connection error.”，Node fetch 的 “fetch failed” 与 “terminated”，
 * 以及系统的 DNS 与套接字错误码。取自 pi-ai 判断可重试错误时认的网络与传输类写法（utils/retry.js）。
 */
const NETWORK = /timed? ?out|timeout|fetch failed|connection error|connection refused|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|getaddrinfo|socket hang up|other side closed|network error|^terminated$/iu;

/** 从模型请求的报错里认出失败的原因；认不出时是 other。 */
export function modelFailure(message: string | undefined): ModelFailure {
  if (message === undefined) return "other";
  const match = STATUS.exec(message);
  if (match) {
    const status = Number(match[1] ?? match[2]);
    if (status === 401 || status === 403) return "auth";
    if (status === 402) return "balance";
    if (status === 429) return QUOTA.test(message) ? "balance" : "rate_limit";
    if (status >= 500) return "server";
    return "other";
  }
  return NETWORK.test(message) ? "network" : "other";
}

/** 模型请求失败交给调用方的错误：code 为 model_error，details.failure 是分类，消息是运行时的原文。 */
export function modelError(message: string | undefined): RepaFault {
  return new RepaFault("model_error", message ?? "模型请求失败", { failure: modelFailure(message) });
}
