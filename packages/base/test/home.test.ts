import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { migrateAppHome, prepareAppHome, resolveAppHome } from "../src/home.js";

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-home-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, ".repa");
  const target = path.join(directory, ".config", "repa");
  await mkdir(path.join(source, "agent", "skills", "example"), { recursive: true });
  await writeFile(path.join(source, "settings.json"), "{\n  \"prompts\": {}\n}\n");
  await writeFile(path.join(source, "agent", "auth.json"), "本地测试凭据\n");
  await chmod(path.join(source, "agent", "auth.json"), 0o600);
  await writeFile(path.join(source, "agent", "skills", "example", "SKILL.md"), "# 本地技能\n");
  return { directory, source, target };
}

test("默认应用配置位置遵循系统目录和显式覆盖优先级", () => {
  assert.equal(resolveAppHome({ platform: "linux", userHome: "/users/local", env: {} }), "/users/local/.config/repa");
  assert.equal(resolveAppHome({ platform: "linux", userHome: "/users/local", env: { XDG_CONFIG_HOME: "/config" } }), "/config/repa");
  assert.equal(resolveAppHome({ platform: "linux", userHome: "/users/local", env: { XDG_CONFIG_HOME: "relative" } }), "/users/local/.config/repa");
  assert.equal(resolveAppHome({ platform: "darwin", userHome: "/Users/local", env: {} }), "/Users/local/Library/Application Support/Repa");
  assert.equal(resolveAppHome({ platform: "win32", userHome: "C:\\Users\\local", env: { APPDATA: "D:\\Roaming" } }), "D:\\Roaming\\Repa");
  assert.equal(resolveAppHome({ platform: "win32", userHome: "C:\\Users\\local", env: {} }), "C:\\Users\\local\\AppData\\Roaming\\Repa");
  assert.equal(resolveAppHome({ platform: "linux", env: { REPA_HOME: "/override", XDG_CONFIG_HOME: "/config" } }), "/override");
  assert.equal(resolveAppHome({ platform: "linux", home: "/explicit", env: { REPA_HOME: "/override" } }), "/explicit");
});

test("旧配置完整搬到空的新位置，字节、凭据权限和应用技能保留", async (t) => {
  const { source, target } = await fixture(t);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(source, "extra.txt"), "额外配置\r\n");
  const warnings: string[] = [];
  await migrateAppHome(source, target, message => warnings.push(message));
  assert.equal(await readFile(path.join(target, "settings.json"), "utf8"), "{\n  \"prompts\": {}\n}\n");
  assert.equal(await readFile(path.join(target, "agent", "auth.json"), "utf8"), "本地测试凭据\n");
  assert.equal(await readFile(path.join(target, "agent", "skills", "example", "SKILL.md"), "utf8"), "# 本地技能\n");
  assert.equal(await readFile(path.join(target, "extra.txt"), "utf8"), "额外配置\r\n");
  if (process.platform !== "win32") assert.equal((await stat(path.join(target, "agent", "auth.json"))).mode & 0o777, 0o600);
  await assert.rejects(lstat(source), { code: "ENOENT" });
  assert.equal(warnings.length, 1);
  await migrateAppHome(source, target, message => warnings.push(message));
  assert.equal(warnings.length, 1);
});

test("新位置已有内容时使用新配置，旧配置原样保留并提示", async (t) => {
  const { source, target } = await fixture(t);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "settings.json"), "新设置\n");
  const warnings: string[] = [];
  await migrateAppHome(source, target, message => warnings.push(message));
  assert.equal(await readFile(path.join(target, "settings.json"), "utf8"), "新设置\n");
  assert.deepEqual(await readdir(target), ["settings.json"]);
  assert.equal(await readFile(path.join(source, "agent", "auth.json"), "utf8"), "本地测试凭据\n");
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]?.includes(source));
  assert.ok(warnings[0]?.includes(target));
});

test("旧目录同时是空间时只搬应用配置，格式标记和空间数据原样保留", async (t) => {
  const { source, target } = await fixture(t);
  await writeFile(path.join(source, "format.json"), "{\"version\":1}\n");
  await mkdir(path.join(source, "sessions"));
  await writeFile(path.join(source, "sessions", "old.jsonl"), "空间会话\n");
  await writeFile(path.join(source, "prompts.json"), "空间提示词\n");
  await migrateAppHome(source, target, () => {});
  assert.deepEqual((await readdir(source)).sort(), ["format.json", "prompts.json", "sessions"]);
  assert.equal(await readFile(path.join(source, "format.json"), "utf8"), "{\"version\":1}\n");
  assert.equal(await readFile(path.join(source, "sessions", "old.jsonl"), "utf8"), "空间会话\n");
  assert.deepEqual((await readdir(target)).sort(), ["agent", "settings.json"]);
});

test("显式 home 和 REPA_HOME 都隔离默认配置，查询位置不搬文件", async (t) => {
  const { directory, source, target } = await fixture(t);
  assert.equal(resolveAppHome({ userHome: directory, env: {} }), target);
  assert.equal(await prepareAppHome({ home: path.join(directory, "explicit"), userHome: directory, env: {} }), path.join(directory, "explicit"));
  assert.equal(await prepareAppHome({ userHome: directory, env: { REPA_HOME: path.join(directory, "env-home") } }), path.join(directory, "env-home"));
  assert.equal(await readFile(path.join(source, "agent", "auth.json"), "utf8"), "本地测试凭据\n");
  await assert.rejects(lstat(target), { code: "ENOENT" });
});

test("搬移保留符号链接，目标与源互相包含时在写入前拒绝", { skip: process.platform === "win32" }, async (t) => {
  const { directory, source, target } = await fixture(t);
  await symlink("auth.json", path.join(source, "agent", "auth-link.json"));
  await assert.rejects(migrateAppHome(source, path.join(source, "nested"), () => {}), { code: "home_migration_failed" });
  await assert.rejects(lstat(path.join(source, "nested")), { code: "ENOENT" });
  await assert.rejects(migrateAppHome(source, directory, () => {}), { code: "home_migration_failed" });
  await migrateAppHome(source, target, () => {});
  assert.equal((await lstat(path.join(target, "agent", "auth-link.json"))).isSymbolicLink(), true);
  assert.equal(await readFile(path.join(target, "agent", "auth-link.json"), "utf8"), "本地测试凭据\n");
});

test("默认启动在注入的用户目录里搬配置，后续启动继续使用新位置", async (t) => {
  const { directory, source, target } = await fixture(t);
  const home = await prepareAppHome({ userHome: directory, env: {}, platform: "linux" });
  assert.equal(home, target);
  await assert.rejects(lstat(source), { code: "ENOENT" });
  assert.equal(await readFile(path.join(home, "agent", "auth.json"), "utf8"), "本地测试凭据\n");
  assert.equal(await prepareAppHome({ userHome: directory, env: {}, platform: "linux" }), home);
});

for (const emptyTarget of [false, true]) {
  test(`目标${emptyTarget ? "为空目录" : "不存在"}时复制中途失败不发布半份配置，清理后下次可重试`, { skip: process.platform === "win32" }, async (t) => {
    const { source, target } = await fixture(t);
    await mkdir(path.dirname(target), { recursive: true });
    if (emptyTarget) await mkdir(target);
    // 按名称最后复制这个 socket，前面的 agent/ 和 settings.json 已经实际复制到临时目录。
    const socket = createServer();
    const listening = once(socket, "listening");
    socket.listen(path.join(source, "zz-copy-failure"));
    await listening;
    try {
      await assert.rejects(migrateAppHome(source, target, () => {}), { code: "home_migration_failed" });
      await assert.rejects(lstat(target), { code: "ENOENT" });
      assert.deepEqual(await readdir(path.dirname(target)), []);
      assert.equal(await readFile(path.join(source, "settings.json"), "utf8"), "{\n  \"prompts\": {}\n}\n");
      assert.equal(await readFile(path.join(source, "agent", "auth.json"), "utf8"), "本地测试凭据\n");
      assert.equal(await readFile(path.join(source, "agent", "skills", "example", "SKILL.md"), "utf8"), "# 本地技能\n");
    } finally {
      await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
    }

    await migrateAppHome(source, target, () => {});
    assert.equal(await readFile(path.join(target, "agent", "auth.json"), "utf8"), "本地测试凭据\n");
    if (process.platform !== "win32") assert.equal((await stat(path.join(target, "agent", "auth.json"))).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(path.dirname(target)), [path.basename(target)]);
    await assert.rejects(lstat(source), { code: "ENOENT" });
  });
}
