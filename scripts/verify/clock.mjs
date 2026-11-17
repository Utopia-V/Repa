/**
 * 走查拨时钟用：后端进程启动时经 NODE_OPTIONS 的 --import 先加载这个文件，整个进程的时间往后拨
 * REPA_VERIFY_CLOCK_OFFSET_MS 毫秒。只有走查脚本拉起的后端带它，产品代码里没有对应的入口。
 *
 * 只改 Date：Date.now() 与不带参数的 new Date() 都加上偏移，其余（带参数的构造、Date.parse 等）原样。
 * 底座的 host.now() 与学习插件的时间都从 Date.now() 来，空间历史、备份与会话记录的时间也一并拨过去，
 * 与学习者真的隔天再打开时一致。performance.now() 和计时器不受影响。
 */
const offset = Number(process.env.REPA_VERIFY_CLOCK_OFFSET_MS ?? "0");
if (!Number.isFinite(offset)) throw new Error(`REPA_VERIFY_CLOCK_OFFSET_MS 不是数：${process.env.REPA_VERIFY_CLOCK_OFFSET_MS}`);
if (offset !== 0) {
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  RealDate.now = () => realNow() + offset;
  // 用 Proxy 而不是子类：别处以原来的 Date 造出的对象（例如文件的 mtime）仍是 instanceof Date。
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length === 0 ? [realNow() + offset] : args, newTarget);
    },
    apply() {
      return new RealDate(realNow() + offset).toString();
    },
  });
}
