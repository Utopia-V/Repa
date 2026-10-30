import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ClientConnection } from "./client.js";

/** Node 宿主启动后端子进程的选项，指定应用配置、插件、环境和启动等待时限。 */
export interface RepaProcessOptions {
  home?: string;
  /** 本机可信插件构建目录，按顺序传给 --plugin。 */
  plugins?: string[];
  /** 为 false 时关掉通用 Agent（--no-general-agent），学习者版本使用。 */
  generalAgent?: boolean;
  nodeExecutable?: string;
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}

/** Node 宿主持有的后端进程句柄，用于取得连接并等待关闭后的持久化完成。 */
export interface RepaProcess {
  readonly connection: ClientConnection;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

/** Node 宿主拥有服务进程；stdout 只用于交付私密连接，不写入连接文件。 */
export async function startRepaProcess(options: RepaProcessOptions = {}): Promise<RepaProcess> {
  const timeoutMs = options.startupTimeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("startupTimeoutMs 必须是正数");
  }
  const args = [fileURLToPath(new URL("./cli.js", import.meta.url)), "serve", "--close-on-stdin-end"];
  if (options.home !== undefined) args.push("--home", options.home);
  for (const plugin of options.plugins ?? []) args.push("--plugin", plugin);
  if (options.generalAgent === false) args.push("--no-general-agent");
  // 宿主不往后端的 stdin 写内容，只用它表示自己还在：close() 结束 stdin 即请求正常关闭。
  // Windows 没有能投递给子进程的 SIGTERM，kill 会直接结束进程，后端的收尾代码来不及运行。
  // 不用 IPC 通道的 disconnect()：宿主一断开通道，Node 就不再发出子进程的 close 事件。
  // 宿主意外退出时，Linux 和 macOS 上 stdin 随之结束，后端照常收尾；Windows 上 libuv 把子进程放进随父进程关闭而
  // 结束的作业对象，后端随宿主一起被结束。两种情况下后端都不会留下来占着空间锁。
  const child = spawn(options.nodeExecutable ?? process.execPath, args, {
    env: options.environment ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  // 后端已经退出时结束 stdin 会遇到管道断开；退出状态由 closed 报告。
  child.stdin.on("error", () => {});
  let diagnostics = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-8192);
  });
  let exited = false;
  let closing: Promise<void> | undefined;
  let resolveExited: () => void = () => {};
  const exitedPromise = new Promise<void>((resolve) => { resolveExited = resolve; });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("close", (code, signal) => {
      exited = true;
      resolveExited();
      if (code === 0) resolve();
      else reject(new Error(`Repa 后端异常退出（${signal ?? code}）。${diagnostics ? `\n${diagnostics}` : ""}`));
    });
  });
  // 启动失败由下方入口返回；宿主取得 handle 后仍可通过 closed 观察退出错误。
  void closed.catch(() => {});
  const close = (): Promise<void> => {
    closing ??= (async () => {
      if (!exited) child.stdin.end();
      // 正常关闭必须等待持久化完成，不能用固定时限截断 Git 或插件收尾。
      await closed;
    })();
    return closing;
  };

  try {
    const connection = await new Promise<ClientConnection>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => finish(new Error("Repa 后端启动超时。")), timeoutMs);
      const failed = (error: Error) => finish(error);
      const ended = () => finish(new Error(`Repa 后端启动失败。${diagnostics ? `\n${diagnostics}` : ""}`));
      const received = (chunk: string) => {
        output += chunk;
        const newline = output.indexOf("\n");
        if (newline === -1) {
          if (output.length > 65536) finish(new Error("Repa 后端连接信息过长。"));
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(output.slice(0, newline));
        } catch {
          finish(new Error("Repa 后端返回了无效连接信息。"));
          return;
        }
        if (!value || typeof value !== "object" || !("url" in value) || typeof value.url !== "string" ||
          !("token" in value) || typeof value.token !== "string" || !value.token) {
          finish(new Error("Repa 后端返回了无效连接信息。"));
          return;
        }
        try {
          if (new URL(value.url).protocol !== "ws:") throw new Error();
        } catch {
          finish(new Error("Repa 后端返回了无效连接地址。"));
          return;
        }
        finish(undefined, { url: value.url, token: value.token });
      };
      const finish = (error?: Error, value?: ClientConnection) => {
        clearTimeout(timer);
        child.removeListener("error", failed);
        child.removeListener("close", ended);
        child.stdout.removeListener("data", received);
        if (error) reject(error);
        else if (value) resolve(value);
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", received);
      child.once("error", failed);
      child.once("close", ended);
    });
    // 交接后继续排空 stdout，避免子进程被管道背压阻塞。
    child.stdout.resume();
    return { connection, closed, close };
  } catch (error) {
    // 未交付的启动失败进程由本入口回收；超时强杀不属于正常服务关闭。
    if (!exited) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, 5000);
      try {
        await exitedPromise;
      } finally {
        clearTimeout(timer);
      }
    }
    throw error;
  }
}
