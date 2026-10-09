import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { RepaClient } from "../src/client.js";

async function until(predicate: () => boolean, describe: () => string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    assert(Date.now() < deadline, describe());
    await delay(20);
  }
}

test("通用与学习 CLI 自动启动各自产品后端，不把学习默认装配带进通用进程", { timeout: 45000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-cli-product-"));
  const runtimeDirectory = path.join(root, "runtime");
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [], extensions: [], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"],
  }));
  const instances: Array<{ name: string; backendPid: number; connectionFile: string }> = [];
  const cleanup: Array<() => Promise<void>> = [];
  t.after(async () => {
    const results = await Promise.allSettled(cleanup.map(close => close()));
    await rm(root, { recursive: true, force: true });
    for (const result of results) if (result.status === "rejected") throw result.reason;
  });
  for (const [name, entry] of [
    ["repa", fileURLToPath(new URL("../dist/cli.js", import.meta.url))],
    ["repa-learning", fileURLToPath(import.meta.resolve("@repa/learning/cli"))],
  ] as const) {
    const connectionFile = path.join(runtimeDirectory, `${name}-${process.getuid?.() ?? os.userInfo().username}`, "connection.json");
    const child = spawn(process.execPath, [entry, path.join(root, name), "--agent-dir", agentDir], {
      env: { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory, XDG_CONFIG_HOME: path.join(root, "config") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    let client: RepaClient | undefined;
    let backendPid: number | undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { errors += chunk; });
    const closed = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => { resolve(); });
    });
    const close = async () => {
      await client?.close();
      if (child.exitCode === null && child.signalCode === null) child.stdin.end("/exit\n");
      await until(() => child.exitCode !== null || child.signalCode !== null, () => `${name} TUI 未退出：${errors}`);
      await closed;
      if (backendPid !== undefined) await until(() => !existsSync(connectionFile), () => `${name} 后端未收尾：${errors}`);
    };
    cleanup.push(async () => {
      try {
        await close();
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        if (existsSync(connectionFile)) {
          const remaining: unknown = JSON.parse(await readFile(connectionFile, "utf8"));
          assert(remaining !== null && typeof remaining === "object" && "pid" in remaining && typeof remaining.pid === "number");
          try { process.kill(remaining.pid, "SIGTERM"); }
          catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error; }
          await until(() => !existsSync(connectionFile), () => `${name} 后端未退出`);
        }
        await closed;
      }
    });
    await until(() => output.includes("You> ") || child.exitCode !== null, () => `${name} TUI 未就绪：${output}\n${errors}`);
    assert.equal(child.exitCode, null, errors);
    const endpoint: unknown = JSON.parse(await readFile(connectionFile, "utf8"));
    assert(endpoint !== null && typeof endpoint === "object" && "url" in endpoint && typeof endpoint.url === "string");
    assert("token" in endpoint && typeof endpoint.token === "string");
    assert("pid" in endpoint && typeof endpoint.pid === "number");
    backendPid = endpoint.pid;
    client = await RepaClient.connect({ url: endpoint.url, token: endpoint.token });
    const space = (await client.call("space.list", {}))[0];
    assert(space);
    const scope = { kind: "space" as const, spaceId: space.id };
    const capabilities = await client.call("capability.describe", { scope });
    assert.deepEqual(capabilities.issues, []);
    assert.equal(capabilities.capabilities.some(item => item.contract.id === "repa.context.preview"), name === "repa-learning");
    const packages = await client.call("package.list", { scope });
    assert.equal(packages.some(item => item.name === "@repa/learning"), name === "repa-learning");
    const prompts = await client.call("settings.get", { scope, namespace: "prompts" });
    const base = prompts.entries.find(item => item.key === "base");
    assert(base && typeof base.effective === "string");
    assert.equal(base.effective.length > 0, name === "repa-learning");
    instances.push({ name, backendPid, connectionFile });
  }
  assert.equal(new Set(instances.map(instance => instance.backendPid)).size, 2);
  assert.equal(new Set(instances.map(instance => instance.connectionFile)).size, 2);
});
