import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { mergeConfig } from "vite";
import { fileURLToPath } from "node:url";

import web from "../web/vite.config";

/**
 * 桌面端没有自己的界面，renderer 就是 apps/web：按 web 自己的 Vite 配置以 desktop 模式构建和开发，
 * 后端由主进程启动，web 的开发服务器不另起后端。开发时 Pyodide 文件与 Worker 的 CSP 也由 web 的开发服务器提供。
 */
export default defineConfig(({ command }) => ({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: mergeConfig(web({ command, mode: "desktop" }), {
    root: fileURLToPath(new URL("../web", import.meta.url)),
    build: {
      outDir: fileURLToPath(new URL("./out/renderer", import.meta.url)),
      emptyOutDir: true,
      rollupOptions: { input: fileURLToPath(new URL("../web/index.html", import.meta.url)) },
    },
    // 主进程的 repa 协议给这个目录里的脚本加 Worker 的 CSP，见 src/main/app-protocol.ts。
    worker: { rollupOptions: { output: { entryFileNames: "workers/[name]-[hash].js" } } },
  }),
}));
