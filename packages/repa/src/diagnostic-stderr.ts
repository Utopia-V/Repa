import { fstat, ftruncate, write } from "node:fs";
import { promisify } from "node:util";
import { SerialQueue } from "./storage/atomic.js";

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const managed = process.env.REPA_MANAGED_STDERR === "1";
const statFd = promisify(fstat);
const truncateFd = promisify(ftruncate);
const writeFd = promisify(write);
const queue = new SerialQueue();

export function writeDiagnosticLine(line: string): void {
  void queue.run(async () => {
    const bytes = Buffer.from(line.endsWith("\n") ? line : `${line}\n`);
    if (managed) {
      // 宿主传入 O_APPEND 文件 fd；原地截断让独立后端和宿主继续使用同一文件。
      // 第三方也可能输出 stderr，不能用输送器内部累计字节代替实际文件大小。
      const current = await statFd(2);
      if (current.isFile() && current.size + bytes.length > MAX_LOG_BYTES) {
        await truncateFd(2, 0);
      }
    }
    let offset = 0;
    while (offset < bytes.length) {
      // 直接写 stderr fd，失败不会触发 process.stderr 的未处理 error 事件。
      const { bytesWritten } = await writeFd(2, bytes, offset, bytes.length - offset, null);
      if (bytesWritten === 0) return;
      offset += bytesWritten;
    }
  }).catch(() => {
    // 诊断是尽力输送，不影响业务响应，也不通过同一失败出口递归报告。
  });
}
