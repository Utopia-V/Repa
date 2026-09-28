import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { ContentAccessStore } from "../src/content/access.js";
import { RepaFault } from "../src/errors.js";

async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "repa-content-access-"));
  const appDirectory = path.join(root, "application");
  const material = path.join(root, "lesson.pdf");
  const sibling = path.join(root, "other.pdf");
  await Promise.all([writeFile(material, "lesson"), writeFile(sibling, "other")]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root, appDirectory, material, sibling,
    file: path.join(appDirectory, "repa-content-access.json"),
    open: () => ContentAccessStore.open(appDirectory),
  };
}
const fault = (code: string) => (error: unknown) => error instanceof RepaFault && error.code === code;

test("授权仅属于指定空间和精确文件，其他实例立即可见且重开恢复", async (t) => {
  const f = await fixture(t);
  const writer = await f.open();
  const reader = await f.open();
  assert(!reader.canRead("alpha", f.material));
  assert(!existsSync(f.appDirectory));
  await writer.grant("alpha", f.material);
  assert(reader.canRead("alpha", f.material));
  assert(!reader.canRead("beta", f.material));
  assert(!reader.canRead("alpha", f.sibling));
  assert(!reader.canRead("alpha", f.root));
  const bytes = readFileSync(f.file, "utf8");
  await writer.grant("alpha", f.material);
  assert.equal(readFileSync(f.file, "utf8"), bytes);
  assert((await f.open()).canRead("alpha", f.material));
  await rm(f.material);
  assert(reader.canRead("alpha", f.material));
  await mkdir(f.material);
  assert(!reader.canRead("alpha", f.material));
});

test("授权解析所选路径的真实普通文件，目录与相对路径不能取得授权", async (t) => {
  const f = await fixture(t);
  const store = await f.open();
  await assert.rejects(store.grant("alpha", f.root), fault("invalid_input"));
  await assert.rejects(store.grant("alpha", "lesson.pdf"), fault("invalid_input"));
  assert(!existsSync(f.appDirectory));
  const link = path.join(f.root, "chosen.pdf");
  await symlink(f.material, link);
  await store.grant("alpha", `${f.root}${path.sep}.${path.sep}chosen.pdf`);
  const canonical = await realpath(link);
  assert(store.canRead("alpha", canonical));
  assert(!store.canRead("alpha", link));
  await rm(link);
  await symlink(f.sibling, link);
  assert(!store.canRead("alpha", await realpath(link)));
  assert(store.canRead("alpha", canonical));
  await rm(f.material);
  await symlink(f.sibling, f.material);
  assert(!store.canRead("alpha", canonical));
  const folder = path.join(f.root, "folder");
  const nested = path.join(folder, "lesson.pdf");
  await mkdir(folder);
  await writeFile(nested, "nested lesson");
  await store.grant("alpha", nested);
  await rename(folder, path.join(f.root, "moved-folder"));
  await symlink(f.root, folder, "dir");
  assert(!store.canRead("alpha", nested));
});

function grantWorker(t: TestContext, appDirectory: string, grants: { spaceId: string; file: string }[]) {
  const module = new URL("../src/content/access.ts", import.meta.url).href;
  const script = `
    import { ContentAccessStore } from ${JSON.stringify(module)};
    const store = await ContentAccessStore.open(process.argv[1]);
    const grants = JSON.parse(process.argv[2]);
    process.once("message", async () => {
      try { await Promise.all(grants.map(grant => store.grant(grant.spaceId, grant.file))); }
      catch (error) { console.error(error); process.exitCode = 1; }
      finally { process.disconnect(); }
    });
    process.send("ready");
  `;
  const child = spawn(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval", script, appDirectory, JSON.stringify(grants),
  ], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr!.on("data", (bytes: Buffer) => { stderr += bytes.toString(); });
  const ready = new Promise<void>((resolve, reject) => {
    child.once("message", () => resolve());
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`授权进程提前退出：${stderr}`)));
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  return { ready, done, run: () => { child.send("start"); } };
}

test("不同进程并发授权不丢失其他文件或空间的授权", async (t) => {
  const f = await fixture(t);
  const reader = await f.open();
  const left = grantWorker(t, f.appDirectory, [
    { spaceId: "alpha", file: f.material },
    { spaceId: "beta", file: f.sibling },
  ]);
  const right = grantWorker(t, f.appDirectory, [
    { spaceId: "alpha", file: f.sibling },
    { spaceId: "beta", file: f.material },
  ]);
  await Promise.all([left.ready, right.ready]);
  left.run(); right.run();
  await Promise.all([left.done, right.done]);
  for (const store of [reader, await f.open()]) {
    assert(store.canRead("alpha", f.material));
    assert(store.canRead("alpha", f.sibling));
    assert(store.canRead("beta", f.material));
    assert(store.canRead("beta", f.sibling));
    assert(!store.canRead("gamma", f.material));
  }
});

test("无法解析或无效的应用记录明确报错，读取和后续授权保留原文件", async (t) => {
  const f = await fixture(t);
  const store = await f.open();
  await store.grant("alpha", f.material);
  const valid = readFileSync(f.file, "utf8");
  const invalid = JSON.parse(valid);
  invalid.reads[0].file = "relative.pdf";
  for (const bytes of ["{broken json}\n", JSON.stringify(invalid), '{"format":"repa.content-access","version":99,"reads":[]}']) {
    await writeFile(f.file, bytes);
    await assert.rejects(f.open(), fault("invalid_storage"));
    assert.throws(() => store.canRead("alpha", f.material), fault("invalid_storage"));
    await assert.rejects(store.grant("beta", f.sibling), fault("invalid_storage"));
    assert.equal(readFileSync(f.file, "utf8"), bytes);
  }
  await writeFile(f.file, valid);
  assert((await f.open()).canRead("alpha", f.material));
});
