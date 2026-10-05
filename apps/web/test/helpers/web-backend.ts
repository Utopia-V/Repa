import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { expect } from "vitest";
import { RepaClient, type ClientConnection } from "repa/client";
import type { Change, ConnectionModel, SessionView } from "repa/protocol";
import config from "../../vite.config";
import { LOCAL_MODEL_ID, startLocalModel } from "./local-model";

const model: ConnectionModel = {
  id: LOCAL_MODEL_ID,
  name: "Web 本地集成模型",
  api: "openai-completions",
  reasoning: false,
  input: ["text"],
  contextWindow: 32768,
  maxTokens: 512,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function endpointPid(file: string): Promise<number | undefined> {
  let bytes: string;
  try {
    bytes = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const endpoint: unknown = JSON.parse(bytes);
  assert(endpoint && typeof endpoint === "object" && "pid" in endpoint);
  assert(typeof endpoint.pid === "number" && Number.isInteger(endpoint.pid));
  return endpoint.pid;
}

export async function setRuntime(client: RepaClient, key: string, value: unknown) {
  const scope = { kind: "application" } as const;
  const settings = await client.call("settings.get", { scope, namespace: "runtime" });
  const entry = settings.entries.find(item => item.key === key);
  assert(entry, `运行设置缺少 ${key}`);
  return client.call("settings.set", { scope, namespace: "runtime", key, value, base: entry.revision });
}

/** 状态使用公开客户端已有投影，测试仅保存收到的变化供断言。 */
export async function observeSession(client: RepaClient, spaceId: string) {
  const session = await client.call("session.create", { spaceId });
  const target = { spaceId, sessionId: session.sessionId };
  const changes: Change[] = [];
  const watch = await client.watch(target, (_snapshot, delivery) => {
    if (delivery.type === "changes") changes.push(...delivery.changes);
  });
  return {
    target,
    changes,
    watch,
    view(): SessionView {
      const current = watch.snapshot?.sessions.find(item => item.sessionId === target.sessionId);
      assert(current, "尚未收到所选会话状态");
      return current;
    },
    async submit(text: string) {
      const request = await client.call("session.submit", {
        target,
        requestId: randomUUID(),
        input: { parts: [{ kind: "text", text }] },
        dispatch: { kind: "start" },
      });
      assert(request.runId, "开始请求没有返回所属运行");
      return { ...request, runId: request.runId };
    },
  };
}

export function assistantText(session: SessionView): string {
  return session.messages.filter(message => message.role === "assistant")
    .flatMap(message => message.content.flatMap(block => block.type === "text" ? [block.text] : []))
    .join("");
}

/** 夹具不更改宿主启动协议；环境隔离必须在 Vite 触发真实后端启动之前完成。 */
export async function withWebBackend<T>(work: (fixture: {
  directory: string;
  appDirectory: string;
  agentDirectory: string;
  connectionFile: string;
  pid: number;
  connection: ClientConnection;
  model: Awaited<ReturnType<typeof startLocalModel>>;
  client: RepaClient;
  space: { id: string; path: string };
  connect(connection?: ClientConnection): Promise<RepaClient>;
}) => Promise<T>): Promise<T> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-web-integration-")));
  const appDirectory = path.join(directory, "config", "repa");
  const agentDirectory = path.join(directory, "agent");
  const connectionFile = path.join(directory, `repa-web-${process.getuid?.() ?? os.userInfo().username}`, `${process.pid}.json`);
  const clients: RepaClient[] = [];
  const environment = new Map<string, string | undefined>();
  let server: ViteDevServer | undefined;
  let localModel: Awaited<ReturnType<typeof startLocalModel>> | undefined;
  let pid: number | undefined;
  const useEnv = (name: string, value: string) => {
    environment.set(name, process.env[name]);
    process.env[name] = value;
  };
  try {
    for (const name of ["TMPDIR", "TMP", "TEMP"]) useEnv(name, directory);
    useEnv("XDG_CONFIG_HOME", path.dirname(appDirectory));
    useEnv("PI_CODING_AGENT_DIR", agentDirectory);
    useEnv("HOME", path.join(directory, "home"));
    await mkdir(agentDirectory);
    await writeFile(path.join(agentDirectory, "settings.json"), JSON.stringify({
      extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"], packages: [],
    }));
    localModel = await startLocalModel();
    server = await createServer({
      ...config,
      configFile: false,
      root: fileURLToPath(new URL("../..", import.meta.url)),
      server: { host: "127.0.0.1", port: 0 },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    await server.listen();
    const address = server.httpServer?.address();
    assert(address && typeof address !== "string", "缺少 Web 测试端口");
    const response = await fetch(`http://127.0.0.1:${address.port}/__repa/connection`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const value: unknown = await response.json();
    assert(value && typeof value === "object" && "url" in value && "token" in value);
    assert(typeof value.url === "string" && typeof value.token === "string");
    const connection: ClientConnection = { url: value.url, token: value.token };
    pid = await endpointPid(connectionFile);
    assert(pid && processAlive(pid));
    const connect = async (endpoint = connection) => {
      const client = await RepaClient.connect(endpoint, { reconnectDelayMs: 30 });
      clients.push(client);
      return client;
    };
    const client = await connect();
    const identity = await client.call("connection.create", {
      name: "Web 测试模型",
      provider: "openai",
      baseUrl: localModel.baseUrl,
      authMode: "none",
      models: [model],
    });
    await setRuntime(client, "model", { connectionId: identity.id, id: model.id });
    await setRuntime(client, "retry", { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 });
    const space = await client.call("space.open", { path: path.join(directory, "space") });
    return await work({ directory, appDirectory, agentDirectory, connectionFile, pid, connection, model: localModel, client, space, connect });
  } finally {
    const failures: unknown[] = [];
    const cleanup = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    };
    await cleanup(async () => { await Promise.all(clients.map(client => client.close())); });
    await cleanup(async () => { await server?.close(); });
    await cleanup(async () => {
      // 断言失败时也结束本夹具启动的 detached 后端，包含仍在等待模型的任务。
      pid ??= await endpointPid(connectionFile);
      if (pid !== undefined && processAlive(pid)) {
        try {
          process.kill(pid, "SIGTERM");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      }
      await expect.poll(() => !existsSync(connectionFile) && (pid === undefined || !processAlive(pid)), { timeout: 8000 }).toBe(true);
    });
    await cleanup(async () => { await localModel?.close(); });
    for (const [name, previous] of environment) {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
    await cleanup(() => rm(directory, { recursive: true, force: true }));
    if (localModel?.errors.length) failures.push(...localModel.errors);
    if (failures.length) throw new AggregateError(failures, "Web 集成夹具清理失败");
  }
}

export function deferredText() {
  let resolve = (_value: string) => {};
  const promise = new Promise<string>(complete => { resolve = complete; });
  return { promise, resolve };
}
