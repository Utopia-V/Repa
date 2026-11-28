// Repa 自己的配置目录：模型的凭据（auth.json）、可选的 models.json 和模型目录的缓存都在这里。
// Repa 是独立的软件，不读 Pi 的 ~/.pi/agent；凭据也不放进知识库，知识库以后要同步。
import os from "node:os";
import path from "node:path";

/** 配置目录：环境变量 REPA_CONFIG 指定时用它（测试与开发试用），否则 $XDG_CONFIG_HOME/repa，缺省 ~/.config/repa。 */
export function configDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  if (env.REPA_CONFIG) return path.resolve(env.REPA_CONFIG);
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "repa");
}
