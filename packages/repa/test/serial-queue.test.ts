import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SerialQueue } from "../src/storage/atomic.js";

async function bounded<T>(promise: Promise<T>): Promise<T> {
  const deadline = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(5000, undefined, { signal: deadline.signal }).then(() => assert.fail("队列取消没有解除等待")),
    ]);
  } finally { deadline.abort(); }
}

test("等待中的取消立即结束调用者，但不越过前项且取消槽不会执行", async () => {
  const queue = new SerialQueue();
  let release = () => {};
  let entered = () => {};
  const started = new Promise<void>(resolve => { entered = resolve; });
  const firstReady = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  const first = queue.run(async () => { events.push("first-start"); entered(); await firstReady; events.push("first-end"); });
  await started;
  const controller = new AbortController();
  const reason = new Error("等待者取消");
  const cancelled = assert.rejects(queue.run(async () => { events.push("cancelled-work"); }, controller.signal), error => error === reason);
  const third = queue.run(async () => { events.push("third"); return "结果"; });
  let settled = false;
  const drained = queue.settled().then(() => { settled = true; });
  try {
    controller.abort(reason);
    await bounded(cancelled);
    assert.deepEqual(events, ["first-start"]);
    assert.equal(settled, false);
  } finally { release(); }
  await first;
  assert.equal(await third, "结果");
  await drained;
  assert.deepEqual(events, ["first-start", "first-end", "third"]);
  const preCancelled = new AbortController();
  preCancelled.abort(reason);
  await assert.rejects(queue.run(async () => { events.push("pre-cancelled-work"); }, preCancelled.signal), error => error === reason);
  await queue.settled();
  assert.deepEqual(events, ["first-start", "first-end", "third"]);
});

test("开始执行后取消不提前冒充工作完成，真实失败收尾后队列继续", async () => {
  const queue = new SerialQueue();
  const controller = new AbortController();
  let entered = () => {};
  let release = () => {};
  const started = new Promise<void>(resolve => { entered = resolve; });
  const ready = new Promise<void>(resolve => { release = resolve; });
  const failure = new Error("工作自身失败");
  let finished = false;
  const running = queue.run(async () => {
    entered();
    await ready;
    finished = true;
    throw failure;
  }, controller.signal);
  const rejected = assert.rejects(running, error => error === failure);
  let nextStarted = false;
  const next = queue.run(async () => { assert(finished); nextStarted = true; return 7; });
  await started;
  controller.abort(new Error("执行中取消由工作本身处理"));
  assert.equal(finished, false);
  assert.equal(nextStarted, false);
  release();
  await bounded(rejected);
  assert.equal(await next, 7);
  await queue.settled();
});
