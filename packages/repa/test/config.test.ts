import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { configDir } from "../src/config.js";
import { Sessions } from "../src/pi/sessions.js";

test("配置目录：REPA_CONFIG 指定时用它，否则 $XDG_CONFIG_HOME/repa，缺省 ~/.config/repa", () => {
  assert.equal(configDir({ REPA_CONFIG: "/tmp/试用" }, "/home/甲"), "/tmp/试用");
  assert.equal(configDir({ XDG_CONFIG_HOME: "/home/甲/.cfg" }, "/home/甲"), "/home/甲/.cfg/repa");
  assert.equal(configDir({}, "/home/甲"), "/home/甲/.config/repa");
  assert.equal(configDir({ XDG_CONFIG_HOME: "" }, "/home/甲"), "/home/甲/.config/repa");
});

test("Repa 的配置目录里没有凭据时一个模型也没有，不去读 Pi 的 ~/.pi/agent/auth.json", async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-config-")));
  const saved = { HOME: process.env.HOME, REPA_CONFIG: process.env.REPA_CONFIG };
  t.after(async () => {
    Object.assign(process.env, saved);
    if (saved.REPA_CONFIG === undefined) delete process.env.REPA_CONFIG;
    await rm(base, { recursive: true, force: true });
  });
  // 假的 Pi 目录里放一份有凭据的 auth.json；Repa 若去读它，就会列出这个提供方的模型
  await mkdir(path.join(base, "home/.pi/agent"), { recursive: true });
  await writeFile(path.join(base, "home/.pi/agent/auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: "sk-假的" }, groq: { type: "api_key", key: "gsk-假的" } }));
  await mkdir(path.join(base, "kb"));
  process.env.HOME = path.join(base, "home");
  process.env.REPA_CONFIG = path.join(base, "config");
  const sessions = await Sessions.create(path.join(base, "kb"));
  assert.deepEqual(await sessions.models(), []);
  await writeFile(path.join(base, "config/auth.json"), JSON.stringify({ groq: { type: "api_key", key: "gsk-假的" } }));
  const again = await Sessions.create(path.join(base, "kb"));
  assert.deepEqual([...new Set((await again.models()).map((model) => model.provider))], ["groq"]);
});
