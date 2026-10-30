# Python 运行器

## 概述

`@repa/python-runner` 在 Pyodide 里运行 Python 程序：页面在 Worker 里运行学习者的代码，Node 在 Linux 沙箱里运行课程核对的任务。

## 怎么用

两边加载的是同一份 [`runner.py`](runner.py)，用同一个 `program_test` 逐个阶段运行测试。它给每个测试全新的命名空间和空的工作目录，测试后恢复解释器里常被改动的全局状态，再把结果序列化成可以在 Pyodide 之外比较的结构。两边按同一份约定（[`src/protocol.ts`](src/protocol.ts)）成批运行测试、计时、归类结果，调用方换执行方时不用改判断。判断对错由调用方负责：本包只运行代码、交回结果。

### 在页面里运行

页面从 `@repa/python-runner/browser` 创建 `PythonRunner`，交给它三样东西：`@repa/python-runner/runner.py` 的源码、新建 Worker 的函数和 Pyodide 文件所在的地址。Worker 脚本只需导入 `@repa/python-runner/worker`。之后用 `servePythonRun` 在 Repa 连接上提供前端服务 `python.run`：

```ts
import runnerSource from "@repa/python-runner/runner.py?raw";
import { loadRuntimeFiles, PythonRunner, servePythonRun } from "@repa/python-runner/browser";

const assetsUrl = new URL("/__repa/pyodide/", location.href).href;
const runner = new PythonRunner({
  assetsUrl,
  runnerSource,
  // worker.ts 里只有一行：import "@repa/python-runner/worker";
  createWorker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
  loadFiles: () => loadRuntimeFiles(assetsUrl),
});
const stop = servePythonRun(client, runner); // client 是已经连接的 RepaClient
```

`python.run` 的输入输出定义在 [`src/protocol.ts`](src/protocol.ts)，经 `@repa/python-runner/protocol` 导出，浏览器里也能用。前端连接时在 `capabilities.services` 里声明 `python.run`，就表示能运行 Python，后端不另外探测；`servePythonRun` 开始服务时就在后台预热一个 Worker。请求只有协议名和一批测试，不带调用方的标识；结果按顺序给出每个测试的状态，并记下实际加载的 Pyodide、Python 和 numpy、pandas 版本，调用方不拿它比较。

每次调用在一个全新的 Worker 里依次运行这批测试，用完就销毁，后台随即预热下一个。准备（前导、夹具、setup）、被测代码（program、capture、doctest）和收尾各计时 10 秒；某个测试超时或失败后整批停下，剩下的记为 `not_run`，结果写明停在哪个阶段。测试后恢复解释器状态失败时，这个测试的结果在收尾之前已经算出，照样交回并带上 `restoreError`，余下的测试换一个新的 Worker 接着运行，所以一次调用用的 Worker 数是 1 加上恢复失败的次数；换 Worker 时起不来，已经得到的结果照样交回，下一个测试记为执行失败。调用方取消（`service.closed`）或页面调用 `close()` 时，正在运行的 Worker 随即结束。

提供页面的宿主要做两件事。第一，在 `assetsUrl` 提供 `pyodide.mjs`、`pyodide.asm.mjs`、`pyodide.asm.wasm`、`python_stdlib.zip` 和 `pyodide-lock.json`，wheel 放在其下的 `packages/`；页面按 lockfile 核对 wheel 的 SHA-256 后才交给 Worker。第二，给 Worker 脚本的响应头加 CSP `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'`。Worker 不继承页面 meta 里的 CSP，没有这个响应头时，Python 一句 `pyfetch` 就能读到后端连接的 token；Worker 启动时会确认 CSP 生效，否则拒绝运行。Web 与 Desktop 的做法见[开发指南](../../docs/development/README.md)。

### 在 Linux 沙箱里运行

Node 这边从包入口 `@repa/python-runner` 取用。`describeRuntime` 按要求的版本找到安装的 pyodide 和需要的 wheel，`verifyPackages` 核对离线包，`SandboxRunner` 按需启动沙箱，`runTests` 按 `python.run` 的约定运行一批测试：

```ts
import { describeRuntime, SandboxRunner, verifyPackages } from "@repa/python-runner";

const assets = await describeRuntime({
  pyodide: "314.0.7", python: "3.14.2", packages: { numpy: "2.4.6", pandas: "3.0.2" }, prelude: "import pandas as pd",
});
await verifyPackages(assets);
const runner = new SandboxRunner({ assets });
const [result] = await runner.runTests([
  { id: "a", prelude: "import pandas as pd", data: [], setup: "", program: "total = 1 + 1", captures: ["total"], doctest: [] },
]);
await runner.close();
```

`runTests` 与页面的不同只在于解释器的去留：所有测试在同一个解释器里依次运行，没有出问题的解释器留给下一次调用接着用；测试超时、失败或恢复解释器状态失败后结束这个沙箱，之后的测试换一个新的。计时和结果的归类与页面共用 [`src/test-results.ts`](src/test-results.ts)，超时按沙箱转发的阶段写明停在哪里。`run` 运行课程核对专用的 `verify` 任务（交给 `runner.py` 的 `handle_job` 的 JSON 对象），结果见 `JobOutcome`。`starts` 是启动过的沙箱数，应等于 1 加上超时、崩溃和恢复失败的次数，调用方据此核对代价。沙箱建立不了时抛 `SandboxUnavailable`，调用方应当报错，不改用不受限的运行。

### 离线包

pandas、NumPy 等 wheel 不在 npm 包 pyodide 里。课程清单决定要哪些包，所以由学习插件的 `npm run course:runtime` 调用本包的 `preparePackages`，把它们准备到 `packages/python-runner/.cache/pyodide/<版本>/`（`REPA_PYODIDE_PACKAGES` 可改位置）：`--from` 从已有目录复制，不给时从 jsDelivr 下载。两种方式都按 Pyodide 发行 lockfile 的 SHA-256 核对，沙箱使用前还会再核对一次。Web 开发服务器、Desktop 和 Linux 安装包也从这个目录取 wheel，位置由 `defaultPackagesDirectory` 给出。解释器和标准库来自 npm 包本身，由 npm 按 `package-lock.json` 里的摘要核对，这里不另外核对。

## 怎么实现

### 沙箱

系统 python3 运行 [`sandbox/launch.py`](sandbox/launch.py)，它先在内核层面设下限制，再 exec 成 Node，由 [`sandbox/runner.mjs`](sandbox/runner.mjs) 加载 Pyodide 和 `runner.py`。限制随 exec 一直保留到进程结束：

- 文件：只能读 `/usr`、动态链接器缓存、`/dev/urandom`、Pyodide 和 ws 包、`runner.py`、`sandbox/` 和逐个放行的 wheel 文件；只有 `/dev/null` 可写。只能执行 Node 本身和它的动态链接器（动态链接器能被用来启动 `/usr` 里的其他程序，它们受同样的限制）。
- 网络：不能创建 socket，也不能建立 TCP 连接。
- 进程：只能创建线程，不能创建进程；信号只能发给自己；不能调整别的进程的资源上限、优先级和调度。
- 资源：私有内存用 `RLIMIT_DATA` 限制在 2 GiB；沙箱里只有一个进程，线程的栈也算在内，这就是整个沙箱的上限。CPU 时间上限 600 秒。

这里不用 bwrap：Ubuntu 默认限制非特权进程使用 user namespace，没有专用 AppArmor 配置时 bwrap 建不了 namespace，而 Landlock 和 seccomp 普通用户就能用。限制建立不了时 `launch.py` 以退出码 70 结束，不会降级成不受限的运行。另外，`runner.mjs` 让 Python 的 `js` 模块只看到一个空对象，Node 也以 `--disallow-code-generation-from-strings` 启动，所以 Python 代码拿不到 `process`、`require`、`fetch` 和 `Function` 构造器；这一层减少意外和干扰，安全边界仍是上面的内核限制。页面这边的安全边界是 Worker 的 CSP，Python 的 `js` 模块同样只看到空对象。

### 任务之间恢复什么

每个任务从全新的命名空间开始，先运行 `prelude`，再准备数据夹具，工作目录是空的。任务后，`runner.py` 恢复 pandas 与 NumPy 的选项、builtins、输出流与显示钩子、`sys.path`、环境变量、warnings 过滤器，取消挂起的 asyncio 任务，删掉任务在工作目录、`/tmp` 和根目录下新建的文件，并用系统熵给 `random` 与 `numpy.random` 重新播种，与新的解释器一样，各任务抽到的数互不相关。程序在 capture 求值和序列化时打印的内容，包括值被释放时 `__del__` 打印的，都收进这一项的输出，共用 64 KiB 的上限。

两个宿主都复用解释器，只为省去重新加载 Pyodide、NumPy 和 pandas 的时间：Node 宿主一直沿用同一个，页面在一次调用之内沿用、每次调用换一个新的 Worker；恢复失败或任务超时后，两边都换新的解释器。已导入的模块不在恢复之列，任务对它们的改动会带到同一个解释器里的后续任务。

### 超时算谁的

程序、capture 求值和 doctest 运行的是被测的代码，在这些阶段超时是测试的结果。序列化 capture 的值会调用值自己的 `__repr__`、`__len__` 和迭代，也可能是被测的代码，所以归在 capture 下，同样算测试的结果。准备阶段运行的是课程给的前导、夹具和 setup，收尾运行的是 `runner.py` 自己，这两段超时和任何阶段的崩溃都算执行失败。三段各自计时：如果共用一份时限，被测代码用掉大半之后在收尾时到点，就会被错算成执行失败。

## 对模型的影响

无：本包只在页面和沙箱里运行 Python 程序并交回结果，不向模型注入提示、工具或上下文。

## 已知限制与暂缓

- 已导入模块的改动会带到同一个解释器里的后续任务。课程核对整门课共用一个解释器，一份候选程序给 pandas 打的补丁会影响之后的候选；判分时每次提交用新的 Worker，不受别的提交影响。随包课程没有这类改动：2026-10-30 记录了全部任务结束时留下的改动，只有新建的文件、`builtins._` 和库按需导入的模块。课程以后要教这类写法时，再为相关的候选换新的解释器；比较全部模块与类的属性也能拦下，但整门课核对会慢到约三倍，见[学习插件重做](../../.agents/notes/proposed/architecture/2026-10-30-learning-plugin-refactor.md)。
- `runner.py` 还带着课程核对专用的 `verify` 任务（作答位的形状、WWPD 的显示约定），页面的 Worker 也加载这部分代码。它不在判分路径上；移出要让学习插件自带一份 Python 辅助代码，并决定怎样交给两个宿主，留到以后单独做。
- 收尾时恢复状态抛出异常，结果照样交回；收尾卡住或解释器崩溃时，结果还在解释器里没有交出，这个测试记为执行失败。恢复运行的几乎都是 `runner.py` 自己的代码，又有单独的时限，这种情况基本只在运行器出错时出现，所以没有改成先交出结果再收尾。
- Node 宿主只能在 Linux 上运行，依赖 Landlock（ABI 4 以上，Linux 6.7 起）、libseccomp 和 `/usr/bin/python3`；Windows、macOS 上的课程核对只能 `--no-run`。
- `RLIMIT_DATA` 只管进程私有的可写内存，没有 cgroup 级的整树限制，线程数只受内存间接限制。运行比课程核对更不可信的内容之前需要再评估。
