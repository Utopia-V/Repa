import { realpathSync } from "node:fs";

// 底层存储测试使用规范路径，与 Application.openSpace 的入口约定一致。
// macOS 的临时目录通常以 /var 暴露，但实际路径位于 /private/var；子进程继承这里的结果。
for (const name of ["TMPDIR", "TMP", "TEMP"] as const) {
  const directory = process.env[name];
  if (directory) process.env[name] = realpathSync(directory);
}
