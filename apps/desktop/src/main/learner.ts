import { fileURLToPath } from "node:url";
import type { RepaProcessOptions } from "@repa/base/process";

/** 随包插件的插件文件夹是各自的包根（有 repa-plugin.json）：包只导出 dist 里的入口，入口所在目录的上一级就是包根。 */
function packageRoot(name: string): string {
  return fileURLToPath(new URL("..", import.meta.resolve(name)));
}

/**
 * 桌面端是学习者版本：后端加载学习插件和课件转文字插件，关掉通用 Agent，首页和入口由界面按 plugin.list 决定。
 * 插件文件夹开发时是工作区的 packages/ 下的包，安装包里是 node_modules 下的同名包。
 */
export function learnerBackend(): Pick<RepaProcessOptions, "plugins" | "generalAgent"> {
  return {
    plugins: [packageRoot("@repa/learning"), packageRoot("@repa/materials")],
    generalAgent: false,
  };
}
