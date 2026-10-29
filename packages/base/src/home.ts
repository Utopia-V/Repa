import { constants } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, rename, rm, rmdir } from "node:fs/promises";
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
  // 只移除空目标；复制期间目标保持不存在，启动方不会读到半份配置。
  if (await exists(target)) await rmdir(target);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(path.dirname(target), `.${path.basename(target)}-migration-`));
  try {
    // 临时目录与目标在同一文件系统，完整复制后一次改名发布；文件权限沿用源文件。
    for (const name of names.sort()) {
      await cp(path.join(source, name), path.join(temporary, name), {
        recursive: true,
        mode: constants.COPYFILE_EXCL,
        force: false,
        errorOnExist: true,
        verbatimSymlinks: true,
      });
    }
    // 新出现的非空目标会让改名失败，保留它和源配置，不覆盖已经存在的配置。
    await rename(temporary, target);
  } catch (error) {
    throw new RepaFault("home_migration_failed", `应用配置搬移失败，原配置保留在 ${source}；下次启动会重试。`, {
      source,
      target,
      reason: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
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
