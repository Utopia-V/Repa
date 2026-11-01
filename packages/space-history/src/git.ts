import { spawn } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TextDecoder } from "node:util";

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Windows 上每启动一个 Git 进程要数十毫秒，历史操作的耗时主要由启动次数决定，因此在唯一的启动处计数。
const starts = new Map<string, number>();

/** 本进程至今启动 Git 的次数，按子命令分计；测试据此给各项历史操作的启动次数设上限。 */
export function gitStarts(): Map<string, number> {
  return new Map(starts);
}

/**
 * 按给定的 Git 程序建一个 Git。gitPath 必须是绝对路径：Windows 上按名称启动程序时先在子进程的工作目录里找，
 * 而工作目录是学习者的空间，可能有同名文件。安装包只带 git 主程序，它找不到编译时的子命令目录；fast-import
 * 调起 unpack-objects、gc 调起 repack 时都要靠 --exec-path 指回主程序所在的目录。没给时用 PATH 里的 git。
 */
export function createGit(space: string, gitDir: string, gitPath?: string): Git {
  if (gitPath === undefined) return new Git(space, gitDir);
  if (!isAbsolute(gitPath)) throw new Error(`gitPath 必须是绝对路径：${gitPath}`);
  return new Git(space, gitDir, gitPath, [`--exec-path=${dirname(gitPath)}`]);
}

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
    private readonly binaryArgs: string[] = [],
  ) {}

  async run(args: string[], input?: string | Buffer | AsyncIterable<Buffer | string>): Promise<Buffer> {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.toUpperCase().startsWith("GIT_")) {
        env[key] = value;
      }
    }
    env.GIT_CONFIG_NOSYSTEM = "1";
    // Git for Windows 使用 MSYS 路径，不接受 Node 的 Windows 空设备路径。
    env.GIT_CONFIG_GLOBAL = "/dev/null";
    env.GIT_ATTR_NOSYSTEM = "1";
    // 历史不用索引：树和提交由 fast-import 直接生成。empty-index 从不创建，Git 把缺失的索引当作空索引，
    // ls-files 因此把空间里的文件都当作未跟踪的候选列出。
    env.GIT_INDEX_FILE = join(this.gitDir, "empty-index");

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
    // 子命令是第一个不属于全局选项的参数；-c 后面跟的是配置项。
    const command = args.find((arg, index) => !arg.startsWith("-") && args[index - 1] !== "-c") ?? "";
    starts.set(command, (starts.get(command) ?? 0) + 1);
    const child = spawn(this.binary, [
      ...this.binaryArgs,
      `--git-dir=${this.gitDir}`,
      ...workTreeArgs,
      "-c", "core.excludesFile=/dev/null",
      "-c", "core.attributesFile=/dev/null",
      "-c", "core.hooksPath=/dev/null",
      "-c", "gc.auto=0",
      "-c", "maintenance.auto=false",
      "-c", "core.fsmonitor=false",
      ...commandArgs,
    ], {
      cwd: this.space,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      // 桌面端的后端没有控制台；Windows 上不加这一项，每启动一次 Git 都会弹出一个控制台窗口。其他平台忽略它。
      windowsHide: true,
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
    if (!inputFinished && inputError === undefined && code === 0 && processError === undefined) {
      // Windows 上子进程的 close 可能先于 stdin 的 finish 到达，负载高时很常见。Git 正常退出说明输入已经读完，
      // 给写入一点时间收尾；但不无限等。
      await Promise.race([writing, new Promise((resolve) => { setTimeout(resolve, 1000).unref(); })]);
    }
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
