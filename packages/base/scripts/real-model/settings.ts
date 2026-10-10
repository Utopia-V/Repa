import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import lockfile from "proper-lockfile";

// 只调整核实所需的运行选项；凭据仍由 Pi 在原来的 auth.json 中加锁维护。
export const PROBE_SETTINGS = {
  transport: "sse",
  defaultThinkingLevel: "off",
  modelThinkingLevels: {},
  cacheWarming: "idle",
  retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  compaction: { enabled: false, reserveTokens: 2048, keepRecentTokens: 128 },
};

export async function leaseSettings(agentDir: string, recoveryDir: string) {
  const file = path.join(agentDir, "settings.json");
  const release = await lockfile.lock(agentDir, {
    lockfilePath: path.join(agentDir, "real-model-check.lock"),
    realpath: false,
    retries: 0,
  });
  try {
    // 恢复材料只包含设置；凭据不复制。
    let originalExisted = true;
    let original: string;
    try {
      original = await readFile(file, "utf8");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      originalExisted = false;
      original = "{}\n";
      await writeFile(file, original, { flag: "wx", mode: 0o600 });
    }
    const parsed: unknown = JSON.parse(original);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_settings");
    const configured = `${JSON.stringify({ ...parsed, ...PROBE_SETTINGS }, null, 2)}\n`;
    const backup = path.join(recoveryDir, "settings.original.json");
    await writeFile(backup, original, { flag: "wx", mode: 0o600 });
    await writeFile(path.join(recoveryDir, "settings-recovery.json"), JSON.stringify({ originalExisted }), { flag: "wx", mode: 0o600 });
    const unlock = await lockfile.lock(file, { realpath: false, retries: 0 });
    try {
      if (await readFile(file, "utf8") !== original) throw new Error("settings_changed_during_setup");
      await writeFile(file, configured);
    } finally {
      await unlock();
    }
    let restored = false;
    return {
      backup,
      async restore() {
        if (restored) return;
        const unlock = await lockfile.lock(file, { realpath: false, retries: 0 });
        try {
          // 并发编辑发生时保留新内容与恢复副本，不用旧快照覆盖用户修改。
          if (await readFile(file, "utf8") !== configured) throw new Error("settings_changed_during_probe");
          if (originalExisted) await writeFile(file, original);
          else await rm(file);
          restored = true;
        } finally {
          await unlock();
          await release();
        }
      },
    };
  } catch (error) {
    await release();
    throw error;
  }
}
