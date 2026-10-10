// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "vite";
import { RepaClient } from "@repa/base/client";
import { expect, it } from "vitest";

it("Web 开发宿主交付新底座连接，关闭宿主后连接中断", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-web-integration-"));
  const oldHome = process.env.REPA_HOME;
  process.env.REPA_HOME = directory;
  const server = await createServer({ server: { port: 0 } });
  let client: RepaClient | undefined;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Web 开发服务器没有监听地址");
    const response = await fetch(`http://127.0.0.1:${address.port}/__repa/connection`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    client = await RepaClient.connect(await response.json());
    expect(client.connected).toBe(true);
    expect(await client.call("space.list", {})).toEqual([]);
    expect(await client.call("space.create", { root: path.join(directory, "space") })).toEqual({ root: path.join(directory, "space") });
    await server.close();
    await expect.poll(() => client?.connected, { timeout: 8000 }).toBe(false);
  } finally {
    await client?.close();
    await server.close();
    if (oldHome === undefined) delete process.env.REPA_HOME;
    else process.env.REPA_HOME = oldHome;
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
