import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { configDir } from "../src/config.js";
import { ensureModes } from "../src/map.js";
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

test("对话在登录以前就开着：登录以后发消息前换成有凭据的模型；记下的默认模型没有凭据时，新对话用第一个有凭据的", async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-login-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "kb");
  await mkdir(path.join(root, ".repa"), { recursive: true });
  await ensureModes(root);
  // 记下的默认模型的提供方已经登出
  await writeFile(path.join(root, ".repa/settings.json"), JSON.stringify({ model: "groq/openai/gpt-oss-20b" }));
  const runtime = await ModelRuntime.create({ authPath: path.join(base, "config/auth.json"), modelsPath: path.join(base, "config/models.json") });
  const sessions = await Sessions.create(root, { runtime, agentDir: path.join(base, "config") });
  const before = await sessions.open({ folder: "" });
  // 相当于在终端里 repa login 了一个提供方，后端没有重启
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  runtime.registerNativeProvider(faux.provider);
  faux.appendResponses([fauxAssistantMessage([fauxText("好")])]);
  await sessions.prompt(before.id, "你好", undefined, undefined);
  const infoOf = (id: string) => {
    let info: unknown;
    sessions.subscribe(id, (event) => { if (event.type === "snapshot") info = event.session; })();
    return info as { model?: string };
  };
  assert.equal(infoOf(before.id).model, `${faux.provider.id}/faux-1`);
  const fresh = await sessions.open({ folder: "", fresh: true });
  assert.equal(fresh.model, `${faux.provider.id}/faux-1`);
});
