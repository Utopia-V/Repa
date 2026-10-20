import { join } from "node:path";
import { app, BrowserWindow, ipcMain, protocol } from "electron";

import { startRepaProcess, type RepaProcess } from "@repa/base/process";
import { APP_PAGE_URL, APP_SCHEME, createAppHandler } from "./app-protocol";
import { pythonAssets, workspacePythonDirectories, type PythonAssetLookup, type PythonRuntimeDirectories } from "./python-runtime";

// standard 让页面有自己的源，相对地址和 CSP 的 'self' 才成立；secure 让 crypto.subtle 可用，页面要用它核对 wheel。
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

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
    return new URL(url).href === APP_PAGE_URL;
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

function pythonDirectories(): Promise<PythonRuntimeDirectories> {
  if (!app.isPackaged) return workspacePythonDirectories();
  // 安装包把 Pyodide 文件和 wheel 复制到应用目录，见 scripts/package-linux.mjs。
  const pyodide = join(app.getAppPath(), "pyodide");
  return Promise.resolve({ pyodide, packages: join(pyodide, "packages") });
}

let python: Promise<PythonAssetLookup> | undefined;

function getPythonAssets(): Promise<PythonAssetLookup> {
  python ??= pythonDirectories().then(pythonAssets).catch((error: unknown) => {
    // 请求随之失败，页面报告 Python 运行环境不可用；不缓存失败，补齐文件后再试一次就能用。
    python = undefined;
    console.error(error);
    throw error;
  });
  return python;
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
    void window.loadURL(APP_PAGE_URL);
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
    if (!process.env.ELECTRON_RENDERER_URL) {
      protocol.handle(APP_SCHEME, createAppHandler({ renderer: join(__dirname, "../renderer"), python: getPythonAssets }));
    }
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
