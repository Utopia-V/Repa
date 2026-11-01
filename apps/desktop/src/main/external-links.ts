/**
 * 页面里 target="_blank" 的链接（模型账号登录、课程正文和辅导回复里的网址）交给系统浏览器打开；
 * 应用自己不开新窗口，其他协议的地址一律不打开。
 */
export function openInBrowser(url: string, openExternal: (url: string) => Promise<void>): { action: "deny" } {
  if (isWebUrl(url)) {
    openExternal(url).catch((error: unknown) => console.error(error));
  }
  return { action: "deny" };
}

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    // 解析不了的地址不是网页链接，不打开。
    return false;
  }
}
