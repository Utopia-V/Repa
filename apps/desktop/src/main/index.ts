import { stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { app, BrowserWindow, ipcMain, protocol, shell, type IpcMainInvokeEvent } from "electron";

import { startRepaProcess, type RepaProcess } from "@repa/base/process";
import { APP_PAGE_URL, APP_SCHEME, createAppHandler, isAppUrl } from "./app-protocol";
import { learnerBackend } from "./learner";
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
    ...learnerBackend(),
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
    return isAppUrl(url);
  } catch {
    return false;
  }
}

/** 请求是否来自应用窗口的主页面，而不是页面里嵌入的其他内容。 */
function fromMainPage(event: IpcMainInvokeEvent): boolean {
  const owner = BrowserWindow.fromWebContents(event.sender);
  return owner !== null && event.senderFrame === owner.webContents.mainFrame && isTrustedRenderer(event.senderFrame.url);
}

ipcMain.handle("repa:get-connection", async (event) => {
  if (!fromMainPage(event)) throw new Error("拒绝非主页面读取 Repa 连接。");
  try {
    return (await getBackend()).connection;
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : "Repa 后端启动失败。",
    );
  }
});

// 只打开反馈包，与 Web 开发服务器的同名端点一致：页面不能借它在文件管理器里打开任意路径。
const FEEDBACK_FILE = /^repa-feedback-[\d-]+\.zip$/u;

ipcMain.handle("repa:reveal-file", async (event, file: unknown) => {
  if (!fromMainPage(event)) throw new Error("拒绝非主页面打开文件夹。");
  if (typeof file !== "string" || !isAbsolute(file) || !FEEDBACK_FILE.test(basename(file))) {
    throw new Error("只能打开反馈包所在的文件夹。");
  }
  // 文件不在（例如已被用户移走）是预期情况，页面据此提示用户手动打开。
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) throw new Error("找不到这个文件，可能已经被移动或删除。");
  shell.showItemInFolder(file);
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
