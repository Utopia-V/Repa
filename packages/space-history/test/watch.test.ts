import assert from "node:assert/strict";
import test from "node:test";

import type { SpaceHistory } from "../src/history.js";
import { watchHistory } from "../src/watch.js";

const snapshotResult = { revision: "revision", committed: true, skipped: [] };

// 只发不带路径的通知时，不应按路径快照。
async function unexpectedPaths(): Promise<never> {
  throw new Error("不带路径的通知不应按路径快照");
}

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
  const watcher = watchHistory({ snapshot, snapshotPaths: unexpectedPaths }, (callback) => {
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
    snapshotPaths: unexpectedPaths,
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
    snapshotPaths: unexpectedPaths,
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

test("带路径的通知合并为一次按路径快照，保存期间收到的路径进入下一批", async () => {
  const started = deferred();
  const release = deferred();
  const batches: string[][] = [];
  let notify: (path?: string) => void = () => {};
  const watcher = watchHistory({
    snapshot: async () => assert.fail("带路径的通知不应扫描整个空间"),
    snapshotPaths: async (paths) => {
      batches.push([...paths].sort());
      if (batches.length === 1) {
        started.resolve();
        await release.promise;
      }
      return snapshotResult;
    },
  }, (callback) => {
    notify = callback;
    return () => {};
  }, { onError: (error) => assert.fail(String(error)) });
  notify("notes/a.md");
  notify("b.md");
  notify("notes/a.md");
  const flushing = watcher.flush();
  await started.promise;
  notify("c.md");
  release.resolve();
  await flushing;
  await watcher.close();
  assert.deepEqual(batches, [["b.md", "notes/a.md"], ["c.md"]]);
});

test("同一批里有不带路径的通知时改为扫描整个空间", async () => {
  const sources: unknown[] = [];
  let notify: (path?: string) => void = () => {};
  const watcher = watchHistory({
    snapshot: async (source) => {
      sources.push(source);
      return snapshotResult;
    },
    snapshotPaths: async () => assert.fail("这一批应当扫描整个空间"),
  }, (callback) => {
    notify = callback;
    return () => {};
  }, { onError: (error) => assert.fail(String(error)) });
  notify("a.md");
  notify();
  notify("b.md");
  await watcher.close();
  assert.deepEqual(sources, [{ kind: "external" }]);
});
