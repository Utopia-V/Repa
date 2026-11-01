// @vitest-environment node
import { describe, expect, it } from "vitest";

import { openInBrowser } from "../src/main/external-links";

function opened(url: string): string[] {
  const urls: string[] = [];
  expect(openInBrowser(url, async (target) => { urls.push(target); })).toEqual({ action: "deny" });
  return urls;
}

describe("新窗口链接", () => {
  it("网页地址交给系统浏览器，应用不开新窗口", () => {
    expect(opened("https://auth.openai.com/oauth/authorize?client_id=x")).toEqual(["https://auth.openai.com/oauth/authorize?client_id=x"]);
    expect(opened("http://localhost:1455/auth/callback")).toEqual(["http://localhost:1455/auth/callback"]);
  });

  it("其他协议和解析不了的地址不打开", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "repa://app/learn", "smb://host/share", "not a url"]) {
      expect(opened(url)).toEqual([]);
    }
  });
});
