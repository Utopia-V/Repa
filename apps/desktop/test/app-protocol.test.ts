// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { APP_PAGE_URL, createAppHandler, isAppUrl } from "../src/main/app-protocol";
import { pythonAssets } from "../src/main/python-runtime";

const WORKER_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'";
const WHEEL = "numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl";

let directory: string;
let handle: (request: Request) => Promise<Response>;

async function put(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "repa-desktop-protocol-"));
  const renderer = path.join(directory, "renderer");
  const pyodide = path.join(directory, "pyodide");
  const packages = path.join(directory, "packages");
  await put(path.join(renderer, "index.html"), "<!doctype html>");
  await put(path.join(renderer, "assets/index-abc.js"), "page");
  await put(path.join(renderer, "workers/worker-abc.js"), "worker");
  await put(path.join(directory, "secret.json"), "{}");
  await put(path.join(pyodide, "pyodide.mjs"), "pyodide");
  await put(path.join(pyodide, "console.html"), "console");
  await put(path.join(pyodide, "pyodide-lock.json"), JSON.stringify({ packages: { numpy: { file_name: WHEEL } } }));
  await put(path.join(packages, WHEEL), "wheel");
  await put(path.join(packages, "unlisted-1.0-py3-none-any.whl"), "wheel");
  handle = createAppHandler({ renderer, python: () => pythonAssets({ pyodide, packages }) });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const get = (url: string) => handle(new Request(url));

describe("repa 协议", () => {
  it("提供 renderer 文件，只给 Worker 脚本加 CSP 响应头", async () => {
    const page = await get(APP_PAGE_URL);
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("Content-Security-Policy")).toBeNull();
    expect(await page.text()).toBe("<!doctype html>");

    const script = await get("repa://app/assets/index-abc.js");
    expect(script.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(script.headers.get("Content-Security-Policy")).toBeNull();

    const worker = await get("repa://app/workers/worker-abc.js");
    expect(worker.headers.get("Content-Security-Policy")).toBe(WORKER_CSP);
    expect(await worker.text()).toBe("worker");
  });

  it("页面路由都给 index.html，刷新或直接打开 /learn 时由页面自己定位；缺少的资源文件仍是 404", async () => {
    for (const url of ["repa://app/learn", "repa://app/settings/models"]) {
      const page = await get(url);
      expect(page.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expect(await page.text()).toBe("<!doctype html>");
    }
    expect((await get("repa://app/assets/missing.js")).status).toBe(404);
    expect(isAppUrl("repa://app/learn")).toBe(true);
    expect(isAppUrl("repa://other/learn")).toBe(false);
    expect(isAppUrl("https://app/learn")).toBe(false);
  });

  it("不读 renderer 目录以外的文件，也不应答别的主机和方法", async () => {
    for (const url of [
      "repa://app/../secret.json",
      "repa://app/%2e%2e/secret.json",
      "repa://app/..%2fsecret.json",
      "repa://app/missing.js",
      "repa://other/index.html",
    ]) {
      expect((await get(url)).status, url).toBe(404);
    }
    expect((await handle(new Request(APP_PAGE_URL, { method: "POST", body: "" }))).status).toBe(404);
  });

  it("/__repa/pyodide/ 下只放行 Pyodide 的运行文件和 lockfile 里有的 wheel", async () => {
    const pyodide = await get("repa://app/__repa/pyodide/pyodide.mjs");
    expect(pyodide.status).toBe(200);
    expect(pyodide.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");

    const wheel = await get(`repa://app/__repa/pyodide/packages/${WHEEL}`);
    expect(wheel.status).toBe(200);
    expect(await wheel.text()).toBe("wheel");

    for (const name of ["console.html", "packages/unlisted-1.0-py3-none-any.whl", "packages/%2e%2e%2fpyodide-lock.json"]) {
      expect((await get(`repa://app/__repa/pyodide/${name}`)).status, name).toBe(404);
    }
  });

  it("wheel 还没准备好时回应 404，页面据此报告运行环境不可用", async () => {
    await rm(path.join(directory, "packages"), { recursive: true });
    expect((await get(`repa://app/__repa/pyodide/packages/${WHEEL}`)).status).toBe(404);
  });
});
