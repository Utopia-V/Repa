import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_TEXT, type ExtractData, type ExtractInput } from "./schema.js";

class PopplerFailure extends Error {
  constructor(readonly status: ExtractData["status"], readonly code: string, message: string) { super(message); }
}
/** 只终止自己的直接子进程；正常、失败和取消都等待 close 后再清理原件快照。 */
async function command(executable: string, args: string[], signal: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" } });
    const output: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      escalation ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const cancel = () => stop();
    signal.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) { failure = new PopplerFailure("limit_exceeded", "output_limit", "PDF 所选范围的输出超过 4 MiB，请缩小页范围。"); stop(); }
      else output.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(0, 8192); });
    child.once("error", (error: NodeJS.ErrnoException) => {
      failure = new PopplerFailure(error.code === "ENOENT" ? "dependency_missing" : "invalid", error.code ?? "poppler", `无法运行 PDF 工具 ${executable}：${error.message}`);
    });
    child.once("close", code => {
      signal.removeEventListener("abort", cancel);
      if (escalation) clearTimeout(escalation);
      if (signal.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code !== 0) reject(new PopplerFailure("invalid", "invalid_pdf", `PDF 工具退出 ${code}：${stderr}`));
      else resolve({ stdout: Buffer.concat(output).toString("utf8"), stderr });
    });
    if (signal.aborted) cancel();
  });
}

export async function pdf(bytes: Uint8Array, input: ExtractInput, executables: { pdfinfo: string; pdftotext: string }, signal: AbortSignal,
  progress?: (message: string) => void): Promise<ExtractData> {
  const result: ExtractData = { status: "ready", kind: "pdf", reader: { name: "poppler" }, segments: [], truncated: false, issues: [] };
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-materials-pdf-"));
  try {
    signal.throwIfAborted();
    const file = path.join(directory, "source.pdf");
    await writeFile(file, bytes);
    const version = await command(executables.pdfinfo, ["-v"], signal);
    result.reader.version = /version\s+([^\s]+)/.exec(version.stderr + version.stdout)?.[1] ?? "unknown";
    const info = await command(executables.pdfinfo, [file], signal);
    const pages = /^Pages:\s+(\d+)\s*$/m.exec(info.stdout)?.[1];
    if (!pages) throw new PopplerFailure("invalid", "invalid_pdf", "PDF 工具没有返回实际页数。");
    result.total = Number(pages);
    const start = input.range?.start ?? 1;
    const end = Math.min(input.range?.end ?? result.total, result.total);
    const limit = input.limit ?? 100;
    const selectedEnd = Math.min(end, start + limit - 1);
    result.truncated = selectedEnd < end;
    let remaining = MAX_TEXT;
    if (start <= selectedEnd) {
      // 一次解析所选页范围，沿用 Poppler 的换页符，避免逐页启动并重复读取整份 PDF。
      progress?.(`正在读取 PDF 第 ${start} 至 ${selectedEnd} 页`);
      const read = await command(executables.pdftotext, ["-f", String(start), "-l", String(selectedEnd), "-layout", "-enc", "UTF-8", file, "-"], signal);
      const pages = read.stdout.replace(/\f$/, "").split("\f");
      for (const [index, text] of pages.entries()) {
        if (remaining <= 0) { result.truncated = true; break; }
        const selected = text.slice(0, remaining);
        result.truncated ||= selected.length !== text.length;
        remaining -= selected.length;
        result.segments.push({ text: selected, locator: { format: { id: "repa.material.pdf", version: "1" }, value: { page: start + index } } });
      }
    }
    if (!result.segments.some(segment => segment.text.trim())) {
      result.status = "empty";
      result.issues.push(result.segments.length
        ? { code: "no_text_layer", message: "所选 PDF 页没有可提取文本；本能力未进行 OCR。" }
        : { code: "page_range_empty", message: "所选范围没有实际 PDF 页。" });
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (!(error instanceof PopplerFailure)) throw error;
    result.status = error.status;
    result.issues.push({ code: error.code, message: error.message });
  } finally { await rm(directory, { recursive: true, force: true }); }
  return result;
}
