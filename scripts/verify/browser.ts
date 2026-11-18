/**
 * 无界面浏览器：拉起机器上已有的 Chromium 系浏览器，经 Chrome 调试协议（CDP）驱动一个页面。
 * 不引入 Playwright：仓库里没有它，加进来是一个新依赖，还要配对应版本的浏览器；而这里只需要读文字、
 * 按名称点按钮、输入、截图，直接说 CDP 就够了，Node 自带的 WebSocket 即可，不必下载任何东西。
 *
 * 页面的 CSP 不放行字符串脚本（没有 unsafe-eval），页面自己的 eval 和 new Function 都会失败；
 * 经 CDP 的 Runtime.evaluate 由调试器执行，不受 CSP 约束。等待一律是读页面文字加轮询。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** 只作 Promise.race 的期限用：不让还没到期的计时器拖住进程退出。 */
const expire = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref());

/** 找机器上的无界面浏览器：先看 REPA_VERIFY_BROWSER，再看 Playwright 缓存里的 headless shell，再看 PATH 里的 Chromium 系浏览器。 */
export function findBrowser(): string {
  const given = process.env.REPA_VERIFY_BROWSER;
  if (given) return given;
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  if (existsSync(cache)) {
    // 版本号大的在后；只取 headless shell，它没有窗口可开。
    const shells = readdirSync(cache).filter((name) => name.startsWith("chromium_headless_shell-")).sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));
    for (const name of shells.reverse()) {
      const file = path.join(cache, name, "chrome-headless-shell-linux64", "chrome-headless-shell");
      if (existsSync(file)) return file;
    }
  }
  for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "microsoft-edge"]) {
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      const file = path.join(directory, name);
      if (directory && existsSync(file)) return file;
    }
  }
  throw new Error("找不到 Chromium 系的浏览器。用 REPA_VERIFY_BROWSER 指定一个（chrome-headless-shell、chromium、google-chrome 或 msedge 都行）。");
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** 一条到浏览器的 CDP 连接；页面会话用 flatten 模式复用它，消息按 sessionId 区分。 */
class Connection {
  private next = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(method: string, params: Record<string, unknown>, sessionId: string | undefined) => void>();

  private constructor(private socket: WebSocket) {
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) entry?.reject(new Error(message.error.message));
        else entry?.resolve(message.result);
        return;
      }
      if (message.method) for (const listener of this.listeners) listener(message.method, message.params ?? {}, message.sessionId);
    };
    socket.onclose = () => {
      for (const entry of this.pending.values()) entry.reject(new Error("浏览器的调试连接已断开"));
      this.pending.clear();
    };
  }

  static async open(url: string): Promise<Connection> {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error(`连不上浏览器的调试端口：${url}`));
    });
    return new Connection(socket);
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.next++;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
    });
  }

  on(listener: (method: string, params: Record<string, unknown>, sessionId: string | undefined) => void): void {
    this.listeners.add(listener);
  }

  close(): void {
    this.socket.close();
  }
}

/** 找元素的方式：按可见文字或可访问名称；near 给出时只要祖先里含这段文字的那一个（例如菜单里某一项的“开始”）。 */
export interface Target {
  name: string | RegExp;
  near?: string;
  /** 只找这些元素，缺省是按钮、链接、单选多选和选项一类能点的元素。 */
  selector?: string;
}

const CLICKABLE = "button, a[href], [role=button], [role=radio], [role=checkbox], [role=option], [role=tab], [role=menuitem], label, summary";

/**
 * 在页面里找元素并滚进视野，交回中心坐标。函数整段经 CDP 发进页面执行；名称先比可访问名称（aria-label），再比去掉空白的文字，
 * 完全相同的优先，其次是包含。
 */
function locate(target: { name: string; regex: boolean; near?: string; selector: string }) {
  const squash = (text: string | null | undefined) => (text ?? "").replace(/\s+/gu, "");
  const pattern = target.regex ? new RegExp(target.name, "u") : undefined;
  const wanted = squash(target.name);
  const visible = (element: Element) => {
    const rects = element.getClientRects();
    if (rects.length === 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  const nameOf = (element: Element) => squash(element.getAttribute("aria-label")) || squash((element as HTMLElement).innerText);
  const candidates = [...document.querySelectorAll(target.selector)].filter(visible);
  const near = target.near === undefined ? undefined : squash(target.near);
  const scoped = near === undefined ? candidates : candidates.filter((element) => {
    let node: Element | null = element;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) if (squash((node as HTMLElement).innerText).includes(near)) return true;
    return false;
  });
  const exact = scoped.filter((element) => pattern ? pattern.test(nameOf(element)) : nameOf(element) === wanted);
  const partial = pattern ? [] : scoped.filter((element) => nameOf(element).includes(wanted));
  // 包含时取文字最短的那个：外层容器的文字也包含名称，最短的才是要点的元素本身。
  partial.sort((a, b) => nameOf(a).length - nameOf(b).length);
  const element = exact[0] ?? partial[0];
  if (!element) return { found: false, names: candidates.slice(0, 40).map(nameOf).filter(Boolean) };
  element.scrollIntoView({ block: "center", inline: "center" });
  const rect = element.getBoundingClientRect();
  const disabled = (element as HTMLButtonElement).disabled === true || element.getAttribute("aria-disabled") === "true";
  return { found: true, disabled, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** 找一个输入框：按关联的 label 文字、aria-label 或 placeholder；只给 near 时取那附近的第一个输入框。 */
function focusField(target: { name: string; near?: string }) {
  const squash = (text: string | null | undefined) => (text ?? "").replace(/\s+/gu, "");
  const wanted = squash(target.name);
  const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea, [contenteditable=true]")]
    .filter((element) => element.getClientRects().length > 0 && !(element as HTMLInputElement).disabled);
  const labelOf = (element: Element) => {
    const labels = (element as HTMLInputElement).labels;
    const fromLabels = labels ? [...labels].map((label) => squash(label.innerText)).join("") : "";
    const describedBy = element.getAttribute("aria-labelledby");
    const fromIds = describedBy ? describedBy.split(" ").map((id) => squash(document.getElementById(id)?.innerText)).join("") : "";
    return `${fromLabels}${fromIds}${squash(element.getAttribute("aria-label"))}${squash(element.getAttribute("placeholder"))}`;
  };
  let field = wanted === "" ? undefined : fields.find((element) => labelOf(element).includes(wanted));
  if (!field && target.near !== undefined) {
    const near = squash(target.near);
    field = fields.find((element) => {
      let node: Element | null = element;
      for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) if (squash((node as HTMLElement).innerText).includes(near)) return true;
      return false;
    });
  }
  if (!field && wanted === "" && target.near === undefined) field = fields[0];
  if (!field) return { found: false, labels: fields.map(labelOf) };
  field.scrollIntoView({ block: "center" });
  field.focus();
  if ("select" in field) field.select();
  return { found: true };
}

/** 页面里的时钟往后拨 ms 毫秒；第一次调用时换上带偏移的 Date，之后只加偏移。做法与后端的 clock.mjs 相同。 */
function shiftPageClock(ms: number) {
  const holder = window as unknown as { __repaVerifyClock?: { offset: number } };
  if (!holder.__repaVerifyClock) {
    const state = { offset: 0 };
    holder.__repaVerifyClock = state;
    const RealDate = Date;
    const realNow = RealDate.now.bind(RealDate);
    const now = () => realNow() + state.offset;
    RealDate.now = now;
    window.Date = new Proxy(RealDate, {
      construct(target, args, newTarget) {
        return Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget) as object;
      },
      apply() {
        return new RealDate(now()).toString();
      },
    });
  }
  holder.__repaVerifyClock.offset += ms;
}

/** 一个页面：读文字、等文字、点、输入、按键、截图。 */
export class Page {
  /** 页面里出过的错误（console.error 与未捕获的异常），失败时随证据一起交出。 */
  readonly errors: string[] = [];
  /** 每轮等待时先问一下：交回一句话时立即停止等待并以它报错（例如假模型收到了没有剧本的请求，再等也等不到）。 */
  guard: () => string | undefined = () => undefined;

  constructor(private connection: Connection, private sessionId: string, private shots: string) {
    connection.on((method, params, sessionId) => {
      if (sessionId !== this.sessionId) return;
      if (method === "Runtime.exceptionThrown") {
        const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
        this.errors.push(`pageerror: ${details?.exception?.description ?? details?.text ?? ""}`.slice(0, 500));
      }
      if (method === "Runtime.consoleAPICalled" && params.type === "error") {
        const args = (params.args as { value?: unknown; description?: string }[] | undefined) ?? [];
        this.errors.push(args.map((arg) => (arg.value === undefined ? arg.description ?? "" : String(arg.value))).join(" ").slice(0, 500));
      }
    });
  }

  private send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.connection.send<T>(method, params, this.sessionId);
  }

  /** 在页面里求一个表达式的值；表达式是 Promise 时等它完成。 */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const reply = await this.send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true },
    );
    if (reply.exceptionDetails) throw new Error(`页面里求值出错：${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`);
    return reply.result.value as T;
  }

  /**
   * 把一个函数和参数送进页面执行。函数不能引用外层变量：它是按源码文字送过去的。
   * tsx 编译时保留函数名，会在函数体里插入对 __name 的调用，页面里没有它，这里补一个原样返回的。
   */
  private call<A, R>(fn: (argument: A) => R, argument: A): Promise<R> {
    return this.evaluate<R>(`(() => { const __name = (f) => f; return (${fn.toString()})(${JSON.stringify(argument)}); })()`);
  }

  /**
   * 打开一个地址，等新文档载入完。Page.navigate 在导航开始时就返回，紧接着读到的可能还是旧页面的文字，
   * 所以先在旧页面上做个记号，等到记号消失、新文档 complete 再返回。
   */
  async goto(url: string): Promise<void> {
    await this.evaluate("window.__repaVerifyOld = true").catch(() => undefined);
    await this.send("Page.navigate", { url });
    const deadline = Date.now() + 30_000;
    while (!(await this.evaluate<boolean>("!window.__repaVerifyOld && document.readyState === 'complete'").catch(() => false))) {
      if (Date.now() > deadline) throw new Error(`30 秒内没有打开 ${url}`);
      await wait(100);
    }
  }

  url(): Promise<string> {
    return this.evaluate<string>("location.href");
  }

  /** 页面上看得见的全部文字（含打开着的对话框和抽屉）。 */
  async text(): Promise<string> {
    return (await this.evaluate<string | undefined>("document.body ? document.body.innerText : ''")) ?? "";
  }

  /** 轮询页面文字，直到 check 成立；超时时报出最后看到的文字。 */
  async waitFor(description: string, check: (text: string) => boolean, timeoutMs = 15_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let text = "";
    for (;;) {
      try {
        text = await this.text();
      } catch {
        // 页面正在导航时求值会失败，下一轮再读。
      }
      if (check(text)) return text;
      const stop = this.guard();
      if (stop !== undefined) throw new Error(`等待「${description}」时中止：${stop}`);
      if (Date.now() > deadline) throw new Error(`${timeoutMs / 1000} 秒内没有等到：${description}`);
      await wait(150);
    }
  }

  /** 等页面上出现这段文字（或匹配这个正则）。 */
  waitText(expected: string | RegExp, timeoutMs?: number): Promise<string> {
    const test = typeof expected === "string" ? (text: string) => text.includes(expected) : (text: string) => expected.test(text);
    return this.waitFor(`页面上出现 ${String(expected)}`, test, timeoutMs);
  }

  /** 等这段文字消失。 */
  waitGone(expected: string, timeoutMs?: number): Promise<string> {
    return this.waitFor(`页面上不再有 ${expected}`, (text) => !text.includes(expected), timeoutMs);
  }

  /** 点一个元素：等它出现并可用，再在它的中心按下、抬起鼠标，与真实点击一样经过页面的指针事件。 */
  async click(target: string | Target, timeoutMs = 10_000): Promise<void> {
    const spec = typeof target === "string" ? { name: target } : target;
    const argument = {
      name: spec.name instanceof RegExp ? spec.name.source : spec.name,
      regex: spec.name instanceof RegExp,
      selector: spec.selector ?? CLICKABLE,
      ...(spec.near === undefined ? {} : { near: spec.near }),
    };
    const deadline = Date.now() + timeoutMs;
    let last: { x: number; y: number } | undefined;
    for (;;) {
      const found = await this.call(locate, argument);
      if (found.found && !found.disabled && found.x !== undefined && found.y !== undefined) {
        // 对话框、抽屉打开时有一段位移和缩放的动画，动画中算出的坐标点下去会落在别处（例如落在遮罩上，把对话框关掉）。
        // 隔一小会儿再找一次，位置不变才点。
        if (last && Math.abs(last.x - found.x) < 0.5 && Math.abs(last.y - found.y) < 0.5) {
          await this.mouse(found.x, found.y);
          return;
        }
        last = { x: found.x, y: found.y };
        await wait(80);
        continue;
      }
      last = undefined;
      if (Date.now() > deadline) {
        const why = found.found ? "它一直不可用" : `能点的有：${(found.names ?? []).join("、")}`;
        throw new Error(`没能点到「${String(spec.name)}」${spec.near ? `（在「${spec.near}」附近）` : ""}：${why}`);
      }
      await wait(150);
    }
  }

  /** 这个元素此刻在不在页面上、能不能点（不等待）。 */
  async find(target: string | Target): Promise<{ found: boolean; disabled: boolean }> {
    const spec = typeof target === "string" ? { name: target } : target;
    const found = await this.call(locate, {
      name: spec.name instanceof RegExp ? spec.name.source : spec.name,
      regex: spec.name instanceof RegExp,
      selector: spec.selector ?? CLICKABLE,
      ...(spec.near === undefined ? {} : { near: spec.near }),
    });
    return { found: found.found, disabled: found.disabled === true };
  }

  /** 这个元素此刻在不在页面上（不等待）。 */
  async has(target: string | Target): Promise<boolean> {
    return (await this.find(target)).found;
  }

  private async mouse(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  /** 在输入框里输入（先选中原有内容，输入的文字替换它）。name 是 label、aria-label 或 placeholder 里的文字。 */
  async fill(name: string, text: string, options: { near?: string; timeoutMs?: number } = {}): Promise<void> {
    const deadline = Date.now() + (options.timeoutMs ?? 10_000);
    for (;;) {
      const found = await this.call(focusField, { name, ...(options.near === undefined ? {} : { near: options.near }) });
      if (found.found) break;
      if (Date.now() > deadline) throw new Error(`找不到输入框「${name}」：页面上的输入框有 ${(found.labels ?? []).map((label) => `「${label}」`).join("、") || "（没有）"}`);
      await wait(150);
    }
    // insertText 与输入法上屏一样发出 input 事件，受控组件照常更新。
    await this.send("Input.insertText", { text });
  }

  /** 按一个键，例如 Enter、Escape。 */
  async press(key: "Enter" | "Escape" | "Tab"): Promise<void> {
    const codes = { Enter: 13, Escape: 27, Tab: 9 } as const;
    const base = { key, code: key, windowsVirtualKeyCode: codes[key], nativeVirtualKeyCode: codes[key] };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, ...(key === "Enter" ? { text: "\r" } : {}) });
    if (key === "Enter") await this.send("Input.dispatchKeyEvent", { type: "char", ...base, text: "\r" });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** 改视口大小，例如看宽屏时学习页右侧常驻的面板；走查的步骤固定用缺省的窄屏。 */
  async resize(width: number, height: number): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  }

  /**
   * 把页面里的时钟往后拨 ms 毫秒，到页面重新载入为止：Date.now() 与不带参数的 new Date() 加上偏移，与后端的 clock.mjs 相同。
   * 计时器不受影响，已经排好的 setTimeout 仍按真实时间到点；拨完以后页面像是被搁置了这么久。
   */
  async shiftClock(ms: number): Promise<void> {
    await this.call(shiftPageClock, ms);
  }

  /**
   * 之后每次载入新文档时，在页面自己的脚本之前先运行 source（经 CDP 注入，不受页面 CSP 限制）；已经载入的页面不受影响。
   * 交回撤销它的函数。
   */
  async beforeScripts(source: string): Promise<() => Promise<void>> {
    const { identifier } = await this.send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", { source });
    return async () => {
      await this.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    };
  }

  /** 截一张当前视口的图，交回文件路径。 */
  async shot(name: string): Promise<string> {
    await mkdir(this.shots, { recursive: true });
    const file = path.join(this.shots, `${name.replace(/[^\p{L}\p{N}_-]+/gu, "-")}.png`);
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    await writeFile(file, Buffer.from(data, "base64"));
    return file;
  }

  /** 交出并清空页面里出过的错误。 */
  takeErrors(): string[] {
    return this.errors.splice(0);
  }
}

/** 一个无界面浏览器进程和其中的一个页面。 */
export class Browser {
  private constructor(private process: ChildProcess, private connection: Connection, readonly page: Page) {}

  /** 拉起浏览器，开一个空白页。窗口大小与桌面端默认窗口相同（1120×760），这个宽度下学习页的面板收在右上角的按钮里。 */
  static async launch(options: { profile: string; shots: string; home: string; width?: number; height?: number; timezone?: string }): Promise<Browser> {
    const executable = findBrowser();
    const width = options.width ?? 1120;
    const height = options.height ?? 760;
    const args = [
      "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${options.profile}`,
      "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
      "--disable-sync", "--disable-extensions", "--mute-audio", "--hide-scrollbars", `--window-size=${width},${height}`,
      "--lang=zh-CN",
      // 与 Playwright 的缺省一样关掉 Chromium 的沙箱：Ubuntu 23.10 以后 AppArmor 不让非特权进程建 user namespace，
      // 带沙箱起不来。这里只打开本机的开发服务器上的页面。
      "--no-sandbox",
      "about:blank",
    ];
    // HOME 也换成临时目录：浏览器数据已经在 --user-data-dir 里，这样它连字体缓存一类的东西也不写进真实的主目录。
    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, HOME: options.home } });
    const url = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(`浏览器 20 秒内没有交出调试地址：${output.slice(-500)}`)), 20_000);
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        output += chunk;
        const match = /DevTools listening on (ws:\/\/\S+)/u.exec(output);
        if (match?.[1]) {
          clearTimeout(timer);
          // 之后不再读它：浏览器的子进程继承了这条管道，关掉浏览器后它们还会拿着它一会儿，读着它会让走查迟迟不退出。
          child.stderr?.destroy();
          resolve(match[1]);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`浏览器启动后退出（${code}）：${output.slice(-500)}`));
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`起不来浏览器 ${executable}：${error.message}`));
      });
    });
    const connection = await Connection.open(url);
    const { targetInfos } = await connection.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
    const blank = targetInfos.find((target) => target.type === "page");
    const targetId = blank?.targetId ?? (await connection.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })).targetId;
    const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(connection, sessionId, options.shots);
    await connection.send("Page.enable", {}, sessionId);
    await connection.send("Runtime.enable", {}, sessionId);
    await connection.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    if (options.timezone) await connection.send("Emulation.setTimezoneOverride", { timezoneId: options.timezone }, sessionId);
    await connection.send("Emulation.setLocaleOverride", { locale: "zh-CN" }, sessionId);
    return new Browser(child, connection, page);
  }

  /** 经 CDP 请浏览器正常关闭（连同它的子进程），5 秒内没有退出就强行结束。 */
  async close(): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    const exited = new Promise((resolve) => this.process.once("exit", resolve));
    await Promise.race([this.connection.send("Browser.close").catch(() => undefined), expire(2_000)]);
    this.connection.close();
    await Promise.race([exited, expire(5_000)]);
    if (this.process.exitCode === null && this.process.signalCode === null) this.process.kill("SIGKILL");
  }
}
