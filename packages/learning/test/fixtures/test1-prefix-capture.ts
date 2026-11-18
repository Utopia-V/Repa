/**
 * 产生逐前缀的标准答案 test1/prefixes.json.br：对固定数据里每个空间（含丁换课前的快照）学习记录的每个前缀取读数，
 * 用 brotli 压缩写出（原文约 13 MB，前后前缀的读数大半相同，压缩后几十 KB）。要在标签 v0.1.0-test.1 的工作树里运行，
 * 做法见 test1/README.md：
 *   TZ=Asia/Shanghai npx tsx test/fixtures/test1-prefix-capture.ts <test1 目录>
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";
import { copySpace, PREFIX_LATER_MS, PREFIX_SPACES, readPrefixes, TIME_ZONE, WEB_CAPABILITIES } from "./test1-readings.js";

const [fixture] = process.argv.slice(2);
if (!fixture) throw new Error("用法：test1-prefix-capture.ts <test1 目录>");
if (Intl.DateTimeFormat().resolvedOptions().timeZone !== TIME_ZONE) throw new Error(`进程的时区要是 ${TIME_ZONE}，用 TZ 指定`);
const readings = fileURLToPath(new URL("./test1-readings.ts", import.meta.url));
const base = await mkdtemp(path.join(os.tmpdir(), "repa-test1-capture-"));
try {
  const spaces = [];
  for (const entry of PREFIX_SPACES) {
    const root = path.join(base, entry.id);
    await copySpace(path.join(fixture, entry.source), root);
    spaces.push({ ...entry, prefixes: await readPrefixes(root, entry.model) });
  }
  const answers = {
    producedBy: {
      commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      readings: `test/fixtures/test1-readings.ts sha256:${createHash("sha256").update(await readFile(readings)).digest("hex")}`,
    },
    timeZone: TIME_ZONE,
    capabilities: WEB_CAPABILITIES,
    laterMs: PREFIX_LATER_MS,
    spaces,
  };
  const text = Buffer.from(JSON.stringify(answers));
  await writeFile(path.join(fixture, "prefixes.json.br"), brotliCompressSync(text, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: text.length },
  }));
} finally {
  await rm(base, { recursive: true, force: true });
}
