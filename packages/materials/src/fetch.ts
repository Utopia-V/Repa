import { RepaFault } from "repa/protocol";
import { MAX_BYTES, type FetchSource } from "./schema.js";

/** 一个明确 URL 的 GET，不抓子资源、执行页面或递归发现链接。 */
export async function fetchBytes(value: string, parentSignal: AbortSignal): Promise<
  Omit<FetchSource, "kind" | "bodyRevision"> & { bytes: Uint8Array }
> {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new RepaFault("invalid_material_url", "材料地址不是有效的 URL。"); }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new RepaFault("invalid_material_url", "在线材料只支持 HTTP 和 HTTPS 地址。");
  parentSignal.throwIfAborted();
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(30000)]);
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    response = await fetch(url, { signal, headers: { "User-Agent": "RepaMaterials/0.1.0 (https://github.com/Utopia-V/repa/issues)" } });
    const details = { requestedUrl: url.href, finalUrl: response.url, status: response.status };
    if (!response.ok) throw new RepaFault("material_fetch_http", `材料服务器返回 HTTP ${response.status}，未保存响应为原件。`, details);
    const length = response.headers.get("content-length");
    if (length && /^\d+$/.test(length) && Number(length) > MAX_BYTES)
      throw new RepaFault("material_fetch_limit", "在线原件超过 32 MiB 限额，未保存不完整原件。", details);
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body) {
      reader = response.body.getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_BYTES)
          throw new RepaFault("material_fetch_limit", "在线原件超过 32 MiB 限额，未保存不完整原件。", details);
        chunks.push(next.value);
      }
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const contentType = response.headers.get("content-type");
    const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");
    return {
      bytes, requestedUrl: url.href, finalUrl: response.url, fetchedAt: Date.now(), status: response.status,
      mediaType, ...(contentType ? { contentType } : {}), ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}),
    };
  } catch (error) {
    if (parentSignal.aborted) throw parentSignal.reason;
    if (error instanceof RepaFault) throw error;
    const cause = error instanceof Error ? error.cause : undefined;
    const reason = error instanceof Error ? error.message : String(error);
    const causeCode = cause && typeof cause === "object" && "code" in cause &&
      (typeof cause.code === "string" || typeof cause.code === "number") ? cause.code : undefined;
    const causeMessage = cause instanceof Error ? cause.message : undefined;
    throw new RepaFault(signal.aborted ? "material_fetch_timeout" : "material_fetch_failed",
      signal.aborted ? "在线材料获取超过 30 秒。" : `无法取得在线材料：${causeCode ?? causeMessage ?? reason}。`,
      { requestedUrl: url.href, reason,
        ...(causeCode !== undefined || causeMessage ? { cause: { ...(causeCode !== undefined ? { code: causeCode } : {}),
          ...(causeMessage ? { message: causeMessage } : {}) } } : {}),
        ...(response ? { finalUrl: response.url, status: response.status } : {}) });
  } finally {
    // 一处收尾拥有响应流；取消失败不能覆盖已经取得的网络错误或调用方取消原因。
    if (reader) {
      try { await reader.cancel().catch(() => {}); }
      finally { reader.releaseLock(); }
    } else if (response?.body) await response.body.cancel().catch(() => {});
  }
}
