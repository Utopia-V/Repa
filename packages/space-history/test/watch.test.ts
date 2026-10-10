import assert from "node:assert/strict";
import test from "node:test";

import type { SpaceHistory } from "../src/history.js";
import { watchHistory } from "../src/watch.js";

const snapshotResult = { revision: "revision", committed: true, skipped: [] };

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(snapshot: Pick<SpaceHistory, "snapshot">["snapshot"]) {
  let notify = () => {};
  let stops = 0;
  const errors: unknown[] = [];
  const watcher = watchHistory({ snapshot }, (callback) => {
    notify = callback;
    return () => {
      stops += 1;
    };
  }, { onError: (error) => errors.push(error) });
  return { watcher, notify: () => notify(), errors, stops: () => stops };
}

test("注册时同步通知与连续事件合并为 external 快照", async () => {
  const sources: unknown[] = [];
  const watcher = watchHistory({
    snapshot: async (source) => {
      sources.push(source);
      return snapshotResult;
    },
  }, (notify) => {
    notify();
    notify();
    notify();
    return () => {};
  }, { onError: (error) => assert.fail(String(error)) });
  assert.deepEqual(sources, []);
  await watcher.flush();
  await watcher.close();
  assert.deepEqual(sources, [{ kind: "external" }]);
});

test("快照等待期间的新通知在同一次 flush 完成前保存", async () => {
  const started = deferred();
  const release = deferred();
  let calls = 0;
  const { watcher, notify } = fixture(async () => {
    calls += 1;
    if (calls === 1) {
      started.resolve();
      await release.promise;
    }
    return snapshotResult;
  });
  notify();
  const flushing = watcher.flush();
  await started.promise;
  notify();
  notify();
  release.resolve();
  await flushing;
  assert.equal(calls, 2);
  await watcher.close();
});

test("关闭停止订阅并保存已收到的事件，关闭后的事件不再保存", async () => {
  let calls = 0;
  const { watcher, notify, stops } = fixture(async () => {
    calls += 1;
    return snapshotResult;
  });
  notify();
  await watcher.close();
  notify();
  await watcher.flush();
  await watcher.close();
  assert.equal(stops(), 1);
  assert.equal(calls, 1);
});

test("关闭等待正在保存的快照与保存期间已收到的下一次变更", async () => {
  const started = deferred();
  const release = deferred();
  let calls = 0;
  let closed = false;
  const { watcher, notify, stops } = fixture(async () => {
    calls += 1;
    if (calls === 1) {
      started.resolve();
      await release.promise;
    }
    return snapshotResult;
  });
  notify();
  const flushing = watcher.flush();
  await started.promise;
  notify();
  const closing = watcher.close().then(() => {
    closed = true;
  });
  assert.equal(stops(), 1);
  assert.equal(closed, false);
  release.resolve();
  await Promise.all([flushing, closing]);
  assert.equal(calls, 2);
  assert.equal(closed, true);
});

test("默认等待一百毫秒后快照，连续通知重新计时", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const started = deferred();
  let calls = 0;
  const { watcher, notify } = fixture(async () => {
    calls += 1;
    started.resolve();
    return snapshotResult;
  });
  notify();
  t.mock.timers.tick(99);
  assert.equal(calls, 0);
  notify();
  t.mock.timers.tick(99);
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  await started.promise;
  await watcher.close();
  assert.equal(calls, 1);
});

test("后台快照失败交给 onError，后续通知仍能保存", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const failed = deferred();
  const failure = new Error("snapshot failed");
  let calls = 0;
  const errors: unknown[] = [];
  let notify = () => {};
  const watcher = watchHistory({
    snapshot: async () => {
      calls += 1;
      if (calls === 1) throw failure;
      return snapshotResult;
    },
  }, (callback) => {
    notify = callback;
    return () => {};
  }, {
    onError: (error) => {
      errors.push(error);
      failed.resolve();
    },
  });
  notify();
  t.mock.timers.tick(100);
  await failed.promise;
  notify();
  await watcher.flush();
  await watcher.close();
  assert.deepEqual(errors, [failure]);
  assert.equal(calls, 2);
});
