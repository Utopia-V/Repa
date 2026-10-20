import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startRepaProcess, type RepaProcess } from "@repa/base/process";
import { defaultPackagesDirectory } from "@repa/learning";

function repaDevelopmentBackend() {
  let backend: Promise<RepaProcess> | undefined;
  let closing = false;
  const getBackend = (): Promise<RepaProcess> => {
    if (closing) return Promise.reject(new Error("Web 开发服务器正在关闭。"));
    backend ??= startRepaProcess().then((handle) => {
      void handle.closed.then(() => { backend = undefined; }, (error: unknown) => {
        backend = undefined;
        console.error(error);
      });
      return handle;
    }, (error: unknown) => {
      backend = undefined;
      throw error;
    });
    return backend;
  };
  return {
    name: "repa-development-backend",
    apply: "serve" as const,
    async closeBundle() {
      closing = true;
      if (backend) await backend.then((handle) => handle.close(), () => {});
    },
    configureServer(server: import("vite").ViteDevServer) {
      server.middlewares.use(
        "/__repa/connection",
        async (request, response) => {
          if (request.method !== "GET") {
            response.statusCode = 405;
            response.end();
            return;
          }
          try {
            const { connection } = await getBackend();
            response.setHeader("Content-Type", "application/json");
            response.setHeader("Cache-Control", "no-store");
            response.end(JSON.stringify(connection));
          } catch (error) {
            response.statusCode = 503;
            response.setHeader("Content-Type", "application/json");
            response.setHeader("Cache-Control", "no-store");
            response.end(JSON.stringify({
              error: error instanceof Error ? error.message : "后端启动失败。",
            }));
          }
        },
      );
    },
  };
}

/** 运行学习者代码的 Worker 的 CSP。Worker 不继承页面 meta 里的 CSP，只能由响应头给；为什么这样限制见 worker.ts。 */
const PYTHON_WORKER_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'";
const PYTHON_WORKER_PATH = "/src/lib/python/worker.ts";
const PYODIDE_FILES = new Map([
  ["pyodide.mjs", "text/javascript; charset=utf-8"],
  ["pyodide.asm.mjs", "text/javascript; charset=utf-8"],
  ["pyodide.asm.wasm", "application/wasm"],
  ["python_stdlib.zip", "application/zip"],
  ["pyodide-lock.json", "application/json"],
]);

/** 开发服务器在 /__repa/pyodide/ 提供 Pyodide 文件和 wheel，并给 Python Worker 加 CSP 响应头。 */
function repaPythonRuntime() {
  return {
    name: "repa-python-runtime",
    apply: "serve" as const,
    async configureServer(server: import("vite").ViteDevServer) {
      const pyodideDirectory = path.dirname(createRequire(import.meta.url).resolve("pyodide/package.json"));
      const { version } = JSON.parse(await readFile(path.join(pyodideDirectory, "package.json"), "utf8")) as { version: string };
      const lock = JSON.parse(await readFile(path.join(pyodideDirectory, "pyodide-lock.json"), "utf8")) as {
        packages: Record<string, { file_name: string }>;
      };
      const wheels = new Set(Object.values(lock.packages).map((entry) => entry.file_name));
      // wheel 由 npm run course:runtime 准备，与课程核对用同一个目录。
      const packagesDirectory = defaultPackagesDirectory(version);

      server.middlewares.use((request, response, next) => {
        if (new URL(request.url ?? "/", "http://localhost").pathname === PYTHON_WORKER_PATH) {
          response.setHeader("Content-Security-Policy", PYTHON_WORKER_CSP);
        }
        next();
      });
      server.middlewares.use("/__repa/pyodide", (request, response) => {
        const name = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname.slice(1));
        const wheel = name.startsWith("packages/") ? name.slice("packages/".length) : undefined;
        const type = wheel === undefined ? PYODIDE_FILES.get(name) : wheels.has(wheel) ? "application/zip" : undefined;
        if (request.method !== "GET" || type === undefined) {
          response.statusCode = 404;
          response.end();
          return;
        }
        const stream = createReadStream(wheel === undefined ? path.join(pyodideDirectory, name) : path.join(packagesDirectory, wheel));
        stream.once("open", () => {
          response.setHeader("Content-Type", type);
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
  plugins: [repaDevelopmentBackend(), repaPythonRuntime(), react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    host: "127.0.0.1",
  },
});
