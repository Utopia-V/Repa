import { fork } from "node:child_process";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientConnection } from "repa/client";

interface Endpoint extends ClientConnection {
  pid: number;
}

interface RepaProcessOptions {
  connectionFile: string;
  nodeExecutable: string;
  nodeEnvironment?: NodeJS.ProcessEnv;
}

let pending: Promise<ClientConnection> | undefined;

function repaCliPath(): string {
  const entry = fileURLToPath(import.meta.resolve("repa"));
  return path.join(path.dirname(entry), "cli.js");
}

async function readEndpoint(file: string): Promise<Endpoint | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      !("url" in value) ||
      typeof value.url !== "string" ||
      !("token" in value) ||
      typeof value.token !== "string" ||
      !("pid" in value) ||
      !Number.isInteger(value.pid)
    ) {
      throw new Error("Desktop 后端连接文件无效。");
    }
    return value as Endpoint;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function start(options: RepaProcessOptions): Promise<ClientConnection> {
  const { connectionFile } = options;
  await mkdir(path.dirname(connectionFile), { recursive: true, mode: 0o700 });
  const existing = await readEndpoint(connectionFile);
  if (existing && isAlive(existing.pid)) {
    return { url: existing.url, token: existing.token };
  }
  if (existing) await unlink(connectionFile);

  const logFile = `${connectionFile}.log`;
  const log = await open(logFile, "a", 0o600);
  let child: ReturnType<typeof fork>;
  try {
    child = fork(
      repaCliPath(),
      [
        "serve",
        "--connection-file",
        connectionFile,
        "--exit-when-detached",
      ],
      {
        detached: true,
        execPath: options.nodeExecutable,
        ...(options.nodeEnvironment ? { env: options.nodeEnvironment } : {}),
        stdio: ["ignore", "ignore", log.fd, "ipc"],
      },
    );
  } finally {
    await log.close();
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Desktop 后端启动超时，日志：${logFile}`));
    }, 15_000);
    child.once("message", (message) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "ready"
      ) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Desktop 后端启动失败（${code}），日志：${logFile}`));
    });
  });
  child.disconnect();
  child.unref();

  const endpoint = await readEndpoint(connectionFile);
  if (!endpoint || !isAlive(endpoint.pid)) {
    throw new Error(`Desktop 后端没有发布可用连接，日志：${logFile}`);
  }
  return { url: endpoint.url, token: endpoint.token };
}

export function ensureDesktopRepaProcess(
  options: RepaProcessOptions,
): Promise<ClientConnection> {
  pending ??= start(options).finally(() => {
    pending = undefined;
  });
  return pending;
}
