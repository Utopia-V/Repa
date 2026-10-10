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

test("损坏或未知设置字段不能退回默认值掩盖数据错误", async (t) => {
  const { home } = await fixture();
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, "settings.json"), "{");
  await assert.rejects(SettingsStore.open(home));
  await writeFile(path.join(home, "settings.json"), JSON.stringify({
    commandPolicy: "ask", prompts: {}, recentSpaces: [], typo: true,
  }));
  await assert.rejects(SettingsStore.open(home), { code: "invalid_input" });
});
