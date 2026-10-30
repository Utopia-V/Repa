import os from "node:os";
import path from "node:path";

/** 应用配置目录的解析选项；测试和嵌入方可显式指定目录、平台与环境。 */
export interface AppHomeOptions {
  home?: string;
  platform?: NodeJS.Platform;
  userHome?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

/** 计算应用配置目录，不读写文件。 */
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
