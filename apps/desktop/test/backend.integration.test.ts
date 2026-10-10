// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RepaClient } from "@repa/base/client";
import { startRepaProcess, type RepaProcess } from "@repa/base/process";
import { expect, it } from "vitest";

it("Desktop 使用的 Node 宿主拉起新底座，断开客户端后服务由宿主显式关闭", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-desktop-integration-"));
  let backend: RepaProcess | undefined;
  let client: RepaClient | undefined;
  try {
    backend = await startRepaProcess({ home: directory, nodeExecutable: process.execPath });
    client = await RepaClient.connect(backend.connection);
    expect(client.connected).toBe(true);
    expect(await client.call("space.list", {})).toEqual([]);
    await client.close();
    client = await RepaClient.connect(backend.connection);
    expect(client.connected).toBe(true);
    await backend.close();
    await backend.closed;
    await expect.poll(() => client?.connected, { timeout: 5000 }).toBe(false);
  } finally {
    await client?.close();
    await backend?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
