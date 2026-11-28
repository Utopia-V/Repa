#!/usr/bin/env node
// repa [--kb 目录] [--no-window]：后端没在运行就在后台启动它，然后用 Edge 的应用模式打开窗口。
// repa --install-icon：在应用菜单和桌面放一个调用这个命令的图标。
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const PORT = 7723;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const { values } = parseArgs({ options: { kb: { type: "string" }, "no-window": { type: "boolean" }, "install-icon": { type: "boolean" } } });
const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

if (values["install-icon"]) {
  const icon = fileURLToPath(new URL("../../../apps/web/public/icon.svg", import.meta.url));
  const entry = ["[Desktop Entry]", "Type=Application", "Name=Repa", `Exec=${process.execPath} ${fileURLToPath(import.meta.url)}`, `Icon=${icon}`, "Terminal=false", ""].join("\n");
  const desktop = execFileSync("xdg-user-dir", ["DESKTOP"], { encoding: "utf8" }).trim();
  for (const dir of [path.join(os.homedir(), ".local/share/applications"), desktop]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "repa.desktop"), entry);
    chmodSync(path.join(dir, "repa.desktop"), 0o755);
  }
  // GNOME 的桌面只启动标为可信的图标；别的桌面没有 gio 时忽略。
  try { execFileSync("gio", ["set", path.join(desktop, "repa.desktop"), "metadata::trusted", "true"]); } catch { /* 没有 gio */ }
  console.log("已安装图标。");
  process.exit(0);
}

async function running() {
  try {
    return (await fetch(`${URL_BASE}/api/health`)).ok;
  } catch {
    return false;
  }
}

if (!(await running())) {
  const root = path.resolve(values.kb ?? path.join(os.homedir(), "Repa"));
  mkdirSync(path.join(root, ".repa"), { recursive: true });
  const log = openSync(path.join(root, ".repa", "server.log"), "a");
  const child = spawn(process.execPath, ["--import", "tsx", path.join(packageDir, "src/main.ts"), "--kb", root, "--port", String(PORT)], {
    cwd: packageDir, detached: true, stdio: ["ignore", log, log],
  });
  child.unref();
  for (let tries = 0; !(await running()); tries += 1) {
    if (tries > 100) throw new Error(`后端没有启动起来，见 ${path.join(root, ".repa", "server.log")}。`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
if (!values["no-window"]) spawn("microsoft-edge", [`--app=${URL_BASE}/`], { detached: true, stdio: "ignore" }).unref();
