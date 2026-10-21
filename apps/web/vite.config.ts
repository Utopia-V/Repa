import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startRepaProcess, type RepaProcess } from "@repa/base/process";

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

async function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 10_000) throw new Error("请求太大。");
  }
  return body;
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

export default defineConfig({
  plugins: [repaDevelopmentBackend(), react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    host: "127.0.0.1",
  },
});
