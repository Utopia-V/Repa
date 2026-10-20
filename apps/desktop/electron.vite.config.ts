import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

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
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": fileURLToPath(new URL("./src/renderer/src", import.meta.url)) } },
    build: {
      // 页面 CSP 没有放行 data: 字体（font-src 回落到 default-src 'self'），字体文件不内联。
      assetsInlineLimit: (file) => (/\.(woff2?|ttf)$/.test(file) ? false : undefined),
    },
  },
});
