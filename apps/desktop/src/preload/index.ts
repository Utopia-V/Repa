import { contextBridge, ipcRenderer } from "electron";

// 形状与 apps/web 的 RepaHost 一致；页面在 window.repaHost 存在时知道自己运行在桌面端。
contextBridge.exposeInMainWorld("repaHost", {
  getConnection: () => ipcRenderer.invoke("repa:get-connection"),
  revealFile: (path: string) => ipcRenderer.invoke("repa:reveal-file", path),
  onQuitting: (listener: () => void) => {
    const handler = () => { listener(); };
    ipcRenderer.on("repa:quitting", handler);
    return () => { ipcRenderer.removeListener("repa:quitting", handler); };
  },
  quitNow: () => ipcRenderer.invoke("repa:quit-now"),
});
