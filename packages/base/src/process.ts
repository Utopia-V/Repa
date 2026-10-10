import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ClientConnection } from "./client.js";

export interface RepaProcessOptions {
  home?: string;
  nodeExecutable?: string;
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}

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
  const args = [fileURLToPath(new URL("./cli.js", import.meta.url)), "serve"];
  if (options.home !== undefined) args.push("--home", options.home);
  const child = spawn(options.nodeExecutable ?? process.execPath, args, {
    env: options.environment ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
      process.removeListener("exit", stopAtExit);
      resolveExited();
      if (code === 0) resolve();
      else reject(new Error(`Repa 后端异常退出（${signal ?? code}）。${diagnostics ? `\n${diagnostics}` : ""}`));
    });
  });
  // 启动失败由下方入口返回；宿主取得 handle 后仍可通过 closed 观察退出错误。
  void closed.catch(() => {});
  const stopAtExit = () => { child.kill("SIGTERM"); };
  process.once("exit", stopAtExit);
  const close = (): Promise<void> => {
    closing ??= (async () => {
      if (!exited) child.kill("SIGTERM");
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
