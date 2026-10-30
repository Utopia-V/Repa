// 真实子进程夹具：上一节课，交一道开放题，在三个持久化边界等待父进程 SIGKILL。
import { ModelTestDriver } from "@repa/base/testing";
import type { LearningState } from "../../src/protocol.js";
import { openSession } from "./learning-records.js";

process.on("message", () => {});
const [file, directory, stage] = process.argv.slice(2);
if (!file || !directory) throw new Error("缺日志路径或课程目录");
const models = new ModelTestDriver();
const { records, call } = await openSession(file, directory, models);
const state = async () => (await call("state.get", {})) as LearningState;
const menu = (await state()).menu;
const candidate = menu?.candidates[0];
if (!menu || !candidate) throw new Error("夹具缺菜单");
await call("menu.select", { menuId: menu.menuId, candidateId: candidate.id });
for (let step = 0; step < 2; step++) {
  const current = await state();
  if (!current.task) throw new Error("夹具缺任务");
  await call("task.advance", { taskId: current.task.taskId, expectedRevision: current.revision, expectedStage: current.task.phase.stage });
}
const task = (await state()).task;
const delivery = task?.deliveries[0];
if (!task || !delivery) throw new Error("夹具缺交付");
const plan = models.expectStructured();
if (stage === "returned") {
  // 模型已经返回、判分还没写进日志时停住：拦在写入判分的串行回调里。
  const write = records.write.bind(records);
  records.write = (build) => write(async () => {
    const bodies = await build();
    if (bodies.some((body) => body.type === "graded")) {
      process.send?.("returned");
      // 同步阻塞主线程直到父进程 SIGKILL：消息已交给系统写出，不靠事件循环；Windows 没有 SIGSTOP，向自己发它只会抛错，进程照样往下走。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    return bodies;
  });
}
const submitted = call("submission.submit", {
  taskId: task.taskId, deliveryId: delivery.deliveryId, submissionId: delivery.submissionId,
  response: { item: { id: delivery.item.id, version: delivery.item.version }, answers: { s1: { type: "text", text: "两个一合起来" } } },
});
await plan.requested;
if (stage === "accepted") {
  process.send?.("accepted");
  await new Promise(() => {});
}
plan.succeed({ verdict: "correct", reason: "说明了相加的含义" });
await submitted;
process.send?.("persisted");
await new Promise(() => {});
