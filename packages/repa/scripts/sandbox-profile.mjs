import path from "node:path";
import { fileURLToPath } from "node:url";

// 只生成可审阅的配置；加载系统策略由安装者负责，不自动要求管理员权限。
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--helper" || !path.isAbsolute(args[1]))) {
  console.error("用法：node scripts/sandbox-profile.mjs [--helper /absolute/path/codex-linux-sandbox]");
  process.exitCode = 1;
} else {
  const helper = args[1] ?? fileURLToPath(new URL("../resources/sandbox/linux-x64/codex-linux-sandbox", import.meta.url));
  // AppArmor 的附件路径使用双引号；绝对路径仍可能含需转义的引号与反斜线。
  const quoted = JSON.stringify(helper);
  process.stdout.write(`abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile repa-linux-sandbox ${quoted} flags=(unconfined) {\n  userns,\n}\n`);
}
