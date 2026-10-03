import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// 只生成可审阅的配置；加载系统策略由安装者负责，不自动要求管理员权限。
let values;
try {
  values = parseArgs({
    options: { helper: { type: "string" }, name: { type: "string" } },
  }).values;
} catch {
  values = undefined;
}
const helper = values?.helper ?? fileURLToPath(new URL("../resources/sandbox/linux-x64/codex-linux-sandbox", import.meta.url));
const name = values?.name ?? "repa-linux-sandbox";
if (!values || !path.isAbsolute(helper) || !/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error("用法：node scripts/sandbox-profile.mjs [--helper /absolute/path/codex-linux-sandbox] [--name profile-name]");
  process.exitCode = 1;
} else {
  // AppArmor 的附件路径使用双引号；绝对路径仍可能含需转义的引号与反斜线。
  const quoted = JSON.stringify(helper);
  process.stdout.write(`abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile ${name} ${quoted} flags=(unconfined) {\n  userns,\n}\n`);
}
