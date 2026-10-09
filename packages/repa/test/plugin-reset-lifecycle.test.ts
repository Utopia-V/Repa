import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { Type } from "typebox";
import { InstalledContributions } from "../src/agent/contributions.js";
import { RepaApplication } from "../src/application.js";
import { RepaFault } from "../src/errors.js";

function gate() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("应用插件刷新遇到一个打开失败时仍等待另一个打开结束，再统一失效旧安装", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-plugin-reset-lifecycle-"));
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [], extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"],
  }));
  const firstEntered = gate(), secondEntered = gate(), rejectFirst = gate(), finishSecond = gate();
  const failure = new RepaFault("fixture_open_failed", "受控后台打开失败。");
  let factoryCalls = 0;
  let formatCalls = 0;
  const app = new RepaApplication({
    agentDir, appDirectory: path.join(root, "app"),
    plugins: [{
      id: "fixture-reset", enabled: true,
      async factory() {
        factoryCalls++;
        if (factoryCalls === 1) {
          firstEntered.release();
          await rejectFirst.promise;
          throw failure;
        }
        assert.equal(factoryCalls, 2);
        secondEntered.release();
        await finishSecond.promise;
        return { capabilities: [] };
      },
      formats: [{
        id: "fixture-reset", field: "fixtureReset", schema: Type.Null(), default: null,
        references() { formatCalls++; return []; },
        files() { formatCalls++; return []; },
        remapMetadata(value) { formatCalls++; return value; },
        remapFile(bytes) { formatCalls++; return bytes; },
      }],
    }],
  });
  t.after(async () => {
    rejectFirst.release();
    finishSecond.release();
    app.shutdown("cancel");
    await app.closed;
    await rm(root, { recursive: true, force: true });
  });
  const spaces = await Promise.all(["first", "second"].map(name => app.openSpace(path.join(root, name))));
  const first = spaces[0], second = spaces[1];
  assert(first && second);
  for (const space of spaces) {
    await app.contentCall("content.write", {
      target: { kind: "file", spaceId: space.id, location: { kind: "relative", path: "saved.txt" } },
      base: { kind: "absent" }, value: { kind: "text", text: "原有内容\r\n" }, operationId: randomUUID(),
    });
  }
  const firstOpening = app.describeCapabilities({ kind: "space", spaceId: first.id });
  const firstRejected = assert.rejects(firstOpening, error => error === failure);
  await firstEntered.promise;
  const secondOpening = app.describeCapabilities({ kind: "space", spaceId: second.id });
  await secondEntered.promise;

  const resetStarted = gate();
  const invalidate = InstalledContributions.prototype.invalidate;
  const invalidation = t.mock.method(InstalledContributions.prototype, "invalidate", function(this: InstalledContributions) {
    invalidate.call(this);
    resetStarted.release();
  });
  let refreshFinished = false;
  const refresh = app.settingsCall("settings.set", {
    scope: { kind: "application" }, namespace: "plugins", key: "disabled", value: ["fixture-reset"], base: "unset",
  });
  const refreshRejected = assert.rejects(refresh, error => error === failure);
  void refresh.then(() => { refreshFinished = true; }, () => { refreshFinished = true; });
  // 真实 ConfigStore.set 返回后才失效声明；refresh 从此处到 reset 固定 opening 集合之间没有 await。
  // 同步 spy 只透传原行为并发信号，测试恢复时 reset 已取得两个 pending，不以磁盘可见代替返回。
  await resetStarted.promise;
  invalidation.mock.restore();
  rejectFirst.release();
  await firstRejected;
  // 让失败后的 promise 收尾完整传播；第二个打开仍由显式屏障阻塞。
  await setImmediate();
  assert.equal(refreshFinished, false, "一个打开失败不应使刷新跳过其他 pending 打开。");
  await assert.rejects(app.describeCapabilities({ kind: "space", spaceId: second.id }),
    error => error instanceof RepaFault && error.code === "plugin_reconfiguring");

  finishSecond.release();
  await secondOpening;
  await refreshRejected;
  assert.equal(refreshFinished, true);
  const callsAfterRefresh = formatCalls;
  for (const space of spaces) {
    await assert.rejects(app.describeCapabilities({ kind: "space", spaceId: space.id }),
      error => error instanceof RepaFault && error.code === "plugin_restart_required");
    await assert.rejects(app.contentCall("content.write", {
      target: { kind: "file", spaceId: space.id, location: { kind: "relative", path: "rejected.txt" } },
      base: { kind: "absent" }, value: { kind: "text", text: "不应写入" }, operationId: randomUUID(),
    }), error => error instanceof RepaFault && error.code === "plugin_restart_required");
    const read = await app.contentCall("content.read", {
      target: { kind: "file", spaceId: space.id, location: { kind: "relative", path: "saved.txt" } },
    });
    assert(read && typeof read === "object" && "text" in read);
    assert.equal(read.text, "原有内容\r\n");
  }
  assert.equal(formatCalls, callsAfterRefresh);
  assert.equal(factoryCalls, 2);
});
