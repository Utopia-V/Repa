// @vitest-environment node
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { RepaClient } from "repa/client";
import { ensureDesktopRepaProcess } from "../src/main/repa-process";

it("Desktop 宿主复用真实后端，最后一个客户端退出后可重新启动", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-desktop-integration-")));
  const connectionFile = path.join(directory, "connection.json");
  const options = {
    connectionFile,
    nodeExecutable: process.execPath,
    nodeEnvironment: { ...process.env, XDG_CONFIG_HOME: path.join(directory, "config") },
  };
  let client: RepaClient | undefined;
  try {
    const connection = await ensureDesktopRepaProcess(options);
    client = await RepaClient.connect(connection);
    expect(await ensureDesktopRepaProcess(options)).toEqual(connection);
    const space = await client.call("space.open", { path: path.join(directory, "space") });
    expect(await client.call("space.list", {})).toEqual([space]);
    await client.close();
    await expect.poll(() => existsSync(connectionFile), { timeout: 5000 }).toBe(false);

    const restarted = await ensureDesktopRepaProcess(options);
    client = await RepaClient.connect(restarted);
    expect(await client.call("space.list", {})).toEqual([]);
    await client.close();
    await expect.poll(() => existsSync(connectionFile), { timeout: 5000 }).toBe(false);
  } finally {
    await client?.close();
    if (existsSync(connectionFile)) {
      const { pid } = JSON.parse(await readFile(connectionFile, "utf8")) as { pid: number };
      try { process.kill(pid, "SIGTERM"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await expect.poll(() => existsSync(connectionFile), { timeout: 5000 }).toBe(false);
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
