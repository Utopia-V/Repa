import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";

import { startRepaProcess, type RepaProcess } from "@repa/base/process";

let backend: Promise<RepaProcess> | undefined;
let quitting = false;

function getBackend(): Promise<RepaProcess> {
  if (quitting) return Promise.reject(new Error("Desktop 正在关闭。"));
  backend ??= startRepaProcess({
    nodeExecutable: process.env.REPA_NODE_EXECUTABLE ?? process.execPath,
    environment: {
      ...process.env,
      ...(process.env.REPA_NODE_EXECUTABLE ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
    },
  }).then((handle) => {
    void handle.closed.then(() => { backend = undefined; }, (error: unknown) => {
      backend = undefined;
      console.error(error);
    });
    return handle;
  }, (error: unknown) => {
    backend = undefined;
    throw error;
  });
  return backend;
}

app.on("before-quit", (event) => {
  if (quitting || !backend) return;
  event.preventDefault();
  quitting = true;
  void backend.then((handle) => handle.close()).catch((error: unknown) => {
    console.error(error);
  }).finally(() => { app.quit(); });
});

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
    return (await getBackend()).connection;
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : "Repa 后端启动失败。",
    );
  }
});

/**
 * Electron 收到第一个 SIGTERM／SIGINT 时安排退出，同时恢复默认处理，紧接着的第二个信号会直接结束进程；
 * 两个信号挨得近时 before-quit 还没运行，后端没有收到关闭请求，就留了下来。npm exec 和 electron 启动器
 * 都会把收到的信号转给 Electron，两者同时被结束时，Electron 就会连着收到两次。
 * 改由 Node 处理这两个信号：正在关闭时再收到的信号不重复请求退出，关闭照常等后端收尾。
 * Electron 在主脚本加载之后才装自己的处理，在这之前注册的会被覆盖，所以等 ready 之后再注册；
 * scripts/verify-quit-signals.mjs 在真实 Electron 里检查这一点。
 */
function quitOnShutdownSignals() {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (!quitting) app.quit();
    });
  }
}

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
    quitOnShutdownSignals();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
