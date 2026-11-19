/**
 * 把真实的应用跑起来：学习者版本的后端（学习插件、课件转文字插件、通用 Agent），按桌面端的方式构建出的界面，
 * 一个无界面浏览器，和本机的假模型。全部放在这次走查的目录里：HOME、应用配置目录（REPA_HOME）、界面、浏览器数据和截图。
 *
 * 界面不用 Vite 开发服务器，而是与桌面端安装包相同的构建（apps/web 的 desktop 模式，Worker 放在 workers/），
 * 由桌面端主进程自己的 repa 协议处理函数提供文件、Pyodide 和 Worker 的 CSP，只是经 HTTP 而不是 repa://。
 * 开发模式下 React 的 StrictMode 会把每个副作用跑两遍，例如导出对话框一打开就预览两次，后端只认后一次，
 * 页面却可能拿着前一次的编号，导出偶尔以 export_expired 失败；学习者的应用里没有这种情形，走查也不该有。构建约 3 秒。
 *
 * 后端由这里直接持有：走查要能关掉后端再打开（像学习者关掉应用），也要能带着拨过的时钟重启。
 * 页面在浏览器里没有 window.repaHost，向 /__repa/connection 要连接，这里交出当前后端的连接。
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { RepaClient } from "@repa/base/client";
import { startRepaProcess, type RepaProcess } from "@repa/base/process";
import { describeRuntime, verifyPackages } from "@repa/python-runner";
import { build } from "vite";

import { createAppHandler } from "../../apps/desktop/src/main/app-protocol.js";
import { pythonAssets, workspacePythonDirectories } from "../../apps/desktop/src/main/python-runtime.js";
import { Browser, type Page } from "./browser.js";
import { ScriptedModel } from "./model.js";

export const REPO = fileURLToPath(new URL("../..", import.meta.url));
const CLOCK = fileURLToPath(new URL("./clock.mjs", import.meta.url));
const DAY_MS = 24 * 60 * 60_000;
/** 后端与浏览器共用的时区。固定下来，连跑的结果不随机器所在时区变化。 */
export const TIMEZONE = "Asia/Shanghai";

/** 按桌面端 electron.vite.config.ts 的 renderer 配置构建 apps/web：desktop 模式，Worker 入口放在 workers/。 */
async function buildRenderer(outDir: string): Promise<void> {
  await build({
    configFile: path.join(REPO, "apps/web/vite.config.ts"),
    root: path.join(REPO, "apps/web"),
    mode: "desktop",
    logLevel: "error",
    build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: Infinity },
    worker: { rollupOptions: { output: { entryFileNames: "workers/[name]-[hash].js" } } },
  });
}

/**
 * 走查开始时把后端的时钟拨到当天上午 10 点（TIMEZONE 的本地时间）：一次走查要在“同一天”里做完课、看结果，
 * 赶上午夜前后运行时，真实时钟会在中途跨日，结果就随运行时刻变化。返回要加给 Date.now() 的偏移。
 */
function morningOffset(now = Date.now()): number {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  // Asia/Shanghai 没有夏令时，固定 +08:00。
  return Date.parse(`${day}T10:00:00+08:00`) - now;
}

export interface AppOptions {
  /** 这次运行的目录，放 HOME、配置、浏览器数据、截图和报告。 */
  dir: string;
}

export class App {
  backend: RepaProcess | undefined;
  /** 给后端时钟加的偏移；隔天就是再加一天。 */
  clockOffsetMs = morningOffset();
  /** 后端的 clock.mjs 从这个文件读偏移。 */
  readonly clockFile: string;
  readonly home: string;
  readonly repaHome: string;
  readonly shots: string;
  private client: RepaClient | undefined;

  private constructor(readonly dir: string, readonly model: ScriptedModel, private server: Server, readonly url: string, readonly browser: Browser) {
    this.home = path.join(dir, "home");
    this.repaHome = path.join(dir, "repa-home");
    this.shots = path.join(dir, "shots");
    this.clockFile = path.join(dir, "clock-offset");
  }

  get page(): Page {
    return this.browser.page;
  }

  /** 起假模型、构建并提供界面、起浏览器；后端在 startBackend 里起，第一次打开前可以先决定有没有模型。 */
  static async start(options: AppOptions): Promise<App> {
    await checkPackages();
    const { dir } = options;
    for (const name of ["home", "repa-home", "shots", "browser"]) await mkdir(path.join(dir, name), { recursive: true });
    const renderer = path.join(dir, "renderer");
    await buildRenderer(renderer);
    const model = await ScriptedModel.start();
    const handler = createAppHandler({ renderer, python: async () => pythonAssets(await workspacePythonDirectories()) });
    let app: App | undefined;
    const server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/__repa/connection") {
          const backend = app?.backend;
          response.setHeader("Content-Type", "application/json");
          response.setHeader("Cache-Control", "no-store");
          response.statusCode = backend ? 200 : 503;
          response.end(JSON.stringify(backend ? backend.connection : { error: "走查的后端没有在运行。" }));
          return;
        }
        // 其余请求交给桌面端 repa 协议的处理函数，地址换成 repa://app/ 下的同一路径。
        const reply = await handler(new Request(`repa://app${url.pathname}${url.search}`, { method: request.method ?? "GET" }));
        response.statusCode = reply.status;
        reply.headers.forEach((value, key) => response.setHeader(key, value));
        response.end(Buffer.from(await reply.arrayBuffer()));
      })().catch((error: unknown) => {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : String(error));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    let browser: Browser;
    try {
      if (address === null || typeof address === "string") throw new Error("界面的服务没有拿到端口");
      browser = await Browser.launch({ profile: path.join(dir, "browser"), shots: path.join(dir, "shots"), timezone: TIMEZONE, home: path.join(dir, "home") });
    } catch (error) {
      // 已经起来的假模型和服务会让进程一直不退出。
      server.close();
      await model.close();
      throw error;
    }
    app = new App(dir, model, server, `http://127.0.0.1:${address.port}`, browser);
    browser.page.guard = () => (model.unexpected.length > 0 ? `假模型收到了没有剧本的请求：${model.unexpected[0]}` : undefined);
    return app;
  }

  /** 把几项 Pi 设置并进走查临时配置目录里的 agent/settings.json；后端关着时写，起后端时读入。 */
  private async writeAgentSettings(patch: Record<string, unknown>): Promise<void> {
    const file = path.join(this.repaHome, "agent", "settings.json");
    const current = JSON.parse(await readFile(file, "utf8").catch(() => "{}")) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...current, ...patch }, null, 2));
  }

  /** 写上假模型的配置：学习者接好了模型。 */
  async connectModel(): Promise<void> {
    await mkdir(path.join(this.repaHome, "agent"), { recursive: true });
    await writeFile(path.join(this.repaHome, "agent", "models.json"), JSON.stringify(this.model.modelsJson(), null, 2));
  }

  /**
   * 起后端。环境只给必要的几项：HOME 和 REPA_HOME 指向临时目录，不读真实的配置与凭据；
   * 不带本机环境里的 API key（Pi 会从环境变量读凭据），所以除了假模型没有别的模型可用，也就不会发出付费请求。
   */
  async startBackend(): Promise<void> {
    if (this.backend) throw new Error("后端已经在运行");
    await this.writeClock();
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: this.home,
      REPA_HOME: this.repaHome,
      TZ: TIMEZONE,
      LANG: "C.UTF-8",
      NODE_OPTIONS: `--import=${pathToFileURL(CLOCK).href}`,
      REPA_VERIFY_CLOCK_FILE: this.clockFile,
      ...(process.env.REPA_PYODIDE_PACKAGES ? { REPA_PYODIDE_PACKAGES: process.env.REPA_PYODIDE_PACKAGES } : {}),
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    };
    this.backend = await startRepaProcess({
      home: this.repaHome,
      plugins: [path.join(REPO, "packages/learning"), path.join(REPO, "packages/materials")],
      environment,
    });
  }

  /** 写下后端时钟的偏移：先写临时文件再改名，后端不会读到写了一半的内容。 */
  private async writeClock(): Promise<void> {
    await writeFile(`${this.clockFile}.tmp`, String(this.clockOffsetMs));
    await rename(`${this.clockFile}.tmp`, this.clockFile);
  }

  /**
   * 后端运行中把它的时钟往后拨 ms 毫秒，不重启、不刷新页面，像学习者开着应用等了这么久。
   * 后端最多 100 毫秒后读到新的偏移；页面的时钟另由 page.shiftClock 拨。
   */
  async shiftClock(ms: number): Promise<void> {
    this.clockOffsetMs += ms;
    await this.writeClock();
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  /** 正常关闭后端，等它收尾（与学习者关掉应用时桌面端主进程的做法相同）。 */
  async stopBackend(): Promise<void> {
    await this.client?.close().catch(() => {});
    this.client = undefined;
    const backend = this.backend;
    this.backend = undefined;
    await backend?.close();
  }

  /**
   * 关掉应用再打开：关后端、起后端，页面重新载入（localStorage 里记着上次的空间，与重开桌面端一样）。
   * settings 是重开前并进 Pi 设置的几项，例如缩短模型请求的超时，让“请求超时”在几秒内发生。
   */
  async reopen(options: { days?: number; settings?: Record<string, unknown> } = {}): Promise<void> {
    await this.stopBackend();
    if (options.days) this.clockOffsetMs += options.days * DAY_MS;
    if (options.settings) await this.writeAgentSettings(options.settings);
    await this.startBackend();
    await this.page.goto(`${this.url}/`);
  }

  /** 第一次打开页面。 */
  async open(): Promise<void> {
    await this.page.goto(`${this.url}/`);
  }

  /** 走查自己的一条后端连接，用来取界面上看不到的证据（学习记录、空间路径）。 */
  async rpc(): Promise<RepaClient> {
    if (!this.backend) throw new Error("后端没有在运行");
    this.client ??= await RepaClient.connect(this.backend.connection);
    return this.client;
  }

  async close(): Promise<void> {
    await this.stopBackend().catch(() => {});
    await this.browser.close().catch(() => {});
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
    await this.model.close().catch(() => {});
    // 浏览器数据和构建出的界面不是证据，共约 10 MB，删掉。
    await rm(path.join(this.dir, "browser"), { recursive: true, force: true });
    await rm(path.join(this.dir, "renderer"), { recursive: true, force: true });
  }
}

/**
 * 课程检查要在 Linux 沙箱里运行 verify，沙箱从离线包目录读 Pyodide 的 wheel。目录不全时检查不会通过，
 * 走查到做课那一步才失败，原因却要从 Agent 的工具结果里找；所以开始前先核对一遍，缺了直接说怎样准备。
 */
async function checkPackages(): Promise<void> {
  try {
    await verifyPackages(await describeRuntime());
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}（已有一份离线包时，npm run course:runtime -- --from 那个目录 只复制不下载；也可以用 REPA_PYODIDE_PACKAGES 指向它）`);
  }
}
