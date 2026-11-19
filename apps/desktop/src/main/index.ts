import { stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { app, BrowserWindow, ipcMain, protocol, shell, type IpcMainInvokeEvent } from "electron";

import { startRepaProcess, type RepaProcess } from "@repa/base/process";
import { APP_PAGE_URL, APP_SCHEME, createAppHandler, isAppUrl } from "./app-protocol";
import { openInBrowser } from "./external-links";
import { learnerBackend } from "./learner";
import { pythonAssets, workspacePythonDirectories, type PythonAssetLookup, type PythonRuntimeDirectories } from "./python-runtime";
import { createQuitHandler } from "./quit";

// standard 让页面有自己的源，相对地址和 CSP 的 'self' 才成立；secure 让 crypto.subtle 可用，页面要用它核对 wheel。
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let backend: Promise<RepaProcess> | undefined;

/**
 * 安装包带的 Git，见 scripts/bundled-git.mjs；开发时和 Linux 安装包用 PATH 里的 git。
 * 底座要绝对路径：Windows 上按名称启动程序会先在空间目录里找同名文件。
 */
function bundledGit(): { gitPath?: string } {
  if (!app.isPackaged) return {};
  if (process.platform === "darwin") return { gitPath: join(app.getAppPath(), "git", "git") };
  if (process.platform === "win32") return { gitPath: join(app.getAppPath(), "git", "git.exe") };
  return {};
}
const quitting = createQuitHandler({
  backend: () => backend,
  quit: () => { app.quit(); },
  report: (error) => { console.error(error); },
  // 页面据此不再显示断线、不再重连，收尾慢时显示说明和立即退出的按钮。
  closing: () => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("repa:quitting");
  },
});

/** 安装包把 Pyodide 文件和 wheel 复制到应用目录的 pyodide/，见 scripts/package-application.mjs。 */
function packagedPython(): PythonRuntimeDirectories {
  const pyodide = join(app.getAppPath(), "pyodide");
  return { pyodide, packages: join(pyodide, "packages") };
}

function getBackend(): Promise<RepaProcess> {
  if (quitting.quitting()) return Promise.reject(new Error("Desktop 正在关闭。"));
  backend ??= startRepaProcess({
    ...learnerBackend(),
    ...bundledGit(),
    nodeExecutable: process.env.REPA_NODE_EXECUTABLE ?? process.execPath,
    environment: {
      ...process.env,
      ...(process.env.REPA_NODE_EXECUTABLE ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
      // 课程核对的 Linux 沙箱从 Node 一侧读 wheel；安装包里没有 @repa/python-runner 的 .cache，要指到页面用的同一份。
      ...(app.isPackaged ? { REPA_PYODIDE_PACKAGES: packagedPython().packages } : {}),
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

app.on("before-quit", quitting.beforeQuit);

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

// 收尾慢时页面上的“立即退出”：与收尾期间再退出一次相同，结束后端进程。
ipcMain.handle("repa:quit-now", (event) => {
  if (!fromMainPage(event)) throw new Error("拒绝非主页面退出应用。");
  app.quit();
});

// 只打开反馈包和插件导出的数据包，与 Web 开发服务器的同名端点一致：页面不能借它在文件管理器里打开任意路径。
const REVEALABLE_FILE = /^repa-(?:feedback|[a-z0-9][a-z0-9-]*-export)-[\d-]+\.zip$/u;

ipcMain.handle("repa:reveal-file", async (event, file: unknown) => {
  if (!fromMainPage(event)) throw new Error("拒绝非主页面打开文件夹。");
  if (typeof file !== "string" || !isAbsolute(file) || !REVEALABLE_FILE.test(basename(file))) {
    throw new Error("只能打开反馈包或导出的数据包所在的文件夹。");
  }
  // 文件不在（例如已被用户移走）是预期情况，页面据此提示用户手动打开。
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) throw new Error("找不到这个文件，可能已经被移动或删除。");
  shell.showItemInFolder(file);
});

function pythonDirectories(): Promise<PythonRuntimeDirectories> {
  return app.isPackaged ? Promise.resolve(packagedPython()) : workspacePythonDirectories();
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
  // macOS 上关窗口不退出应用，照常关；其他平台关窗口就是退出，窗口留到后端收尾完成。
  if (process.platform !== "darwin") window.on("close", quitting.closeWindow);
  window.webContents.setWindowOpenHandler(({ url }) => openInBrowser(url, (url) => shell.openExternal(url)));

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
