// @vitest-environment node
import { describe, expect, it } from "vitest";

import config from "../vite.config";

// 页面 CSP 不放行 data: 字体；构建把字体内联成 data: 时，界面只会悄悄换成回退字体。
describe("构建不内联字体文件", () => {
  it.each(["production", "desktop"])("%s 模式下字体文件不内联，其他资源按默认规则", (mode) => {
    const limit = config({ command: "build", mode }).build?.assetsInlineLimit;
    if (typeof limit !== "function") throw new Error("assetsInlineLimit 应当是按文件判断的函数");
    const small = Buffer.alloc(100);
    for (const file of ["/a/manrope-latin-wght-normal.woff2", "/a/KaTeX_Size3-Regular.woff", "/a/KaTeX_Size3-Regular.ttf"]) {
      expect(limit(file, small)).toBe(false);
    }
    expect(limit("/a/icon.png", small)).toBeUndefined();
  });
});
