/**
 * 生产时 renderer 从 repa://app/ 加载，而不是 file://：file:// 的响应没有响应头，运行学习者代码的 Worker 拿不到 CSP。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { PYODIDE_PATH, PYTHON_WORKER_CSP, type PythonAssetLookup } from "./python-runtime";

export const APP_SCHEME = "repa";
const APP_HOST = "app";
export const APP_PAGE_URL = `${APP_SCHEME}://${APP_HOST}/`;
/** electron.vite.config.ts 把 Worker 入口放在这个目录；页面运行学习者代码的 Worker 都在这里。 */
const WORKER_DIRECTORY = "workers/";

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json"],
  [".map", "application/json"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
]);

/** 地址是否属于应用页面。页面用浏览器路由，切换页面后地址是 repa://app/learn 之类，不只首页。 */
export function isAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST;
  } catch {
    return false;
  }
}

export interface AppHandlerOptions {
  /** electron-vite 构建出的 renderer 目录，即按 desktop 模式构建的 apps/web。 */
  renderer: string;
  python: () => Promise<PythonAssetLookup>;
}

function notFound(): Response {
  return new Response(null, { status: 404 });
}

async function serve(file: string, type: string, headers: Record<string, string> = {}): Promise<Response> {
  let body: Buffer<ArrayBuffer>;
  try {
    body = await readFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") return notFound();
    throw error;
  }
  return new Response(body, { headers: { "Content-Type": type, ...headers } });
}

/**
 * repa 协议的处理函数：只读 renderer 目录里的文件，/__repa/pyodide/ 下只给放行的 Python 运行时文件。
 * 没有扩展名的路径是页面路由（例如 /learn），都给 index.html，刷新或从这些地址打开时由页面自己定位。
 */
export function createAppHandler({ renderer, python }: AppHandlerOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.host !== APP_HOST) return notFound();
    let name: string;
    try {
      name = decodeURIComponent(url.pathname);
    } catch {
      return notFound();
    }
    if (name.startsWith(PYODIDE_PATH)) {
      const asset = (await python())(name.slice(PYODIDE_PATH.length));
      return asset ? serve(asset.file, asset.type) : notFound();
    }
    const file = path.join(renderer, path.extname(name) === "" ? "index.html" : name);
    const relative = path.relative(renderer, file);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return notFound();
    const type = CONTENT_TYPES.get(path.extname(file)) ?? "application/octet-stream";
    const worker = relative.split(path.sep).join("/").startsWith(WORKER_DIRECTORY);
    return serve(file, type, worker ? { "Content-Security-Policy": PYTHON_WORKER_CSP } : {});
  };
}
