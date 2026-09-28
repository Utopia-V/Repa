// @vitest-environment node
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { expect, it, vi } from "vitest";
import { RepaClient, type ClientConnection } from "repa/client";
import config from "../vite.config";

it("Web 宿主通过 HTTP 交付真实后端连接，客户端退出后清理连接文件", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-web-integration-")));
  vi.stubEnv("TMPDIR", directory);
  vi.stubEnv("TMP", directory);
  vi.stubEnv("TEMP", directory);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(directory, "config"));
  const connectionFile = path.join(directory, `repa-web-${process.getuid?.() ?? os.userInfo().username}`, `${process.pid}.json`);
  let server: ViteDevServer | undefined;
  let client: RepaClient | undefined;
  try {
    server = await createServer({
      ...config,
      configFile: false,
      root: fileURLToPath(new URL("..", import.meta.url)),
      server: { host: "127.0.0.1", port: 0 },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("缺少 Web 测试端口");
    const response = await fetch(`http://127.0.0.1:${address.port}/__repa/connection`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const connection = await response.json() as ClientConnection;
    client = await RepaClient.connect(connection);
    const space = await client.call("space.open", { path: path.join(directory, "space") });
    expect(await client.call("space.list", {})).toEqual([space]);
    await client.close();
    await expect.poll(() => existsSync(connectionFile), { timeout: 5000 }).toBe(false);
  } finally {
    await client?.close();
    await server?.close();
    // 失败时也清理本测试启动的 detached 后端，避免残留进程。
    if (existsSync(connectionFile)) {
      const { pid } = JSON.parse(await readFile(connectionFile, "utf8")) as { pid: number };
      try { process.kill(pid, "SIGTERM"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await expect.poll(() => existsSync(connectionFile), { timeout: 5000 }).toBe(false);
    }
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
