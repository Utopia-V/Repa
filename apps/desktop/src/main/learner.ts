import { fileURLToPath } from "node:url";
import type { RepaProcessOptions } from "@repa/base/process";

/**
 * 桌面端是学习者版本：后端加载学习插件，关掉通用 Agent，首页和入口由界面按 plugin.list 决定。
 * 学习插件的构建目录是 @repa/learning 的包根（有 repa-plugin.json）：开发时是工作区的 packages/learning，
 * 安装包里是 node_modules 下的同名包。包只导出 dist 里的入口，入口所在目录的上一级就是包根。
 */
export function learnerBackend(): Pick<RepaProcessOptions, "plugins" | "generalAgent"> {
  return {
    plugins: [fileURLToPath(new URL("..", import.meta.resolve("@repa/learning")))],
    generalAgent: false,
  };
}
