# 学习插件：课程文件与检查

`@repa/learning` 目前提供学习插件的第一块：课程文件的格式、读取和检查，判分结果与提交的公开约定（`@repa/learning/protocol`），以及第一门课“Python：读懂代码，说清需求”的课程文件。课程有 48 个 topic，其中 py01、py12、py17 内容完整，其余 45 个只有名称、知识点、先修和来源。插件接口、学生模型、作答记录和调度还没有实现。

在仓库根目录运行 `npm run course:check` 检查全部课程；写课的要求和写法见[写课说明](courses/README.md)。

## 设计思路

课程内容和学习状态分开存放。课程是每个 topic 一个结构化文件，可以用编辑器改、用 git 管理、打包分享；作答证据和学生状态以后放进插件的 SQLite，按“题目 id 加版本”引用课程里的题。

格式选 YAML，一个 topic 一个文件。讲解、题目和答案在同一个文件里，讲解是块文字里的 Markdown，题目是结构化数据；作者只学一种语法，Agent 也容易写对，git diff 按行就能看清。YAML 读出来之后先按 TypeBox schema 严格校验，不认识的字段直接报错，问题定位到文件的行和列。题目的写法贴近交互词汇的 `Item`：题面、五种作答位、选项和单元格的字段名都一样，只在作答位上多出答案、比较方式、核对程序和测试这些私有字段；投影成学生可见的题目时按白名单取字段，私有部分不会带出去。

题目版本是内容哈希（RFC 8785 规范化后的 SHA-256，写成 `sha256:<hex>`），输入是学生看到什么、怎样判：题面、作答位（含答案和判分规则）、解析、测试和用到的数据。`kind`、`measures`、`uses` 这些元数据，以及只为检查而写的 `verify`、`manual` 和代码题的 `accepts`、`rejects` 不进哈希，topic 末尾的核对记录 `verified` 也不进。改一个标签或核对程序不会把同一道题拆成新版本，改答案或判分规则则一定会。

能用程序核对的答案，由作者写的 `verify` 程序独立算一遍，再按作答位自己的判分规则去判；代码题由参考答案、等价写法、常见错误写法和作答框里的初始代码各跑一遍测试。这些都在 Pyodide 314.0.7 里运行，与学习者运行代码的版本相同，不用本机的 CPython 和 pandas 代替。运行放在沙箱里：系统 python3 运行的 `sandbox/launch.py` 先用 Landlock 和 seccomp 限制自己，再 exec 成 Node 加载 Pyodide。Ubuntu 默认限制非特权进程使用 user namespace，没有专用 AppArmor 配置时 bwrap 建不了 namespace，而 Landlock 和 seccomp 普通用户就能用，所以这里不用 bwrap。

程序算不出答案的作答位（例如把一句要求填成字段）列进 `manual`。复习和测验题里的这些作答位由 `npm run course:confirm` 用一次隔离的模型调用独立再解：只给学习者看得到的题面，不给答案和解析，模型按作答位的格式作答，再用作答位自己的判分规则比对。一致时在 topic 文件末尾的 `verified` 段记下题目 id、版本、模型和日期；不一致的只列出来交给人看。记录不在题目里，所以几个人同时写不同的题不会互相冲突；记录绑定版本，题目一改就要重新核对，`course:check` 对缺记录的题报 `manual_unconfirmed`。例题和练习不强制。

底座的交互词汇只管向用户要结构化的输入：题面、作答位、作答、只查结构的 `checkResponse` 和版本 `contentVersion` 都从 `@repa/base/protocol` 导入，与前端和对话询问用的是同一份。判对错、提交结果和“不会”归学习插件，是本包自己的公开约定，见下面的[公开约定](#公开约定)。模型调用也经底座的 Agent 运行时（`createAgentRuntime` 的单轮 `complete`，其中是 Pi 的模型接口）。本包因此依赖 `@repa/base`，`check`、`test`、`build` 和课程命令运行前会先构建底座。

## 实现细节

### 公开约定

[`src/protocol.ts`](src/protocol.ts) 经 `@repa/learning/protocol` 导出，插件方法照着它返回，前端的学习组件照着它渲染。它只依赖 `typebox` 和 `@repa/base/protocol`，浏览器里也能用。定义照 2026-10-12 从底座移走的原文，只留学习用得上的；作答的题目引用和结构问题列表直接取底座的 schema，不另行定义。

| 名称 | 含义 |
| --- | --- |
| `Verdict` | `correct`、`partial`、`incorrect`；`ungraded` 是本来就不判，`pending` 是已保存、判分还没完成 |
| `Score` | `{ earned, max }` |
| `Judge` | 判分方式：`rule`、`tests`、`model`、`person`；`model` 判的反馈界面标明仅供参考，不更新学习状态 |
| `Mark` | 选项、单元格（`行 id/列 id`）或排列位置上的标记：`correct`、`incorrect`、`missed` |
| `TestResult`、`CriterionResult` | 代码题测试用例的结果（`hidden` 的只报结果）；按评分要点的反馈（`unsure` 表示判分方没有把握） |
| `SlotFeedback`、`Feedback` | 作答位一级和整题一级的反馈；`expected` 是参考答案，只在插件决定释放时出现；`Feedback.item` 指向作答时的题目和版本 |
| `LearnerResponse`、`checkSubmission` | 底座的作答加上 `dontKnow`。学习者说“不会”时不带作答，只查题目和版本；平常的作答交给底座的 `checkResponse` |
| `SubmitResult` | `rejected`：格式不对，没有记为作答，只交回问题列表；`recorded`：已记为一次作答，练习时通常带反馈，测验交卷前不带 |

课程检查里的规则判分（[`src/check/grade.ts`](src/check/grade.ts)）用的就是这里的 `Verdict`。

### 课程文件

| 文件 | 内容 |
| --- | --- |
| [`src/format/schema.ts`](src/format/schema.ts) | 课程清单、topic、知识点、概念卡、题目、作答位、数据夹具和测试的 schema |
| [`src/format/load.ts`](src/format/load.ts) | 读取 `course.yaml` 与 `topics/*.yaml`，校验 schema，核对清单与文件一一对应 |
| [`src/format/diagnostics.ts`](src/format/diagnostics.ts) | YAML 解析（不许锚点与别名），把 schema 错误转成带行列的中文说明 |
| [`src/format/markdown.ts`](src/format/markdown.ts) | 把 Markdown 字符串拆成内容块，找出链接 |

### 检查

`checkCourse()` 依次做四件事，所有问题都带英文错误码和中文说明：

1. 读取与 schema 校验。
2. 交叉规则（[`src/check/rules.ts`](src/check/rules.ts)）：id 唯一且前缀正确；先修指向存在的 topic、覆盖的知识点存在、图里没有环；完整 topic 的每个知识点有概念卡、讲解、例题、至少 3 道练习、复习和测验题池；复习和测验题至少有一个由程序判分的作答位，不含开放作答；来源登记在清单里，用法在许可范围内；链接只用 `https:` 和 `repa:concept/`，概念引用指向存在的知识点；每个作答位要么有 `verify`、要么列进 `manual`、要么由测试负责；标准答案引用的选项、块和单元格存在；要按写法显示或比较的文字写成字符串，小表里的数保留写法（`001`、`1e3`、未声明 `float` 的小数都会报出）。
3. 标准答案自洽（[`src/check/questions.ts`](src/check/questions.ts)）：投影出的 `Item` 符合交互词汇；用标准答案拼出的作答能通过 `checkResponse`，并按判分规则（[`src/check/grade.ts`](src/check/grade.ts)）得满分；登记的错误答案确实判错；复习和测验题的 `manual` 作答位有当前版本的核对记录，`verified` 里的记录指向本 topic 存在的题和作答位。
4. 运行核对（[`src/check/code.ts`](src/check/code.ts)）：核对实际加载的 Pyodide、Python 和包版本与清单一致；运行 `verify` 并判它算出的答案，`key` 里写的每个可接受值都要与算出的答案一致；代码题和 Parsons 题的参考答案、`accepts` 必须通过全部测试，`rejects` 和作答框里的初始代码必须至少错一个；期望值也在沙箱里算出。比较在沙箱外进行，超过一万个元素的值不截断比较，直接报“太大，无法比较”。

### 模型核对

[`src/check/confirm.ts`](src/check/confirm.ts) 把投影出的 `Item`（与学习者看到的同一份，不含答案、解析和核对程序）写成文字请求，系统说明只交代任务和输出格式；读回模型的 JSON 作答后先做 `checkResponse` 结构检查，再逐个 `manual` 作答位按判分规则比对。输出不合格式时重试一次，仍不行就记为“输出不合格式”交给人看。写回时只替换 topic 文件末尾的 `verified` 段，文件其余部分逐字不动。

[`src/check/model.ts`](src/check/model.ts) 用 `--agent-dir`（默认 `~/.repa/agent`）创建底座的 Agent 运行时，凭据由 Pi 从其中的 `auth.json` 读取。运行时在 `settings.json` 缺 `cacheWarming` 时会补上 `idle`；核对只是借用凭据，所以结束时若文件只多了这一项，就恢复原样，有其他改动则保留并提示。

### 沙箱

[`sandbox/launch.py`](sandbox/launch.py) 在内核层面设下这些限制：

- 文件：只能读 `/usr`、动态链接器缓存、Pyodide 和 ws 包、逐个放行的 wheel 文件和运行器文件；只有 `/dev/null` 可写。只能执行 Node 本身和它的动态链接器（动态链接器能被用来启动 `/usr` 里的其他程序，它们受同样的限制）。
- 网络：不能创建 socket，也不能建立 TCP 连接。
- 进程：只能创建线程，不能创建进程；信号只能发给自己；不能调整别的进程的资源上限、优先级和调度。
- 资源：私有内存用 `RLIMIT_DATA` 限制在 2 GiB；沙箱里只有一个进程，线程的栈也算在内，这就是整个沙箱的上限。CPU 时间上限 600 秒。

限制建立不了时以退出码 70 结束，检查报 `sandbox_unavailable`，不会改用不受限的运行。另外，[`sandbox/runner.mjs`](sandbox/runner.mjs) 让 Python 的 `js` 模块只看到一个空对象，Node 也以 `--disallow-code-generation-from-strings` 启动，所以 Python 代码拿不到 `process`、`require`、`fetch` 和 `Function` 构造器；这一层减少意外和干扰，安全边界仍是上面的内核限制。

[`src/sandbox/session.ts`](src/sandbox/session.ts) 启动沙箱、逐个发送任务（每行一个 JSON），单个任务默认 10 秒超时，超时就结束整个进程，下一个任务换一个新沙箱。每个 topic 用一个新沙箱；同一 topic 的任务共享解释器，每个任务用全新的命名空间，任务后恢复 pandas 与 NumPy 的选项、builtins、输出流、warnings 过滤器，并取消挂起的 asyncio 任务。任务留下的异步错误记在这个任务上，并换新沙箱。[`sandbox/runner.py`](sandbox/runner.py) 负责执行和把 Python 值序列化，判断对错在沙箱外。

pandas、NumPy 等 wheel 不在 npm 包里，`npm run course:runtime` 把它们准备到 `packages/learning/.cache/pyodide/<版本>/`（`REPA_PYODIDE_PACKAGES` 可改位置）：`--from` 从已有目录复制，不给时从 jsDelivr 下载；两种方式都按 Pyodide 发行 lockfile 的 SHA-256 核对，检查前也会再核对一次。解释器和标准库来自 npm 包本身，由 npm 按 `package-lock.json` 里的摘要核对，这里不另外核对。

### 新增依赖

| 依赖 | 用途 |
| --- | --- |
| `yaml` 2.9.1 | 解析课程文件并保留行列位置；YAML 1.2 core schema，没有其他依赖 |
| `pyodide` 314.0.7 | 判分运行时的解释器与标准库，版本与学习者端一致 |

## 未完成项与待验证项

| 项目 | 现状与影响 | 接续 |
| --- | --- | --- |
| 其余 45 个 topic | 只有骨架；`notes` 里带着原稿的题型建议和范围约束 | 下一个任务按写课说明生成 |
| 学习者作答的判分 | 这里只检查课程文件，并定下判分结果的公开约定。学习者的代码要在学习者端的沙箱里运行，判分、作答记录和学生模型还没有实现 | 插件接入任务 |
| 交付时的呈现 | 底座不再要求排列块由后端打乱、选项 id 不暗示对错，这些现在归本插件。交付题目时要打乱排列块和选项并记进尝试；课程文件里有的选项 id 带有含义（例如 `faithful`） | 交付任务；选项 id 的写法要和写课的任务一起定 |
| 反馈的宽松读取 | 约定只有严格校验。底座的通用宽松读取没有导出，前端读到更新版插件多出的字段时会读取失败 | 前端开始渲染反馈、插件和前端可能不同步时，请底座导出通用的读取，或在本包实现一份 |
| 其他系统上的代码核对 | 依赖 Linux 的 Landlock（ABI 4 以上，Linux 6.7 起）、libseccomp 和 `/usr/bin/python3`；Windows、macOS 只能 `--no-run` | 需要时另做；社区作者可以先做结构检查 |
| 内存与 CPU | `RLIMIT_DATA` 只管进程私有的可写内存，CPU 时间上限 600 秒；没有 cgroup 级的整树限制，线程数只受内存间接限制 | 课程检查够用；如要运行更不可信的内容再评估 |
| 同一 topic 内的模块状态 | 任务后恢复常见的全局状态，但代码改动已导入模块（例如给 pandas 打补丁）时，影响会延续到同一 topic 的后续任务 | 换 topic 时换新沙箱；需要更强的隔离时改为每题一个沙箱，代价是每题约 2.5 秒 |
| 课程内容许可 | 清单写 `NOASSERTION`，本课程自写内容的对外许可尚未决定 | 维护者决定后改清单 |
| 模型核对的强度 | 每道题只请模型解一次。选择题有猜中的可能，模型和作者也可能有同样的误读；一致只说明题面能读出这个答案 | 需要更强的核对时，可以换模型或多次采样，或在试用中看学习者的作答 |
| 学习效果 | 题目和讲解只经过程序核对、模型核对和作者自查，没有学习者试做 | 试用后调整节奏、题量和难度 |

## 验证入口

在仓库根目录：

```sh
npm run course:runtime -- --from <离线包目录>   # 第一次准备 Pyodide 包
npm run course:check                           # 检查全部课程
npm run course:check -- --topic py17           # 只对 py17 运行代码核对
npm run course:confirm -- --dry-run            # 看要发给模型的核对请求；去掉 --dry-run 才真正调用
npm test --workspace=@repa/learning
```

测试在 [`test/`](test/)：`rules.test.ts` 用一份小课程逐项弄坏结构、先修、完整性、来源、链接、数的写法和标准答案；`items.test.ts` 覆盖判分、字面量比较、投影和内容版本；`sandbox.test.ts` 检查沙箱确实读不到宿主文件、写不了文件、建不了进程、不能向别的进程发信号或调优先级、连不上本机端口，Python 拿不到 Node 的接口，任务之间恢复全局状态，并检查内存上限与超时；`protocol.test.ts` 检查“不会”的结构检查、反馈与提交结果的严格校验，并沿导入链确认公开约定只加载 `typebox` 和底座的交互词汇；`confirm.test.ts` 用假的模型输出检查核对流程：缺记录时检查不通过、一致时写入记录、不一致和输出不合格式时不记录、请求数不超过上限、题目改过后旧记录失效、请求里不带答案和解析；`code.test.ts` 在 Pyodide 里核对小课程和随包课程，并检查答案错误、多写的可接受值、漏核对、忘写 input 的答案列、显示内容按 repr 核对、参考答案不过、错误写法或初始代码通过、Parsons 缩进错误、超时和运行时版本不符都能报出。Pyodide 包没有准备好或这台机器建不了沙箱时，需要运行代码的测试会跳过并写明原因。
