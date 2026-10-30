import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsStore } from "../src/settings.js";

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "repa-settings-"));
  const store = await SettingsStore.open(home);
  return { home, store };
}

test("设置保存后重新打开，最近空间去重截断，应用与空间覆盖分开恢复", async (t) => {
  const { home, store } = await fixture();
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, "space");
  await mkdir(path.join(root, ".repa"), { recursive: true });
  await Promise.all(Array.from({ length: 25 }, (_, index) => store.remember(`/space/${index}`)));
  await store.remember("/space/20");
  assert.equal(store.get().recentSpaces.length, 20);
  assert.equal(store.get().recentSpaces[0], "/space/20");
  await store.set({ commandPolicy: "fullAccess" });
  await store.setPrompt("app", "base", { text: "应用说明" });
  await store.setPrompt("space", "base", { enabled: false }, root);
  assert.deepEqual(await store.overrides(root), {
    app: { base: { text: "应用说明" } }, space: { base: { enabled: false } },
  });
  await store.setPrompt("space", "base", undefined, root);
  assert.deepEqual((await store.overrides(root)).space, {});
  const reopened = await SettingsStore.open(home);
  assert.deepEqual(reopened.get(), store.get());
  const received = reopened.get();
  received.recentSpaces.length = 0;
  assert.equal(reopened.get().recentSpaces.length, 20);
  assert.match(await readFile(path.join(home, "settings.json"), "utf8"), /应用说明/u);
});

test("损坏设置和已知字段的无效值不能退回默认值掩盖数据错误", async (t) => {
  const { home } = await fixture();
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, "settings.json"), "{");
  await assert.rejects(SettingsStore.open(home));
  await writeFile(path.join(home, "settings.json"), JSON.stringify({
    commandPolicy: "typo", prompts: {}, recentSpaces: [],
  }));
  await assert.rejects(SettingsStore.open(home), { code: "invalid_input" });
});


test("设置读取忽略新增字段，写入仍拒绝未知字段", async (t) => {
  const { home } = await fixture();
  t.after(() => rm(home, { recursive: true, force: true }));
  const original = JSON.stringify({
    commandPolicy: "ask", recentSpaces: [], futureSetting: true,
    prompts: { base: { text: "保留的说明", futureOption: 1 } },
  });
  await writeFile(path.join(home, "settings.json"), original);
  const store = await SettingsStore.open(home);
  assert.deepEqual(store.get(), {
    commandPolicy: "ask", recentSpaces: [], prompts: { base: { text: "保留的说明" } },
    backup: { intervalMinutes: 30, keep: 5 },
  });
  assert.equal(await readFile(path.join(home, "settings.json"), "utf8"), original);
  await assert.rejects(store.set(JSON.parse('{"unknown":true}')), { code: "invalid_input" });
  await store.set({ commandPolicy: "fullAccess" });
  assert.equal((await SettingsStore.open(home)).get().commandPolicy, "fullAccess");
});

test("加入备份设置之前保存的设置取默认的间隔与份数；保存后重开沿用新值，超出范围的值被拒绝", async (t) => {
  const { home } = await fixture();
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ commandPolicy: "fullAccess", recentSpaces: [], prompts: {} }));
  const store = await SettingsStore.open(home);
  assert.deepEqual(store.get().backup, { intervalMinutes: 30, keep: 5 });
  assert.equal(store.get().commandPolicy, "fullAccess");
  await store.set({ backup: { intervalMinutes: 60, keep: 1 } });
  assert.deepEqual((await SettingsStore.open(home)).get().backup, { intervalMinutes: 60, keep: 1 });
  await assert.rejects(store.set({ backup: { intervalMinutes: 1, keep: 5 } }), { code: "invalid_input" });
  await assert.rejects(store.set({ backup: { intervalMinutes: 30, keep: 0 } }), { code: "invalid_input" });
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ commandPolicy: "ask", recentSpaces: [], prompts: {}, backup: { intervalMinutes: "30", keep: 5 } }));
  await assert.rejects(SettingsStore.open(home), { code: "invalid_input" });
});
