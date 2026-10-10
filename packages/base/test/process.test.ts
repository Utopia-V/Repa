import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RepaClient } from "../src/client.js";
import { startRepaProcess } from "../dist/process.js";

async function fixture(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-process-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("Node 宿主从 stdout 取得连接并可重复关闭服务", async (t) => {
  const home = await fixture(t);
  const backend = await startRepaProcess({ home });
  t.after(() => backend.close());
  const client = await RepaClient.connect(backend.connection);
  t.after(() => client.close());
  assert.equal(client.connected, true);
  assert.deepEqual(await client.call("space.list", {}), []);
  await Promise.all([backend.close(), backend.close()]);
  await backend.closed;
  assert.equal(client.connected, false);
});

test("启动可执行文件不存在时返回错误而不遗留进程", async (t) => {
  const home = await fixture(t);
  await assert.rejects(startRepaProcess({ home, nodeExecutable: path.join(home, "missing") }), { code: "ENOENT" });
});

test("CLI 启动失败交付诊断并完成进程回收", async (t) => {
  const directory = await fixture(t);
  const home = path.join(directory, "not-a-directory");
  await writeFile(home, "原有文件");
  await assert.rejects(startRepaProcess({ home }), /Repa 后端启动失败/);
});

test("启动超时终止尚未交付连接的进程", async (t) => {
  const directory = await fixture(t);
  const executable = path.join(directory, "waiting");
  await writeFile(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  await assert.rejects(startRepaProcess({ nodeExecutable: executable, startupTimeoutMs: 100 }), /启动超时/);
});

test("stdout 不是连接信息时终止错误服务", async (t) => {
  const directory = await fixture(t);
  const executable = path.join(directory, "invalid");
  await writeFile(executable, `#!${process.execPath}\nconsole.log('not-json'); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  await assert.rejects(startRepaProcess({ nodeExecutable: executable }), /无效连接信息/);
});


test("正常关闭等待超过五秒的真实收尾，不截断服务保存", async (t) => {
  const directory = await fixture(t);
  const executable = path.join(directory, "slow-close");
  await writeFile(executable, `#!${process.execPath}\nprocess.on('SIGTERM', () => { setTimeout(() => { process.exit(0); }, 5100); }); console.log(JSON.stringify({url:'ws://127.0.0.1:1',token:'test'})); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const backend = await startRepaProcess({ nodeExecutable: executable });
  t.after(() => backend.close());
  await backend.close();
  await backend.closed;
});

test("已启动服务的非零退出通过 closed 与 close 报告失败", async (t) => {
  const directory = await fixture(t);
  const executable = path.join(directory, "failed-close");
  await writeFile(executable, `#!${process.execPath}\nconsole.log(JSON.stringify({url:'ws://127.0.0.1:1',token:'test'})); setTimeout(() => { process.exit(7); }, 100);\n`, { mode: 0o700 });
  const backend = await startRepaProcess({ nodeExecutable: executable });
  await assert.rejects(backend.closed, /异常退出（7）/);
  await assert.rejects(backend.close(), /异常退出（7）/);
});
