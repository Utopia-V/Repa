import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { InstalledContributions } from "../src/agent/contributions.js";
import type { BackgroundCodec, PreparedBackground, WorkingMessage } from "../src/agent/background.js";
import type { CapabilityBackground } from "../src/capabilities/types.js";
import type { PluginSettings } from "../src/configuration/plugins.js";
import { ConfigStore } from "../src/configuration/store.js";
import { ContentStore } from "../src/content/store.js";
import { RepaFault } from "../src/errors.js";

function barrier() {
  let release = () => {};
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}
const fault = (error: unknown) => error instanceof RepaFault && error.code === "plugin_restart_required";
const configuration: PluginSettings = { backends: [], disabled: [], trusted: [], implementations: {} };
const message: WorkingMessage = { role: "custom", customType: "fixture-history", content: "背景", display: false, details: {}, timestamp: 0 };
const prepared: PreparedBackground = { message, revision: "fixture", text: "背景" };

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-installed-lifecycle-"));
  const directory = path.join(root, "space");
  await mkdir(directory);
  await writeFile(path.join(directory, "preview.txt"), "真实内容");
  const content = await ContentStore.open({ root: directory, spaceId: randomUUID(), assertOwned() {} });
  const store = new ConfigStore({ appDirectory: path.join(root, "app"), resolveSpace() { throw new Error("默认prompts不需空间"); } });
  const prompts = await store.prompts({ kind: "application" });
  t.after(async () => { await content.settled(); await rm(root, { recursive: true, force: true }); });
  return { content, prompts };
}

function background(overrides: Partial<CapabilityBackground> = {}): CapabilityBackground {
  return { codec: { id: "fixture", customType: "fixture-history", snapshot: () => undefined },
    selection: { contract: { id: "fixture.background", version: "1" }, implementationId: "local" }, input: {},
    prepare: () => prepared, preview: { implementationId: "local", read: () => prepared }, ...overrides };
}

test("class codec保留prototype和this，撤权后旧codec及所有背景入口不再调用回调", async t => {
  const f = await fixture(t);
  class Codec implements BackgroundCodec {
    calls = 0;
    get id() { return "fixture"; }
    get customType() { return "fixture-history"; }
    snapshot(value: WorkingMessage) { this.calls++; return { owner: this.id, value }; }
  }
  const codec = new Codec();
  const calls = { enabled: 0, invoke: 0, prepare: 0, preview: 0 };
  const installed = new InstalledContributions([{ id: "fixture", enabled: true, backgrounds: [background({ codec,
    enabled() { calls.enabled++; return true; },
    prepare() { calls.prepare++; return prepared; },
    preview: { implementationId: "local", read(content) { assert.equal(content, f.content); calls.preview++; return prepared; } },
  })] }]);
  const source = installed.backgrounds(configuration, { content: f.content, async invoke() { calls.invoke++; return {}; } })[0];
  assert(source && source.preview);
  assert.equal(source.codec.id, "fixture");
  assert.equal(source.codec.customType, "fixture-history");
  assert.deepEqual(source.codec.snapshot(message), { owner: "fixture", value: message });
  assert.equal(codec.calls, 1);
  assert.equal(source.enabled(f.prompts), true);
  assert.deepEqual(await source.prepare(), prepared);
  assert.deepEqual(await source.preview(), prepared);
  const before = { ...calls };
  installed.invalidate();
  assert.throws(() => source.codec.snapshot(message), fault);
  assert.throws(() => source.enabled(f.prompts), fault);
  assert.throws(() => source.prepare(), fault);
  assert.throws(() => source.preview?.(), fault);
  assert.throws(() => installed.backgrounds(configuration, { content: f.content }), fault);
  assert.equal(codec.calls, 1);
  assert.deepEqual(calls, before);
  await installed.settled();
});

test("已进入的async prepare与preview撤权后拒绝结果，settled等待两项屏障收尾", async t => {
  const f = await fixture(t);
  const prepareEntered = barrier(), previewEntered = barrier();
  const prepareGate = barrier(), previewGate = barrier();
  const installed = new InstalledContributions([{ id: "fixture", enabled: true, backgrounds: [background({
    async prepare() { prepareEntered.release(); await prepareGate.wait; return prepared; },
    preview: { implementationId: "local", async read(content) {
      assert.equal((await content.get(content.target("preview.txt"))).status, "available");
      previewEntered.release(); await previewGate.wait; return prepared;
    } },
  })] }]);
  const source = installed.backgrounds(configuration, { content: f.content, async invoke() { return {}; } })[0];
  assert(source?.preview);
  const preparing = source.prepare(), previewing = source.preview();
  const prepareRejected = assert.rejects(preparing, fault), previewRejected = assert.rejects(previewing, fault);
  await Promise.all([prepareEntered.wait, previewEntered.wait]);
  installed.invalidate();
  let done = false;
  const settled = installed.settled().then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  prepareGate.release();
  await prepareRejected;
  assert.equal(done, false, "preview尚未release，不能提前完成收尾");
  previewGate.release();
  await previewRejected;
  await settled;
  assert.equal(done, true);
});

test("整个use流程纳入收尾，普通失败保留原错误且不留下悬空拒绝", async t => {
  const f = await fixture(t);
  const outerEntered = barrier(), outerGate = barrier();
  const installed = new InstalledContributions([{ id: "fixture", enabled: true, backgrounds: [background()] }]);
  const source = installed.backgrounds(configuration, { content: f.content })[0];
  assert(source?.preview);
  const preview = source.preview;
  const outer = installed.use(async () => {
    const result = await preview();
    outerEntered.release(); await outerGate.wait; return result;
  });
  const rejected = assert.rejects(outer, fault);
  await outerEntered.wait;
  installed.invalidate();
  let done = false;
  const settled = installed.settled().then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false, "inner preview已完成，仍需等待外层use");
  outerGate.release();
  await rejected; await settled;
  const active = new InstalledContributions([]);
  const failure = new Error("原普通失败");
  await assert.rejects(active.use(async () => { throw failure; }), error => error === failure);
  await active.settled();
  // Node测试运行器会把无owner的unhandledRejection列为失败；跨一个事件循环确认清理链已完成。
  await new Promise<void>(resolve => setImmediate(resolve));
});

test("invoke屏障期间撤权，release后不能再进入旧prepare回调", async t => {
  const f = await fixture(t);
  const entered = barrier(), gate = barrier();
  let calls = 0;
  const installed = new InstalledContributions([{ id: "fixture", enabled: true, backgrounds: [background({
    prepare() { calls++; return prepared; },
  })] }]);
  const source = installed.backgrounds(configuration, { content: f.content, async invoke() {
    entered.release(); await gate.wait; return {};
  } })[0];
  assert(source);
  const pending = source.prepare();
  const rejected = assert.rejects(pending, fault);
  await entered.wait;
  installed.invalidate();
  gate.release();
  await rejected; await installed.settled();
  assert.equal(calls, 0);
});
