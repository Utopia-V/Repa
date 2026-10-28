import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startRepaProcess, type RepaProcess } from "@repa/base/process";
import { defaultPackagesDirectory } from "@repa/learning";

// 只打开反馈包：这个端点替页面调用系统的文件管理器，不接受任意路径。
const FEEDBACK_FILE = /^repa-feedback-[\d-]+\.zip$/u;

/** 在系统文件管理器里打开文件所在的文件夹并选中它。 */
function reveal(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | null) => { if (error) reject(error); else resolve(); };
    if (process.platform === "darwin") execFile("open", ["-R", file], done);
    // explorer.exe 打开成功也返回退出码 1，不能按退出码判断成败。
    else if (process.platform === "win32") execFile("explorer.exe", [`/select,${file}`], () => resolve());
    // Linux 的文件管理器没有统一的“选中文件”参数，打开所在文件夹。
    else execFile("xdg-open", [path.dirname(file)], done);
  });
}

// 收齐再解码：一个中文字符可能被切在两个 chunk 之间，逐块解码会把路径改坏。
async function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 30_000) throw new Error("请求太大。");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

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
      server.middlewares.use(
        "/__repa/reveal",
        async (request, response) => {
          // 其他网站也能向本机端口发请求，只接受本页面发来的。
          if (request.method !== "POST" || request.headers.origin !== `http://${request.headers.host}`) {
            response.statusCode = 403;
            response.end();
            return;
          }
          try {
            const body: unknown = JSON.parse(await readBody(request));
            const file = body !== null && typeof body === "object" && "path" in body && typeof body.path === "string" ? body.path : undefined;
            if (file === undefined || !path.isAbsolute(file) || !FEEDBACK_FILE.test(path.basename(file))) {
              response.statusCode = 400;
              response.end();
              return;
            }
            // 文件不在（例如已被用户移走）是预期情况，按 404 返回，页面提示用户手动打开。
            const info = await stat(file).catch(() => undefined);
            if (!info?.isFile()) {
              response.statusCode = 404;
              response.end();
              return;
            }
            await reveal(file);
            response.statusCode = 204;
            response.end();
          } catch (error) {
            response.statusCode = 500;
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ error: error instanceof Error ? error.message : "无法打开文件夹。" }));
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
