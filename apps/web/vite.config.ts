import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// 后端在 7723 端口提供接口；开发时 vite 把 /api 转过去，构建出的 dist 由后端直接提供。
// 协议与链接的解析是后端写给界面复用的两份源码，按路径直接引用。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@repa/protocol": fileURLToPath(new URL("../../packages/repa/src/protocol.ts", import.meta.url)),
      "@repa/links": fileURLToPath(new URL("../../packages/repa/src/links.ts", import.meta.url)),
    },
  },
  server: { port: 5173, proxy: { "/api": { target: "http://127.0.0.1:7723", changeOrigin: true } } },
  test: { environment: "jsdom" },
});
