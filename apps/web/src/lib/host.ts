/** 桌面端 preload 在 window.repaHost 上提供的宿主能力；在浏览器里打开时没有。 */
export interface RepaHost {
  /** 主进程启动的后端连接；经 IPC 传来，使用前要核对形状。 */
  getConnection(): Promise<unknown>;
  revealFile(path: string): Promise<void>;
}

declare global {
  interface Window {
    repaHost?: RepaHost;
  }
}

export function repaHost(): RepaHost | undefined {
  return window.repaHost;
}

/**
 * 请宿主在系统文件管理器里选中文件，只接受反馈包。桌面端由主进程承担，开发时由 Vite 开发服务器承担；
 * 失败时抛错，调用方留着路径让用户自己打开。
 */
export async function revealFile(path: string): Promise<void> {
  const host = repaHost();
  if (host) {
    await host.revealFile(path);
    return;
  }
  const response = await fetch("/__repa/reveal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (response.status === 404) throw new Error("找不到这个文件，可能已经被移动或删除。");
  if (!response.ok) throw new Error("无法打开所在文件夹。");
}
