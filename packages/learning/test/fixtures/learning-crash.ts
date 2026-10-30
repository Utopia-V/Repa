// 真实子进程夹具：只控制判分替身，在三个持久化边界等待父进程 SIGKILL。
import { LearningRecords } from "../../src/records.js";
import { advance, answer, clock, judged, setup } from "./learning-records.js";

process.on("message", () => {});
const [file, stage] = process.argv.slice(2);
if (!file) throw new Error("缺日志路径");
const records = await LearningRecords.open(file, clock);
await setup(records);
const input = answer(records);
await records.submit(input);
await records.grade(input.submissionId, async (submission) => {
  if (stage === "accepted") {
    process.send?.("accepted");
    await new Promise(() => {});
  }
  const result = judged(submission);
  if (stage === "returned") {
    // judge 已返回；持久层读取结构化结果时停住，尚未进入结果追加。同步阻塞主线程直到父进程 SIGKILL：
    // 消息已交给系统写出，不靠事件循环；Windows 没有 SIGSTOP，向自己发它只会抛错，进程照样往下走。
    Object.defineProperty(result, "source", { enumerable: true, get() {
      process.send?.("returned");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      return { key: "2" };
    } });
  }
  return result;
}, advance);
process.send?.("persisted");
await new Promise(() => {});
