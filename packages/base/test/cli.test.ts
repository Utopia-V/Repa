import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { RepaClient, RpcError, type ClientConnection } from "../src/client.js";
import { record } from "../src/protocol/json-rpc.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface RunningCli {
  child: ChildProcessWithoutNullStreams;
  exited: Promise<Exit>;
  stderr(): string;
  connection: Promise<ClientConnection>;
}

function deadline<T>(promise: Promise<T>, ms: number, message: () => string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message())), ms);
    promise.then((result) => {
      clearTimeout(timer);
      resolve(result);
    }, (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function launch(home: string, plugin?: string): RunningCli {
  const args = ["--import", "tsx", "src/cli.ts", "serve", "--home", home];
  if (plugin) args.push("--plugin", plugin);
  const env = { ...process.env };
  delete env.REPA_TOKEN;
  delete env.REPA_HOME;
  const child = spawn(process.execPath, args, { cwd: packageRoot, env, stdio: "pipe" });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8192); });
  const exited = new Promise<Exit>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const connection = new Promise<ClientConnection>((resolve, reject) => {
    let buffer = "";
    let announced = false;
    const failed = (error: Error) => reject(error);
    child.once("error", failed);
    child.once("exit", (code, signal) => {
      if (!announced) reject(new Error(`CLI 在公布连接前退出：code=${code}, signal=${signal}\n${stderr}`));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (announced) return;
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      announced = true;
      child.removeListener("error", failed);
      try {
        const value = record(JSON.parse(buffer.slice(0, end)) as unknown);
        if (!value || typeof value.url !== "string" || typeof value.token !== "string") {
          throw new Error("CLI 连接公告不符合 {url,token} 格式");
        }
        resolve({ url: value.url, token: value.token });
      } catch (error) {
        reject(error);
      }
    });
  });
  return { child, exited, connection, stderr: () => stderr };
}

async function stop(cli: RunningCli): Promise<Exit> {
  if (cli.child.exitCode === null && cli.child.signalCode === null) cli.child.kill("SIGTERM");
  try {
    return await deadline(cli.exited, 10000, () => `CLI 收到 SIGTERM 后没有退出\n${cli.stderr()}`);
  } catch (error) {
    cli.child.kill("SIGKILL");
    await deadline(cli.exited, 5000, () => `CLI 无法终止\n${cli.stderr()}`);
    throw error;
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-cli-"));
  const children: RunningCli[] = [];
  const clients: RepaClient[] = [];
  t.after(async () => {
    const results = await Promise.allSettled(children.map((cli) => stop(cli)));
    await Promise.allSettled(clients.map((client) => client.close()));
    await rm(root, { recursive: true, force: true });
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  });
  return {
    root,
    async start(name: string, plugin?: string) {
      const cli = launch(path.join(root, name), plugin);
      children.push(cli);
      const connection = await deadline(cli.connection, 10000, () => `CLI 未公布连接\n${cli.stderr()}`);
      const client = await RepaClient.connect(connection, { requestTimeoutMs: 10000 });
      clients.push(client);
      return { cli, client };
    },
  };
}

test("两个 CLI 进程争用同一空间，持锁进程退出后另一个进程能够打开", async (t) => {
  const f = await fixture(t);
  const space = path.join(f.root, "space");
  await mkdir(space);
  const first = await f.start("first-home");
  const second = await f.start("second-home");
  assert.deepEqual(await first.client.call("space.open", { root: space }), { root: space });
  await assert.rejects(second.client.call("space.open", { root: space }), (error: unknown) => {
    assert.ok(error instanceof RpcError);
    assert.equal(record(error.data)?.code, "space_locked");
    return true;
  });
  const exit = await stop(first.cli);
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.deepEqual(await second.client.call("space.open", { root: space }), { root: space });
  await second.client.call("space.close", {});
});

test("CLI 通过模块路径加载笔记插件，界面调用完成真实保存和历史记录", async (t) => {
  const f = await fixture(t);
  const { cli, client } = await f.start("plugin-home", "examples/notes-plugin.ts");
  const space = path.join(f.root, "notes-space");
  await client.call("space.create", { root: space });
  const plugins = await client.call("plugin.list", {});
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0]?.id, "notes");
  assert.ok(plugins[0]?.methods.includes("save"));
  const text = "全角标点，逐字保留。\n第二行。\n";
  assert.deepEqual(await client.call("plugin.call", {
    pluginId: "notes", method: "save", input: { name: "cli-smoke", text },
  }), { name: "cli-smoke" });
  assert.equal(await readFile(path.join(space, "notes", "cli-smoke.md"), "utf8"), text);
  assert.ok((await client.call("history.changes", {})).revisions.some((revision) => {
    return revision.source.kind === "plugin" && revision.source.pluginId === "notes"
      && revision.changes.some((change) => change.path === "notes/cli-smoke.md");
  }));
  assert.deepEqual(await stop(cli), { code: 0, signal: null });
});
