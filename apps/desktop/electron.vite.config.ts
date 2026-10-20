import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";

import { PYODIDE_PATH, PYTHON_WORKER_CSP, pythonAssets, workspacePythonDirectories } from "./src/main/python-runtime";

const PYTHON_WORKER_PATH = "/src/lib/python/worker.ts";

/** 开发时 renderer 由开发服务器提供，这里做主进程 repa 协议在生产时做的事：提供 Pyodide 文件，给 Python Worker 加 CSP 响应头。 */
function repaPythonRuntime() {
  return {
    name: "repa-python-runtime",
    apply: "serve" as const,
    async configureServer(server: ViteDevServer) {
      const lookup = await pythonAssets(await workspacePythonDirectories());
      server.middlewares.use((request, response, next) => {
        if (new URL(request.url ?? "/", "http://localhost").pathname === PYTHON_WORKER_PATH) {
          response.setHeader("Content-Security-Policy", PYTHON_WORKER_CSP);
        }
        next();
      });
      server.middlewares.use(PYODIDE_PATH.slice(0, -1), (request, response) => {
        const asset = lookup(decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname.slice(1)));
        if (request.method !== "GET" || asset === undefined) {
          response.statusCode = 404;
          response.end();
          return;
        }
        const stream = createReadStream(asset.file);
        stream.once("open", () => {
          response.setHeader("Content-Type", asset.type);
          stream.pipe(response);
        });
        stream.once("error", () => {
          response.statusCode = 404;
          response.end();
        });
      });
    },
  };
}

export default defineConfig({
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
  renderer: {
    plugins: [repaPythonRuntime(), react(), tailwindcss()],
    resolve: { alias: { "@": fileURLToPath(new URL("./src/renderer/src", import.meta.url)) } },
    // 主进程的 repa 协议给这个目录里的脚本加 Worker 的 CSP，见 src/main/app-protocol.ts。
    worker: { rollupOptions: { output: { entryFileNames: "workers/[name]-[hash].js" } } },
  },
});
