import { spawn } from "node:child_process";
import { devNull } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TextDecoder } from "node:util";

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class GitError extends Error {
  readonly exitCode: number | null;

  constructor(message: string, exitCode: number | null, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitError";
    this.exitCode = exitCode;
  }
}

export class Git {
  constructor(
    private readonly space: string,
    private readonly gitDir: string,
    private readonly binary = "git",
  ) {}

  async run(
    args: string[],
    input?: string | Buffer | AsyncIterable<Buffer | string>,
  ): Promise<Buffer> {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.toUpperCase().startsWith("GIT_")) {
        env[key] = value;
      }
    }
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = devNull;
    env.GIT_ATTR_NOSYSTEM = "1";
    env.GIT_INDEX_FILE = join(this.gitDir, "index");

    let source: Readable;
    if (input === undefined) {
      source = Readable.from([]);
    } else if (typeof input === "string" || Buffer.isBuffer(input)) {
      source = Readable.from([input]);
    } else {
      source = Readable.from(input);
    }

    // init --bare 自己设置 GIT_DIR，Git 2.43 不接受同时提供 --work-tree。
    const workTreeArgs = args[0] === "init" ? [] : [`--work-tree=${this.space}`];
    const commandArgs = args[0] === "init" ? ["init", "--template=", ...args.slice(1)] : args;
    const child = spawn(this.binary, [
      `--git-dir=${this.gitDir}`,
      ...workTreeArgs,
      "-c", `core.excludesFile=${devNull}`,
      "-c", `core.attributesFile=${devNull}`,
      "-c", `core.hooksPath=${devNull}`,
      "-c", "gc.auto=0",
      "-c", "maintenance.auto=false",
      "-c", "core.fsmonitor=false",
      ...commandArgs,
    ], {
      cwd: this.space,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let processError: unknown;
    let inputError: unknown;
    let inputFinished = false;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    const stop = (error: unknown) => {
      processError = error;
      child.kill("SIGKILL");
    };
    child.stdout.on("error", stop);
    child.stderr.on("error", stop);
    const completion = new Promise<number | null>((resolve) => {
      child.on("error", stop);
      child.once("close", (code) => {
        resolve(code);
      });
    });

    // 同时排空输出并写入输入，避免 fast-import 的双向管道互相等待。
    const writing = pipeline(source, child.stdin).then(() => {
      inputFinished = true;
    }, (error: unknown) => {
      inputError = error;
      child.kill("SIGKILL");
    });
    await Promise.race([completion, writing]);
    const code = await completion;
    if (!inputFinished && inputError === undefined) {
      // 任意 AsyncIterable 的 next() 可能无法取消，进程结束后不能继续等它。
      const error = new Error("Git 在输入流结束前退出");
      inputError = error;
      source.destroy(error);
    }
    const exitCode = processError === undefined ? code : null;
    if (exitCode !== 0 || processError !== undefined || inputError !== undefined) {
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      const cause = processError ?? inputError;
      const reason = detail || (cause instanceof Error ? cause.message : "进程异常结束");
      throw new GitError(`Git 执行失败：${reason}`, exitCode, { cause });
    }
    return Buffer.concat(stdout);
  }
}

export function nul(buffer: Buffer): string[] {
  const paths = UTF8.decode(buffer).split("\0");
  if (paths.at(-1) === "") {
    paths.pop();
  }
  return paths;
}
