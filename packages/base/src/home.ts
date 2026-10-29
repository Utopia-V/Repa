import { constants } from "node:fs";
import { cp, lstat, mkdir, readdir, rm, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RepaFault } from "./schema.js";

export interface AppHomeOptions {
  home?: string;
  platform?: NodeJS.Platform;
  userHome?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

/** 只计算目录；脚本查询默认位置时不会因此搬动配置。 */
export function resolveAppHome(options: AppHomeOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const env = options.env ?? process.env;
  const override = options.home ?? env.REPA_HOME;
  if (override !== undefined) return paths.resolve(override);
  const userHome = options.userHome ?? os.homedir();
  if (platform === "win32") {
    return paths.join(env.APPDATA || paths.join(userHome, "AppData", "Roaming"), "Repa");
  }
  if (platform === "darwin") return paths.join(userHome, "Library", "Application Support", "Repa");
  const configHome = env.XDG_CONFIG_HOME && paths.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : paths.join(userHome, ".config");
  return paths.join(configHome, "repa");
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** 源与目标由调用方传入，测试和嵌入方不必触碰个人配置。 */
export async function migrateAppHome(
  source: string,
  target: string,
  warn: (message: string) => void = message => process.stderr.write(`${message}\n`),
): Promise<void> {
  if (path.resolve(source) === path.resolve(target) || !await exists(source)) return;
  const intoTarget = path.relative(source, target);
  const intoSource = path.relative(target, source);
  const nested = (relative: string) => relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  if (nested(intoTarget) || nested(intoSource)) {
    throw new RepaFault("home_migration_failed", "新旧应用配置目录不能互相包含，请调整应用配置目录。", { source, target });
  }
  const entries = await readdir(source);
  const names = await exists(path.join(source, "format.json"))
    ? entries.filter(name => name === "settings.json" || name === "agent")
    : entries;
  if (names.length === 0) return;
  if (await exists(target) && (await readdir(target)).length > 0) {
    warn(`应用配置使用 ${target}；旧配置仍保留在 ${source}，请按需手动整理。`);
    return;
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  try {
    // 全部复制成功后才移除源；跨文件系统也保持原凭据权限，且不覆盖目标文件。
    for (const name of names) {
      await cp(path.join(source, name), path.join(target, name), {
        recursive: true,
        mode: constants.COPYFILE_EXCL,
        force: false,
        errorOnExist: true,
        verbatimSymlinks: true,
      });
    }
  } catch (error) {
    throw new RepaFault("home_migration_failed", `应用配置搬移失败，原配置保留在 ${source}；请检查 ${target} 后重试。`, {
      source,
      target,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  for (const name of names) await rm(path.join(source, name), { recursive: true });
  // 旧目录也可能容纳主目录空间的数据，只删除已经搬空的目录。
  if ((await readdir(source)).length === 0) await rmdir(source);
  warn(`应用配置已从 ${source} 搬到 ${target}。`);
}

export async function prepareAppHome(options: AppHomeOptions = {}): Promise<string> {
  const home = resolveAppHome(options);
  const env = options.env ?? process.env;
  if (options.home === undefined && env.REPA_HOME === undefined) {
    await migrateAppHome(path.join(options.userHome ?? os.homedir(), ".repa"), home);
  }
  return home;
}
