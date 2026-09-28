import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";

import { ensureDesktopRepaProcess } from "./repa-process";

function isTrustedRenderer(url: string): boolean {
  try {
    if (process.env.ELECTRON_RENDERER_URL) {
      return (
        new URL(url).origin ===
        new URL(process.env.ELECTRON_RENDERER_URL).origin
      );
    }
    return new URL(url).href === pathToFileURL(
      join(__dirname, "../renderer/index.html"),
    ).href;
  } catch {
    return false;
  }
}

ipcMain.handle("repa:get-connection", async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (
    !owner ||
    event.senderFrame !== owner.webContents.mainFrame ||
    !isTrustedRenderer(event.senderFrame.url)
  ) {
    throw new Error("拒绝非主页面读取 Repa 连接。");
  }
  try {
    return await ensureDesktopRepaProcess({
      connectionFile: join(app.getPath("userData"), "runtime", "connection.json"),
      nodeExecutable: process.env.REPA_NODE_EXECUTABLE ?? process.execPath,
      ...(process.env.REPA_NODE_EXECUTABLE
        ? {}
        : {
            nodeEnvironment: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: "1",
            },
          }),
    });
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : "Repa 后端启动失败。",
    );
  }
});

function createWindow() {
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  void app.whenReady().then(() => {
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
