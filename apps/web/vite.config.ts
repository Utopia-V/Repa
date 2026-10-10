import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

import { startRepaProcess, type RepaProcess } from "@repa/base/process";

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

export default defineConfig({
  plugins: [repaDevelopmentBackend(), react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    host: "127.0.0.1",
  },
});
