import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

import { startRepaDevelopmentBackend } from "./repa-development-backend";

function repaDevelopmentBackend() {
  return {
    name: "repa-development-backend",
    apply: "serve" as const,
    configureServer(server: import("vite").ViteDevServer) {
      const connection = startRepaDevelopmentBackend();
      // Keep startup failures observable through the same endpoint instead of
      // terminating Vite before the renderer can present its retry state.
      void connection.catch(() => {});
      server.middlewares.use(
        "/__repa/connection",
        async (request, response) => {
          if (request.method !== "GET") {
            response.statusCode = 405;
            response.end();
            return;
          }
          try {
            const handle = await connection;
            response.setHeader("Content-Type", "application/json");
            response.setHeader("Cache-Control", "no-store");
            response.end(
              JSON.stringify({
                url: handle.url,
                token: handle.token,
              }),
            );
          } catch (error) {
            response.statusCode = 503;
            response.setHeader("Content-Type", "application/json");
            response.setHeader("Cache-Control", "no-store");
            response.end(
              JSON.stringify({
                error:
                  error instanceof Error ? error.message : "后端启动失败。",
              }),
            );
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
