/**
 * 课程命令（course:check、course:runtime、course:confirm）运行前，确认 @repa/base 和它依赖的 @repa/space-history
 * 的构建产物是新的。
 *
 * 以前每个命令都先 npm run build。同一个 worktree 里几个命令同时运行时，各自的 tsc 同时改写同一个 dist，
 * 另一个进程可能读到写了一半的文件。现在只在产物缺失或比源码旧时才构建，并且同一时间只有一个进程在构建，
 * 其余的等它做完再检查一遍。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** 按依赖顺序：后面的包依赖前面的。 */
const PACKAGES = ["space-history", "base"];
const LOCK = path.join(os.tmpdir(), `repa-build-${createHash("sha256").update(ROOT).digest("hex").slice(0, 12)}.lock`);
const POLL_MS = 300;
const WAIT_LIMIT_MS = 15 * 60_000;

async function modifiedAt(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function newestSource(directory: string): Promise<number> {
  let newest = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, await newestSource(file));
    else if (entry.name.endsWith(".ts")) newest = Math.max(newest, (await stat(file)).mtimeMs);
  }
  return newest;
}

/** 需要重新构建的包；产物缺失、比源码旧，或比它依赖的包旧。 */
async function stalePackages(): Promise<string[]> {
  const stale: string[] = [];
  let upstream = 0;
  for (const name of PACKAGES) {
    const directory = path.join(ROOT, "packages", name);
    const built = await modifiedAt(path.join(directory, "dist", "index.js"));
    const configs = await Promise.all(["package.json", "tsconfig.json", "tsconfig.build.json"].map((file) => modifiedAt(path.join(directory, file))));
    const source = Math.max(await newestSource(path.join(directory, "src")), ...configs.map((time) => time ?? 0));
    if (built === undefined || built < source || built < upstream) stale.push(name);
    upstream = Math.max(upstream, built ?? Number.POSITIVE_INFINITY);
  }
  return stale;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 抢到构建锁（一个目录，mkdir 是原子的）；持有者进程已经不在，或锁放了太久，就当它是遗留的并清掉。 */
async function acquireLock(): Promise<void> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    try {
      await mkdir(LOCK);
      await writeFile(path.join(LOCK, "pid"), String(process.pid));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = Number(await readFile(path.join(LOCK, "pid"), "utf8").catch(() => ""));
    const age = Date.now() - ((await modifiedAt(LOCK)) ?? Date.now());
    if ((holder > 0 && !alive(holder)) || age > WAIT_LIMIT_MS) {
      await rm(LOCK, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`等了 ${WAIT_LIMIT_MS / 60_000} 分钟，别的进程还在构建（锁 ${LOCK}）`);
    await sleep(POLL_MS);
  }
}

async function main(): Promise<void> {
  if ((await stalePackages()).length === 0) return;
  await acquireLock();
  try {
    // 等锁的时候别的进程可能已经构建好了。
    const stale = await stalePackages();
    if (stale.length === 0) return;
    process.stdout.write(`构建 @repa/base（${stale.join("、")} 的产物缺失或比源码旧）\n`);
    const build = spawnSync("npm", ["run", "build", "--workspace=@repa/base"], { cwd: ROOT, stdio: "inherit" });
    if (build.status !== 0) throw new Error(`构建 @repa/base 失败（退出码 ${build.status ?? build.signal}）`);
  } finally {
    await rm(LOCK, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
