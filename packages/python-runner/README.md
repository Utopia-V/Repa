# Python 运行器

## 概述

`@repa/python-runner` 在 Pyodide 里运行 Python 程序：页面在 Worker 里运行学习者的代码和课程核对的任务，Node 在 Linux 沙箱里运行课程核对的任务。

## 怎么用

两边加载的是同一份 [`runner.py`](runner.py)，用同一个 `program_test` 逐个阶段运行测试，运行的是同一个环境：标准库，加上应用带的包 `PYTHON_PACKAGES`（numpy、pandas 及其依赖）。带的包在测试的代码用 import 语句引入时才加载，见下文的[按需加载](#按需加载)。课程核对的 `verify` 任务也是一种测试，带着 `verify` 字段，结果里多一项 `verified`。它给每个测试全新的命名空间和空的工作目录，测试后恢复解释器里常被改动的全局状态，再把结果序列化成可以在 Pyodide 之外比较的结构。两边按同一份约定（[`src/protocol.ts`](src/protocol.ts)）成批运行测试、计时、归类结果，调用方换执行方时不用改判断。判断对错由调用方负责：本包只运行代码、交回结果。

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

`python.run` 的输入输出定义在 [`src/protocol.ts`](src/protocol.ts)，经 `@repa/python-runner/protocol` 导出，浏览器里也能用；协议名是 `repa-python-batch-v4`，格式变了才换名字，前端认不出就拒绝。前端连接时在 `capabilities.services` 里声明 `python.run`，就表示能运行 Python，后端不另外探测；`servePythonRun` 开始服务时就在后台预热一个 Worker。请求只有协议名和一批测试，不带调用方的标识；结果按顺序给出每个测试的状态，并记下运行环境（Pyodide、Python 和带的包的版本）和 `loaded`，即这一批测试引入、因而加载的包。

每次调用在一个全新的 Worker 里依次运行这批测试，用完就销毁，后台随即预热下一个；预热的 Worker 先加载上一次调用的 `loaded`（第一个预热全部带的包），学习者接连提交同一门课的代码题时，包已在预热时加载好。准备（前导、夹具、setup）、被测代码（program、capture、doctest）和收尾各计时 10 秒，启动和加载测试引入的包各 60 秒，两个宿主共用这两个时限（`PYTHON_STEP_TIMEOUT_MS`、`PYTHON_START_TIMEOUT_MS`），加载包时超时记在准备阶段；调用方等前端交回一批结果的期限由 `replyDeadlineMs` 按同样的时限算出，只防页面本身没有回应；某个测试超时或失败后整批停下，剩下的记为 `not_run`，结果写明停在哪个阶段。测试后恢复解释器状态失败时，这个测试的结果在收尾之前已经算出，照样交回并带上 `restoreError`，余下的测试换一个新的 Worker 接着运行，所以一次调用用的 Worker 数是 1 加上恢复失败的次数；换 Worker 时起不来，已经得到的结果照样交回，下一个测试记为执行失败。调用方取消（`service.closed`）或页面调用 `close()` 时，正在运行的 Worker 随即结束。

提供页面的宿主要做两件事。第一，在 `assetsUrl` 提供 `pyodide.mjs`、`pyodide.asm.mjs`、`pyodide.asm.wasm`、`python_stdlib.zip` 和 `pyodide-lock.json`，带的包的 wheel 放在其下的 `packages/`；页面按 lockfile 核对 wheel 的 SHA-256 后才交给 Worker，Worker 的 `fetch` 只用这些文件应答，测试引入时从中加载。第二，给 Worker 脚本的响应头加 CSP `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'`。Worker 不继承页面 meta 里的 CSP，没有这个响应头时，Python 一句 `pyfetch` 就能读到后端连接的 token；Worker 启动时会确认 CSP 生效，否则拒绝运行。Web 与 Desktop 的做法见[开发指南](../../docs/development/README.md)。

### 在 Linux 沙箱里运行

Node 这边从包入口 `@repa/python-runner` 取用。`describeRuntime` 找到安装的 pyodide，按它的 lockfile 算出带的包要用的 wheel，`verifyPackages` 核对离线包，`SandboxRunner` 按需启动沙箱，`runTests` 按 `python.run` 的约定运行一批测试并交回与页面相同的结果，课程核对的 `verify` 任务也经它运行：

```ts
import { describeRuntime, SandboxRunner, verifyPackages } from "@repa/python-runner";

const assets = await describeRuntime();
await verifyPackages(assets);
const runner = new SandboxRunner({ assets });
const { loaded, tests } = await runner.runTests([
  { id: "a", prelude: "import pandas as pd", data: [], setup: "", program: "total = 1 + 1", captures: ["total"], doctest: [] },
]);
await runner.close();
```

`runTests` 与页面的不同只在于解释器的去留：所有测试在同一个解释器里依次运行，没有出问题的解释器留给下一次调用接着用；测试超时、失败或恢复解释器状态失败后结束这个沙箱，之后的测试换一个新的。计时和结果的归类与页面共用 [`src/test-results.ts`](src/test-results.ts)，超时按沙箱转发的阶段写明停在哪里。`starts` 是启动过的沙箱数，应等于 1 加上超时、崩溃和恢复失败的次数，调用方据此核对代价。沙箱建立不了时（不是 Linux、缺少 Landlock 或 libseccomp、Pyodide 起不来）抛 `SandboxUnavailable`；只看系统的那一项也可以用 `requireSandboxPlatform` 先查，别的系统上就不必准备和核对离线包，调用方应当报错或改经页面的 Worker 运行，不改用不受限的运行。

### 离线包

pandas、NumPy 等 wheel 不在 npm 包 pyodide 里。学习插件的 `npm run course:runtime` 调用本包的 `preparePackages`，把 `PYTHON_PACKAGES` 及其依赖的 wheel准备到 `packages/python-runner/.cache/pyodide/<版本>/`（`REPA_PYODIDE_PACKAGES` 可改位置）：`--from` 从已有目录复制，不给时从 jsDelivr 下载。两种方式都按 Pyodide 发行 lockfile 的 SHA-256 核对，沙箱使用前还会再核对一次。Web 开发服务器和开发时的 Desktop 也从这个目录取 wheel，位置由 `defaultPackagesDirectory` 给出。安装包里没有这个目录：wheel 复制在应用目录的 `pyodide/packages/`，主进程用 `REPA_PYODIDE_PACKAGES` 把它交给后端。缺包时的说明只对这个缓存目录提 `npm run course:runtime`，别的目录说安装不完整，因为学习者的机器上没有 npm。解释器和标准库来自 npm 包本身，由 npm 按 `package-lock.json` 里的摘要核对，这里不另外核对。

## 怎么实现

### 沙箱

系统 python3 运行 [`sandbox/launch.py`](sandbox/launch.py)，它先在内核层面设下限制，再 exec 成 Node，由 [`sandbox/runner.mjs`](sandbox/runner.mjs) 加载 Pyodide 和 `runner.py`。限制随 exec 一直保留到进程结束：

- 文件：只能读 `/usr`、动态链接器缓存、`/dev/urandom`、Pyodide 和 ws 包、`runner.py`、`sandbox/` 和逐个放行的 wheel 文件；只有 `/dev/null` 可写。只能执行 Node 本身和它的动态链接器（动态链接器能被用来启动 `/usr` 里的其他程序，它们受同样的限制）。
- 网络：不能创建 socket，也不能建立 TCP 连接。
- 进程：只能创建线程，不能创建进程；信号只能发给自己；不能调整别的进程的资源上限、优先级和调度。
- 资源：私有内存用 `RLIMIT_DATA` 限制在 2 GiB；沙箱里只有一个进程，线程的栈也算在内，这就是整个沙箱的上限。CPU 时间上限 600 秒。

这里不用 bwrap：Ubuntu 默认限制非特权进程使用 user namespace，没有专用 AppArmor 配置时 bwrap 建不了 namespace，而 Landlock 和 seccomp 普通用户就能用。限制建立不了时 `launch.py` 以退出码 70 结束，不会降级成不受限的运行。另外，`runner.mjs` 让 Python 的 `js` 模块只看到一个空对象，Node 也以 `--disallow-code-generation-from-strings` 启动，所以 Python 代码拿不到 `process`、`require`、`fetch` 和 `Function` 构造器；这一层减少意外和干扰，安全边界仍是上面的内核限制。页面这边的安全边界是 Worker 的 CSP，Python 的 `js` 模块同样只看到空对象。

### 按需加载

带的包是 Repa 的 Python 环境的一部分，与课程无关：课程核对的 `verify` 只用到标准库时，一个包也不加载。两个宿主运行每个测试之前，都先调用 `runner.py` 的 `test_packages`：它解析测试的前导、夹具、setup、程序、doctest 和 `verify` 的题面代码，找出 import 语句引入的带着的包（import 名到包名的对应由宿主按 lockfile 经 `configure` 交给它），DataFrame 夹具另要 pandas。宿主先发一条 `loading` 消息，再加载这些包，加载后调用 `track_libraries` 导入刚加载的 NumPy、pandas 并记下任务后要恢复的状态，然后才运行 `program_test`。判断写在 `runner.py` 里，两个宿主调用同一份，所以同一批测试在两边加载的包相同，结果里的 `loaded` 也相同；`loaded` 只看这一批测试引入了什么，不看解释器里先前是否已经加载过。

写在字符串里、运行时才拼出的 import（例如 `exec("import numpy")`）看不到，那样的包不加载，运行时报 `ModuleNotFoundError`。没有带的包（例如 scipy）不在对应表里，不会去加载，同样报 `ModuleNotFoundError`；Pyodide 发行版里有这个包也不会联网去取。Pyodide 的 `loadPackage` 加载失败时只调用回调、不抛错，两个宿主在它之后核对包确实加载上了，没有就以失败结束这个测试，不带着缺的包运行。

### 任务之间恢复什么

每个任务从全新的命名空间开始，先运行 `prelude`，再准备数据夹具，工作目录是空的。任务后，`runner.py` 恢复已加载的 pandas 与 NumPy 的选项、builtins、输出流与显示钩子、`sys.path`、环境变量、warnings 过滤器，取消挂起的 asyncio 任务，删掉任务在工作目录、`/tmp` 和根目录下新建的文件，并用系统熵给 `random` 与 `numpy.random` 重新播种，与新的解释器一样，各任务抽到的数互不相关。程序在 capture 求值和序列化时打印的内容，包括值被释放时 `__del__` 打印的，都收进这一项的输出，共用 64 KiB 的上限。

两个宿主都复用解释器，只为省去重新加载 Pyodide 和已加载的包的时间：Node 宿主一直沿用同一个，页面在一次调用之内沿用、每次调用换一个新的 Worker；恢复失败或任务超时后，两边都换新的解释器。已导入的模块不在恢复之列，任务对它们的改动会带到同一个解释器里的后续任务。

### 超时算谁的

程序、capture 求值和 doctest 运行的是被测的代码，在这些阶段超时是测试的结果。序列化 capture 的值会调用值自己的 `__repr__`、`__len__` 和迭代，也可能是被测的代码，所以归在 capture 下，同样算测试的结果。准备阶段运行的是课程给的前导、夹具和 setup，收尾运行的是 `runner.py` 自己，这两段超时和任何阶段的崩溃都算执行失败。三段各自计时：如果共用一份时限，被测代码用掉大半之后在收尾时到点，就会被错算成执行失败。

## 对模型的影响

无：本包只在页面和沙箱里运行 Python 程序并交回结果，不向模型注入提示、工具或上下文。

## 已知限制与暂缓

- 已导入模块的改动会带到同一个解释器里的后续任务。课程核对整门课共用一个解释器，一份候选程序给 pandas 打的补丁会影响之后的候选；判分时每次提交用新的 Worker，不受别的提交影响。随包课程没有这类改动：2026-10-30 记录了全部任务结束时留下的改动，只有新建的文件、`builtins._` 和库按需导入的模块。课程以后要教这类写法时，再为相关的候选换新的解释器；比较全部模块与类的属性也能拦下，但整门课核对会慢到约三倍，见[学习插件重做](../../.agents/notes/implemented/architecture/2026-10-30-learning-plugin-refactor.md)。
- `runner.py` 和协议还带着课程核对专用的 `verify` 任务（作答位的形状、WWPD 的显示约定、`PythonVerifySchema`）。它不在判分路径上；沙箱建不起来时课程核对改经页面的 Worker 运行，所以两个宿主都要能运行它。移出要让学习插件自带一份 Python 辅助代码，并决定怎样交给两个宿主，留到以后单独做。
- 预热的 Worker 只加载上一次调用引入的包。学习者做 Python 课的代码题之前，若页面刚运行过只用标准库的课程核对，第一次提交要在提交时加载 pandas（2026-11-15 在无界面 Chromium 里约 1.6 秒），之后照常预热。一个空间只有一门课，做课与上 Python 课交替出现的情况少，所以没有为它另设预热规则。
- 收尾时恢复状态抛出异常，结果照样交回；收尾卡住或解释器崩溃时，结果还在解释器里没有交出，这个测试记为执行失败。恢复运行的几乎都是 `runner.py` 自己的代码，又有单独的时限，这种情况基本只在运行器出错时出现，所以没有改成先交出结果再收尾。
- Node 宿主只能在 Linux 上运行，依赖 Landlock（ABI 4 以上，Linux 6.7 起）、libseccomp 和 `/usr/bin/python3`。Windows、macOS 上，应用里的课程核对经开着的页面的 Worker 运行；命令行没有页面，只能 `--no-run`。
- `RLIMIT_DATA` 只管进程私有的可写内存，没有 cgroup 级的整树限制，线程数只受内存间接限制。运行比课程核对更不可信的内容之前需要再评估。
