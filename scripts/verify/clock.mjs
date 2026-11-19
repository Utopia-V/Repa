/**
 * 走查拨时钟用：后端进程启动时经 NODE_OPTIONS 的 --import 先加载这个文件，整个进程的时间往后拨
 * REPA_VERIFY_CLOCK_FILE 里写的毫秒数。只有走查脚本拉起的后端带它，产品代码里没有对应的入口。
 *
 * 偏移从文件读，而不是在启动时定死：测验要在后端运行中、页面不刷新的情况下过截止时间，走查改写这个文件即可。
 * 读文件最多每 100 毫秒一次；写到一半读到的空内容不算，沿用上一次的偏移。
 *
 * 只改 Date：Date.now() 与不带参数的 new Date() 都加上偏移，其余（带参数的构造、Date.parse 等）原样。
 * 底座的 host.now() 与学习插件的时间都从 Date.now() 来，空间历史、备份与会话记录的时间也一并拨过去，
 * 与学习者真的隔天再打开时一致。performance.now() 和计时器不受影响。
 */
import { readFileSync } from "node:fs";

const file = process.env.REPA_VERIFY_CLOCK_FILE;
if (file) {
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  let offset = 0;
  let readAt = -Infinity;
  const current = () => {
    const now = realNow();
    if (now - readAt >= 100) {
      readAt = now;
      const text = readFileSync(file, "utf8").trim();
      const value = Number(text);
      if (text !== "" && Number.isFinite(value)) offset = value;
    }
    return now + offset;
  };
  current();
  RealDate.now = current;
  // 用 Proxy 而不是子类：别处以原来的 Date 造出的对象（例如文件的 mtime）仍是 instanceof Date。
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length === 0 ? [current()] : args, newTarget);
    },
    apply() {
      return new RealDate(current()).toString();
    },
  });
}
