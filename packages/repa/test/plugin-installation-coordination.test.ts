import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { RepaApplication, type ApplicationOptions } from "../src/application.js";
import { SettingsViewSchema, type SettingScope } from "../src/configuration/schema.js";
import { RepaFault } from "../src/errors.js";
import { BackgroundRequestSchema } from "../src/requests/schema.js";
import { SpaceOperationSchema } from "../src/spaces/schema.js";

const code = (expected: string) => (error: unknown) => error instanceof RepaFault && error.code === expected;
function gate() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(t: TestContext, options: (root: string) => ApplicationOptions | Promise<ApplicationOptions>, release = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-plugin-installation-coordination-"));
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [], extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"],
  }));
  const app = new RepaApplication({ ...await options(root), agentDir, appDirectory: path.join(root, "app"), diagnostics: { level: "off" } });
  t.after(async () => {
    release();
    app.shutdown("cancel");
    await app.closed;
    await rm(root, { recursive: true, force: true });
  });
  const first = await app.openSpace(path.join(root, "first"));
  const second = await app.openSpace(path.join(root, "second"));
  const target = (spaceId: string, file: string) => ({ kind: "file" as const, spaceId, location: { kind: "relative" as const, path: file } });
  const write = (spaceId: string, file: string, text: string) => app.contentCall("content.write", {
    target: target(spaceId, file), base: { kind: "absent" }, operationId: randomUUID(), value: { kind: "text", text },
  });
  const read = async (spaceId: string, file: string) => {
    const value = await app.contentCall("content.read", { target: target(spaceId, file) });
    assert(value && typeof value === "object" && "text" in value);
    return value.text;
  };
  const settings = async (scope: SettingScope) => {
    const view = await app.settingsCall("settings.get", { scope, namespace: "plugins" });
    assert(Check(SettingsViewSchema, view));
    return view;
  };
  return { root, app, first, second, write, read, settings };
}

test("快照维护占用阻止应用插件设置和包准备，其他空间继续活动且失败尝试不保存设置", async t => {
  const entered = gate(), finish = gate();
  const f = await fixture(t, () => ({
    snapshotParticipants: [{
      id: "fixture-owner", version: "1", directory: ".repa/plugins/fixture-owner",
      async capture({ sourceDirectory, destinationDirectory }) {
        const bytes = await readFile(path.join(sourceDirectory, "state.json"));
        entered.release();
        await finish.promise;
        await writeFile(path.join(destinationDirectory, "state.json"), bytes);
      },
    }],
  }), finish.release);
  await f.write(f.first.id, "saved.txt", "快照原文\r\n");
  const ownerDirectory = path.join(f.first.path, ".repa/plugins/fixture-owner");
  await mkdir(ownerDirectory, { recursive: true });
  const ownerBytes = Buffer.from('{"version":1,"value":"原始状态"}\n');
  await writeFile(path.join(ownerDirectory, "state.json"), ownerBytes);
  const application = { kind: "application" as const };
  const before = await f.settings(application);
  const disabled = before.entries.find(entry => entry.key === "disabled");
  assert(disabled);
  const destination = path.join(f.root, "copy");
  const copying = f.app.spaceCall("space.copy", { spaceId: f.first.id, destination, operationId: randomUUID() });
  await entered.promise;
  await assert.rejects(f.app.settingsCall("settings.set", {
    scope: application, namespace: "plugins", key: "disabled", value: ["fixture-owner"], base: disabled.revision,
  }), code("space_busy"));
  assert.deepEqual(await f.settings(application), before);

  const requestId = randomUUID();
  const accepted = await f.app.packageCall("package.remove", {
    scope: application, requestId, source: path.join(f.root, "unused-local-package"),
  });
  assert(Check(BackgroundRequestSchema, accepted));
  assert.equal(accepted.requestId, requestId);
  const deadline = Date.now() + 5000;
  for (;;) {
    const request = await f.app.getRequest(undefined, requestId);
    assert(Check(BackgroundRequestSchema, request));
    if (["failed", "completed", "cancelled", "interrupted"].includes(request.status)) {
      assert.equal(request.status, "failed");
      assert.equal(request.error?.code, "space_busy");
      break;
    }
    assert(Date.now() < deadline, `包准备未进入终态：${request.status}`);
    await delay(5);
  }
  await f.write(f.second.id, "while-copying.txt", "其他空间继续工作。\n");
  assert.equal(await f.read(f.second.id, "while-copying.txt"), "其他空间继续工作。\n");
  assert.equal(f.app.createSession(f.second.id).spaceId, f.second.id);
  assert.deepEqual(await f.settings(application), before);

  finish.release();
  const copied = await copying;
  assert(Check(SpaceOperationSchema, copied));
  assert.equal(copied.status, "completed", copied.error?.message);
  assert.equal(await readFile(path.join(destination, "saved.txt"), "utf8"), "快照原文\r\n");
  assert.deepEqual(await readFile(path.join(destination, ".repa/plugins/fixture-owner/state.json")), ownerBytes);
  const updated = await f.app.settingsCall("settings.set", {
    scope: application, namespace: "plugins", key: "disabled", value: ["fixture-owner"], base: disabled.revision,
  });
  assert(Check(SettingsViewSchema, updated));
  assert.deepEqual(updated.entries.find(entry => entry.key === "disabled")?.effective, ["fixture-owner"]);
  assert((await f.app.describeCapabilities({ kind: "space", spaceId: f.first.id })).capabilities.length > 0,
    "维护拒绝的包准备不应提前设置重启标记。");
});

test("多空间刷新在后一个静态计划失败时统一失效已重建和旧声明，保留已保存配置与原文", async t => {
  const calls = { preview: 0, enabled: 0, codec: 0, format: 0 };
  const refreshed: string[] = [];
  const f = await fixture(t, async root => {
    const bundled = path.join(root, "collision-package");
    await mkdir(bundled);
    await writeFile(path.join(bundled, "package.json"), JSON.stringify({
      name: "fixture-collision", version: "1.0.0", type: "module", repa: { manifestVersion: 1 },
    }));
    return {
      plugins: [{
        id: "fixture-owner", enabled: true, factory: () => ({ capabilities: [] }),
        backgrounds: [{
          codec: { id: "fixture-background", customType: "fixture-background", snapshot() { calls.codec++; } },
          selection: { contract: { id: "fixture.background", version: "1" }, implementationId: "local" },
          input: null,
          enabled() { calls.enabled++; return true; },
          prepare() { throw new Error("本例只使用静态预览。"); },
          preview: { implementationId: "local", async read() {
            calls.preview++;
            return { message: { role: "custom", customType: "fixture-background", content: "固定背景", display: false, timestamp: 0 },
              text: "固定背景", revision: "fixture-v1" };
          } },
        }],
        formats: [{
          id: "fixture-format", field: "fixtureFormat", schema: Type.Null(), default: null,
          references() { calls.format++; return []; },
          files() { calls.format++; return []; },
          remapMetadata(value) { calls.format++; return value; },
          remapFile(bytes) { calls.format++; return bytes; },
        }],
      }],
      bundledPackages(configuration) {
        if (configuration.implementations["fixture.switch"] !== "armed") return [];
        const failing = configuration.backends.some(backend => backend.id === "second-marker");
        refreshed.push(failing ? "second" : "first");
        return failing ? [{ id: "fixture-owner", directory: bundled, enabled: false }] : [];
      },
    };
  });
  const marker = await f.settings({ kind: "space", spaceId: f.second.id });
  const backends = marker.entries.find(entry => entry.key === "backends");
  assert(backends);
  await f.app.settingsCall("settings.set", {
    scope: { kind: "space", spaceId: f.second.id }, namespace: "plugins", key: "backends", base: backends.revision,
    value: [{ id: "second-marker", package: { kind: "package", name: "fixture-not-installed" } }],
  });
  const sessions = [f.app.createSession(f.first.id), f.app.createSession(f.second.id)];
  for (const space of [f.first, f.second]) await f.write(space.id, "saved.txt", "失败刷新前的原文\r\n");
  for (const session of sessions) {
    const preview = await f.app.previewPrompts({ spaceId: session.spaceId, sessionId: session.sessionId });
    assert(preview.prompt.sources.some(source => source.id === "fixture-background" && source.content === "固定背景"));
  }
  assert.equal(calls.preview, 2);
  const application = { kind: "application" as const };
  const before = await f.settings(application);
  const implementations = before.entries.find(entry => entry.key === "implementations");
  assert(implementations);
  const changedNamespaces: string[] = [];
  t.after(f.app.watch({}, undefined, delivery => {
    if (delivery.type !== "changes") return;
    for (const change of delivery.changes)
      if (change.type === "settings" && change.scope.kind === "application") changedNamespaces.push(change.namespace);
  }));
  await assert.rejects(f.app.settingsCall("settings.set", {
    scope: application, namespace: "plugins", key: "implementations", base: implementations.revision,
    value: { "fixture.switch": "armed" },
  }), code("plugin_conflict"));
  assert.deepEqual(changedNamespaces, ["plugins"], "装配失败不能隐藏已经保存的配置变更。");
  assert.deepEqual(refreshed, ["first", "second"], "先完成第一个范围的同身份重建，再在第二个范围的计划中失败。");
  const after = await f.settings(application);
  assert.deepEqual(after.entries.find(entry => entry.key === "implementations")?.effective, { "fixture.switch": "armed" });
  assert.notEqual(after.entries.find(entry => entry.key === "implementations")?.revision, implementations.revision);
  const afterFailure = { ...calls };
  for (const session of sessions) {
    await assert.rejects(f.app.previewPrompts({ spaceId: session.spaceId, sessionId: session.sessionId }), code("plugin_restart_required"));
    await assert.rejects(f.app.describeCapabilities({ kind: "space", spaceId: session.spaceId }), code("plugin_restart_required"));
    await assert.rejects(f.write(session.spaceId, "rejected.txt", "不应写入"), code("plugin_restart_required"));
    assert.equal(await f.read(session.spaceId, "saved.txt"), "失败刷新前的原文\r\n");
  }
  assert.deepEqual(calls, afterFailure);
  for (const space of [f.first, f.second]) await assert.rejects(readFile(path.join(space.path, "rejected.txt")), { code: "ENOENT" });
});
