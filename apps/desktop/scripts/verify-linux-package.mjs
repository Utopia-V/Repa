import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const deb = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("用法：node verify-linux-package.mjs <Repa.deb>");

const temporary = await mkdtemp(path.join(os.tmpdir(), "repa-deb-check-"));
let backend;
let client;
try {
  const installation = path.join(temporary, "installation");
  const { stdout: depends } = await exec("dpkg-deb", ["--field", deb, "Depends"]);
  assert(depends.split(",").some((entry) => /^git(?:\s|$)/.test(entry.trim())), "deb 必须声明影子 git 的 git 依赖");
  assert(depends.includes("ripgrep"), "deb 必须声明 Pi 搜索工具的 ripgrep 依赖");
  await exec("dpkg-deb", ["-x", deb, installation]);
  const installed = path.join(installation, "opt/Repa");
  const application = path.join(installed, "resources/app");
  const executable = path.join(installed, "repa");
  const base = path.join(application, "node_modules/@repa/base/dist");
  for (const file of [executable, path.join(base, "cli.js"), path.join(base, "process.js"),
    path.join(application, "node_modules/@repa/space-history/dist/index.js"),
    path.join(application, "out/renderer/index.html")]) {
    await access(file);
  }
  const environment = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const { stdout: runtime } = await exec(executable, ["-e", "console.log(JSON.stringify({node:process.versions.node}))"], { env: environment });
  const runtimeInfo = JSON.parse(runtime);
  assert(Number(runtimeInfo.node.split(".")[0]) >= 24);
  // 从安装布局导入 launcher 和 client，工作区依赖不能掩盖遗漏的运行依赖。
  const { startRepaProcess } = await import(pathToFileURL(path.join(base, "process.js")));
  const { RepaClient } = await import(pathToFileURL(path.join(base, "client.js")));
  backend = await startRepaProcess({ home: path.join(temporary, "home"), nodeExecutable: executable, environment });
  client = await RepaClient.connect(backend.connection);
  assert.equal(client.connected, true);
  assert.deepEqual(await client.call("space.list", {}), []);
  const root = path.join(temporary, "space");
  assert.deepEqual(await client.call("space.create", { root }), { root });
  assert.deepEqual(await client.call("space.list", {}), [root]);
  assert.deepEqual(await client.call("plugin.list", {}), []);
  await client.close();
  await backend.close();
  console.log(JSON.stringify({ deb, installedLayout: "opt/Repa", runtime: runtimeInfo, base: true, spaceHistory: true, connection: true, spaceEntry: true }, null, 2));
} finally {
  await client?.close();
  await backend?.close();
  await rm(temporary, { recursive: true, force: true });
}
