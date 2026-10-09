import { startRepaServer } from "repa";

const [appDirectory, agentDir, controlKey] = process.argv.slice(2);
if (!appDirectory || !agentDir || !controlKey || !process.send) throw new Error("子后端缺少启动参数或IPC");
let previewGate;
let server;
let stopping = false;
function send(value) {
  return new Promise((resolve, reject) => {
    if (!process.connected) { resolve(); return; }
    process.send(value, error => error ? reject(error) : resolve());
  });
}
globalThis[Symbol.for(controlKey)] = {
  async waitPreview() {
    if (!previewGate) return;
    const gate = previewGate;
    await send({ type: "preview-entered" });
    await gate.promise;
  },
};
function release() { previewGate?.resolve(); previewGate = undefined; }
async function stop() {
  if (stopping) return;
  stopping = true;
  release();
  await server?.close("cancel");
  await send({ type: "stopped" });
  if (process.connected) process.disconnect();
}
process.on("message", async message => {
  try {
    if (message?.type === "block-preview") {
      let resolve;
      const promise = new Promise(value => { resolve = value; });
      previewGate = { promise, resolve };
      await send({ type: "preview-blocked" });
    } else if (message?.type === "release-preview") {
      release();
      await send({ type: "preview-released" });
    } else if (message?.type === "stop") await stop();
  } catch (error) {
    process.exitCode = 1;
    await send({ type: "error", message: error instanceof Error ? error.message : String(error) });
    await stop();
  }
});
process.on("disconnect", () => {
  void stop().catch(() => { process.exitCode = 1; });
});
try {
  server = await startRepaServer({ appDirectory, agentDir, trustExtensions: false, diagnostics: { level: "off" } });
  // 连接凭据仅走父子IPC，不写stdout、日志或文件。
  await send({ type: "ready", pid: process.pid, connection: server.connection });
} catch (error) {
  process.exitCode = 1;
  await send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  await stop();
}
