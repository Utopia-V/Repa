import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("repaHost", {
  getConnection: () => ipcRenderer.invoke("repa:get-connection"),
});
