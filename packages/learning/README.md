# 学习插件：课程与持久记录

`@repa/learning` 提供课程格式、读取和检查、任务与提交的公开契约（`@repa/learning/protocol`），以及只记事实的学习记录、恢复命令和学生模型接入。第一门课“Python：读懂代码，说清需求”有 48 个完整 topic。当前默认接入上课、规则／开放题判分、复习、补救、菜单、申诉及[辅导与即时回顾](../../docs/development/learning-tutor.md)；[教学流程说明](../../docs/development/learning-flow.md)列出规则和 Python 服务接入边界。持久入口与接入方式见[学习记录说明](../../docs/development/learning-records.md)。

在仓库根目录运行 `npm run course:check` 检查全部课程；写课的要求和写法见[写课说明](courses/README.md)。

## 设计思路

课程内容和学习记录分开存放。课程是每个 topic 一个结构化文件，可以用编辑器改、用 git 管理、打包分享；学习者做过的事情作为事实保存到插件自己的只追加日志，按“题目 id 加版本”引用课程里的题，学生状态、进度和 XP 都从事实算出，见[学习记录说明](../../docs/development/learning-records.md)。

格式选 YAML，一个 topic 一个文件。讲解、题目和答案在同一个文件里，讲解是块文字里的 Markdown，题目是结构化数据；作者只学一种语法，Agent 也容易写对，git diff 按行就能看清。YAML 读出来之后先按 TypeBox schema 严格校验，不认识的字段直接报错，问题定位到文件的行和列。题目的写法贴近交互词汇的 `Item`：题面、五种作答位、选项和单元格的字段名都一样，只在作答位上多出答案、比较方式、核对程序和测试这些私有字段；投影成学生可见的题目时按白名单取字段，私有部分不会带出去。

题目版本（`questionVersion`）复用底座的 `contentVersion`（RFC 8785 规范化后的 SHA-256，写成 `sha256:<hex>`），只由学生看到的内容与判分方式决定：输入包括题面、作答位（含答案和判分规则）、解析、测试和用到的数据；按测试判的题还包括课程清单的运行前导 `runtime.prelude`，因为期望表达式和学习者的程序都在它之后运行。知识点归属 `measures`、`kind` 与检查专用的 `verify`、`manual`、代码题 `accepts/rejects` 都不进哈希，topic 末尾的 `verified` 也不进。改答案或代码题判分用到的前导会换题目版本，过去的作答据此重判；改归属不换版本。公开 `Item` 的 `version` 是另一个哈希（`itemVersion`），只覆盖作答前的公开题面，只改答案或解析时不变。

学习资格、补救和信用有不同的依据，因此格式分开保存它们：topic 的 `prerequisites` 只列直接先修，KP 的 `keyPrerequisites` 定位补救，topic 的 `encompassings` 独立声明带权覆盖，题目的 `measures` 记录直接考查的知识点。写法见[写课说明](courses/README.md#资格补救与信用分开写)，Python 课的 107 条原先修边与剩余疑点见[逐边核对](../../docs/research/python-course/relations-review.md)。

能用程序核对的答案，由作者写的 `verify` 程序独立算一遍，再按作答位自己的判分规则去判；代码题用判分的同一个入口去判参考答案、等价写法、常见错误写法和作答框里的初始代码。这些都在 Pyodide 314.0.7 里运行，与学习者运行代码的版本相同，不用本机的 CPython 和 pandas 代替。运行放在 [`@repa/python-runner`](../python-runner/README.md) 的 Linux 沙箱里，学习者在页面里运行代码用的也是这个包。

代码题的题目里只存答案本身：测试的期望表达式和参考解，不存算出来的值。值依赖运行环境（例如文字列在 pandas 3 是 `str`、在 pandas 2 是 `object`），所以判分时在运行学习者程序的同一个环境里、在程序之前当场算出期望值，再与程序的结果比较，不必保证“算值的环境与判分的环境相同”，课程文件换行符或运行器文件变了也不影响判分。

程序算不出答案的作答位（例如把一句要求填成字段）列进 `manual`。复习和测验题里的这些作答位由 `npm run course:confirm` 用一次隔离的模型调用独立再解：只给学习者看得到的题面，不给答案和解析，模型按作答位的格式作答，再用作答位自己的判分规则比对。一致时在 topic 文件末尾的 `verified` 段记下题目 id、核对范围版本、核对哈希、模型和日期；不一致的只列出来交给人看。记录不在题目里，所以几个人同时写不同的题不会互相冲突；记录绑定题面与判分定义，答案或运行依赖改变就要重新核对，单改信用归属仍可复用，`course:check` 对缺记录的题报 `manual_unconfirmed`。例题和练习不强制。

底座的交互词汇只管向用户要结构化的输入：题面、作答位、作答、只查结构的 `checkResponse` 和版本 `contentVersion` 都从 `@repa/base/protocol` 导入，与前端和对话询问用的是同一份。判对错、提交结果和“不会”归学习插件，是本包自己的公开约定，见下面的[公开约定](#公开约定)。模型调用也经底座的 Agent 运行时（`createAgentRuntime` 的单轮 `complete`，其中是 Pi 的模型接口）。本包因此依赖 `@repa/base`，`check`、`test`、`build` 和课程命令通过 TypeScript project references 更新底座及模型库，已是最新的工程直接跳过。

## 实现细节

### 公开约定

[`src/protocol.ts`](src/protocol.ts) 经 `@repa/learning/protocol` 导出，插件方法照着它返回，前端的学习组件照着它渲染。它只依赖 `typebox` 和 `@repa/base/protocol`，浏览器里也能用。作答的题目引用和结构问题列表直接取底座的 schema，不另行定义。当前任务、提交恢复、内容与测验的方法及审阅边界见[前端契约](../../docs/development/learning-protocol.md)；教学与内容方法已接入；测验、XP、日目标与 ETA 见[测验与进度说明](../../docs/development/learning-quiz-xp.md)。

| 名称 | 含义 |
| --- | --- |
| `Verdict` | `correct`、`partial`、`incorrect`；`ungraded` 是本来就不判，`pending` 是已保存、判分还没完成 |
| `Score` | `{ earned, max }` |
| `Judge` | 判分方式：`rule`、`tests`、`model`、`person`；来源与证据资格分开；确定的隔离模型判分可以参与课内推进，资格由后端的 `evidence` 给出 |
| `Mark` | 选项、单元格（`行 id/列 id`）或排列位置上的标记：`correct`、`incorrect`、`missed` |
| `TestResult`、`CriterionResult` | 代码题测试用例的结果（`hidden` 的只报结果）；按评分要点的反馈（`unsure` 表示判分方没有把握） |
| `SlotFeedback`、`Feedback` | 作答位一级和整题一级的反馈；`expected` 是参考答案，只在插件决定释放时出现；`Feedback.item` 指向作答时的题目和版本 |
| `LearnerResponse`、`checkSubmission` | 底座的作答加上 `dontKnow`。学习者说“不会”时不带作答，只查题目和版本；平常的作答交给底座的 `checkResponse` |
| `SubmitResult` | `rejected`：格式不对，没有记为作答，只交回问题列表；`recorded`：已记为一次作答，练习时通常带反馈，测验交卷前不带 |
| `readFeedback`、`readSubmitResult` | 前端宽松读取，用底座的 `readLenient`：不认识的字段丢掉，认识的字段类型不对时读取失败；不认识的 verdict 读作 `ungraded`，不认识的 judge 丢掉，标记、测试结果和评分要点里不认识的条目逐条丢掉 |

`learningMethods`、`LearningState`、`SubmissionReceipt`、`ContentRef` 的用法见[前端契约](../../docs/development/learning-protocol.md#实现细节)；代码题在前端运行用的 Python 服务 schema 在 `@repa/python-runner/protocol`，用法见同一份契约。`build` 同时把公开入口独立打包为浏览器 ESM，`build:protocol` 可以单独执行。

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
2. 交叉规则（[`src/check/rules.ts`](src/check/rules.ts)）：id 唯一、前缀正确且不在 `retiredIds` 中；先修与覆盖图分别检查引用、重复、自指和环；KP 关键先修属于先修祖先；题目直接考查的知识点存在、只在本 topic 内且不重复；完整 topic 的每个知识点有概念卡、讲解、例题、至少 3 道练习、复习和测验题池；复习和测验题至少有一个由程序判分的作答位，不含开放作答；一道题最多一个按测试判的作答位（多步代码题还不支持）；来源登记在清单里，用法在许可范围内；链接只用 `https:` 和 `repa:concept/`，概念引用指向存在的知识点；每个作答位要么有 `verify`、要么列进 `manual`、要么由测试负责；标准答案引用的选项、块和单元格存在；要按写法显示或比较的文字写成字符串，小表里的数保留写法（`001`、`1e3`、未声明 `float` 的小数都会报出）。
3. 标准答案自洽（[`src/check/questions.ts`](src/check/questions.ts)）：投影出的 `Item` 符合交互词汇；用标准答案拼出的作答能通过 `checkResponse`，并按判分规则（[`src/check/grade.ts`](src/check/grade.ts)）得满分；登记的错误答案确实判错；复习和测验题的 `manual` 作答位有当前题面、判分定义和运行依赖的核对记录，`verified` 里的记录指向本 topic 存在的题和作答位。
4. 运行核对（[`src/check/code.ts`](src/check/code.ts)）：核对实际加载的 Pyodide、Python 和包版本与清单一致；每个任务先运行清单 `runtime.prelude` 里的前导（本课是导入 `pd`、`np`），学习者在 Repa 里运行代码时用同一份；运行 `verify` 并判它算出的答案，`key` 里写的每个可接受值都要与算出的答案一致；代码题和 Parsons 题用判分的入口（见下面的[代码题的测试](#代码题的测试)）去判参考答案和 `accepts`，必须全部通过；`rejects` 和作答框里的初始代码必须至少错一个测试；期望值算不出来时报 `test_expect_failed`，执行环境出问题、得不出结论时报 `test_unavailable`。比较在沙箱外进行，超过一万个元素的值不截断比较，直接报“太大，无法比较”。核对不生成任何产物。

### 代码题的测试

[`src/code-tests.ts`](src/code-tests.ts) 是检查工具和判分共用的入口：`runCodeTests(run, plan, programs)` 用执行方 `run` 判若干份程序。执行方按 `@repa/python-runner/protocol` 的约定运行一批测试：判分时是 `frontendTests(host)`，经前端的 `python.run`，页面每次调用用一个新的 Worker；课程核对时是 Node 沙箱的 `runTests`，整门课一个解释器。以后学习者用自己装的 Python 时，再加一个按同样约定运行本机 `python` 进程的执行方。

带 `expect` 的测试各对应一个期望任务：程序为空串，在只有前导、夹具和 setup 的命名空间里依次对期望表达式求值，同一个测试里相同的表达式只算一次。第一次调用先运行全部期望任务，再运行第一份程序的测试，所以期望值与程序在同一个执行方里、并在程序之前算出，程序改不到它。判分只有学习者的一份程序，一次提交只调用一次执行方，不因算期望值多开 Worker；核对时参考答案之后的每份候选程序各调用一次执行方，沿用第一次算出的期望值。

每个测试的结论：比较通过为 passed；程序抛异常、capture 的值或打印、doctest 输出不符为 failed；程序、capture 求值或 doctest 阶段超时为 timeout；准备或收尾超时、执行环境失败、期望值算不出来、学习者的值太大无法比较为 unavailable，不算程序对错；整批停下后的测试为 not_run。一份程序有测试 failed 或 timeout 就判错，全部 passed 才判对，否则没有结论：判分时留待恢复，核对时报错。

两条路径用同一个入口、同一套比较和 `runner.py` 的同一条执行路径，同一道题、同一份作答的结论相同。前提是课程代码（期望表达式、夹具和 setup）结果确定、只读取而不改动运行环境，候选程序不改动已导入的模块：核对时整门课共用解释器、期望值只算一次，判分时每次提交在新的 Worker 里重新算。随包课程符合这些前提；[`test/grading.test.ts`](test/grading.test.ts) 拿小课程的代码题、Parsons 题和随包课程的一道 DataFrame 代码题，逐份比对两条路径的结论。

### 模型核对

[`src/check/confirm.ts`](src/check/confirm.ts) 把投影出的 `Item`（与学习者看到的同一份，不含答案、解析和核对程序）写成文字请求，系统说明只交代任务和输出格式；读回模型的 JSON 作答后先做 `checkResponse` 结构检查，再逐个 `manual` 作答位按判分规则比对。输出不合格式时重试一次，仍不行就记为“输出不合格式”交给人看。写回时只替换 topic 文件末尾的 `verified` 段，文件其余部分逐字不动。

新记录的 `scope: question-runtime-v1` 标明核对范围。`version` 是题目原有定义（题面、判分规则、解析、测试和实际用到的数据）加课程 `runtime` 的哈希，不含信用归属；运行前导缺省按空串处理。独立解题请求或判分语义变化时，应升级 `scope` 并重新核对相应证明。这样只改知识点归属时，已有独立解题证明仍可使用。旧的无 `scope` 记录保留原样：只有原算法重算哈希相同，且 `runtime` 与 [PR #48](https://github.com/Utopia-V/repa/pull/48) 合入时冻结的 Python 课程基线完全一致时才复用。原基线固定在核对入口旁边，不从当前清单倒推；实际 Pyodide 与 wheel 版本仍由完整 `course:check` 核验。

发给模型的是换过 id 的题目：单选多选的选项、排列块和表格选择格的 id 按出现顺序换成 a、b、c……（课程里的 id 可以带含义，例如 `faithful`，原样发出去等于告诉模型答案），模型的回答再换回课程里的 id 去判，报告和日志里的差异也写课程里的 id。多行代码选项原样缩进排在编号下面，选择格显示标签，带 `startLine` 的代码块每行前写行号。只有一列要填的表格，模型答 `{行 id: 值}` 也接受。

[`src/check/model.ts`](src/check/model.ts) 用 `--agent-dir`（默认系统配置目录下的 `agent/`，遵循 `REPA_HOME`）创建底座的 Agent 运行时，凭据由 Pi 从其中的 `auth.json` 读取。`--log` 的文件在发请求之前独占创建，已存在就报错，之后每道题有结果就写一行。写 topic 文件末尾的 `verified` 段时，并入的是写入那一刻磁盘上的记录，先写临时文件再改名，同一个 topic 上同时进行的核对不会丢掉对方的记录。

### 沙箱

运行核对用 [`@repa/python-runner`](../python-runner/README.md) 的 Linux 沙箱：Landlock 和 seccomp 限制读写文件、联网和创建进程，限制建立不了时检查报 `sandbox_unavailable`，不会改用不受限的运行。整门课共用一个解释器，测试按 `python.run` 的约定成批运行，与判分的执行路径相同：每个任务从全新的命名空间开始，先运行课程清单 `runtime.prelude` 声明的运行前导，任务后由 `runner.py` 恢复常被改动的全局状态；恢复失败或任务超时（准备、被测代码、收尾各默认 10 秒）才换一个新沙箱。检查结果的 `summary.code.interpreterStarts` 是启动过的解释器数，应等于 1 加上超时、崩溃和恢复失败的次数，测试按它核对代价。沙箱的限制和任务之间恢复哪些状态，见运行器包的说明。

课程清单决定要哪些 Pyodide 包，所以准备离线包的 `npm run course:runtime` 由本包提供：它把清单的 `runtime` 交给运行器包，由运行器包算出 wheel 及其依赖，准备到 `packages/python-runner/.cache/pyodide/<版本>/`（`REPA_PYODIDE_PACKAGES` 可改位置）。`--from` 从已有目录复制，不给时从 jsDelivr 下载；两种方式都按 Pyodide 发行 lockfile 的 SHA-256 核对，检查前也会再核对一次。

### 新增依赖

| 依赖 | 用途 |
| --- | --- |
| `yaml` 2.9.1 | 解析课程文件并保留行列位置；YAML 1.2 core schema，没有其他依赖 |

## 未完成项与待验证项

| 项目 | 现状与影响 | 接续 |
| --- | --- | --- |
| 学习者作答的判分 | 上课、规则／开放题和代码题判分、复习与菜单已接入；代码题经前端的 `python.run` 当场算期望值 | 见[教学流程](../../docs/development/learning-flow.md)与[学习记录入口](../../docs/development/learning-records.md) |
| 能否运行 Python | 菜单、交付和补判都按发起调用的前端是否声明 `python.run` 当场判断，几个前端同时连着时各自看到合适的菜单。测验的 topic 在门槛出现时按课程选定，不看调用方；开始时缺能力会报告缺项 | 需要时让测验选题也考虑学习者常用前端的能力 |
| 学习者的值太大 | 学习者的 capture 超过序列化上限（一万个元素或两万字符）时，这个测试没有结论，这份作答尚无证据，不阻塞任务；每次会话会自动再试一次，结果仍相同。容器子类可以自带 `size` 属性，所以“期望值完整而学习者的值超限”不能证明两值不同 | 由维护者决定是否定一条规则：超出可比较范围就判这个测试失败，并在反馈里说明 |
| 其他系统上的代码核对 | 运行器包的沙箱依赖 Linux 的 Landlock（ABI 4 以上，Linux 6.7 起）、libseccomp 和 `/usr/bin/python3`；Windows、macOS 只能 `--no-run` | 需要时另做；社区作者可以先做结构检查 |
| 候选程序之间的模块状态 | 任务后恢复命名空间、工作目录、临时文件、pandas 与 NumPy 选项等常见状态，并给随机数重新播种；但代码改动已导入模块（例如给 pandas 打补丁）、在 `/lib` 下写文件时，影响会延续到之后的候选和题目。随包课程没有这类代码；判分时每次提交用新的 Worker，不受影响 | 课程要教这类写法时，再为相关的候选换新的解释器，见[学习插件重做](../../.agents/notes/proposed/architecture/2026-10-30-learning-plugin-refactor.md) |
| 课程内容许可 | 清单写 `NOASSERTION`，本课程自写内容的对外许可尚未决定 | 维护者决定后改清单 |
| 模型核对的强度 | 每道题只请模型解一次。选择题有猜中的可能，模型和作者也可能有同样的误读；一致只说明题面能读出这个答案 | 需要更强的核对时，可以换模型或多次采样，或在试用中看学习者的作答 |
| 关系权重与资格疑点 | 正权重 0.5 是 Repa 的待校准假设；9 条覆盖置零，107 条资格边暂保留 | 维护者审阅[逐边核对](../../docs/research/python-course/relations-review.md)，后续研究校准权重 |
| 学习效果 | 题目和讲解只经过程序核对、模型核对和作者自查，没有学习者试做 | 试用后调整节奏、题量和难度 |

## 验证入口

`course:check`、`course:runtime`、`course:confirm` 运行前执行 `tsc -b tsconfig.build.json`，由 TypeScript 更新本包的 Node 产物和依赖。构建入口与同一 worktree 中并行任务的用法见[增量构建说明](../../docs/development/README.md#增量构建)。

在仓库根目录：

```sh
npm run course:runtime -- --from <离线包目录>   # 第一次准备 Pyodide 包
npm run course:check                           # 检查全部课程
npm run course:check -- --topic py17           # 只对 py17 运行代码核对
npm run course:confirm -- --dry-run            # 看要发给模型的核对请求；去掉 --dry-run 才真正调用
npm test --workspace=@repa/learning
```

测试在 [`test/`](test/)：`relations.test.ts` 覆盖纯先修、跳层补救、非祖先覆盖、独立环检测、退役 id 和信用／核对版本边界；`rules.test.ts` 用一份小课程逐项弄坏结构、先修、完整性、来源、链接、数的写法和标准答案；`items.test.ts` 覆盖判分、字面量比较、投影和内容版本；`protocol.test.ts` 检查“不会”的结构检查、反馈与提交结果的严格校验，并沿导入链确认公开约定只加载 `typebox` 和底座的交互词汇；`confirm.test.ts` 用假的模型输出检查核对流程：缺记录时检查不通过、一致时写入记录、不一致和输出不合格式时不记录、请求数不超过上限、题目改过后旧记录失效、请求里不带答案和解析、选项 id 换成不透明编号并换回、多行代码和选择格标签保留、记录并入磁盘上的最新内容、`--log` 文件已存在时在发请求前报错；`code.test.ts` 在 Pyodide 里核对小课程和随包课程，并检查答案错误、多写的可接受值、漏核对、忘写 input 的答案列、显示内容按 repr 核对、参考答案不过、错误写法或初始代码通过、Parsons 缩进错误、期望值算不出、超时和运行时版本不符都能报出，后一份候选程序看不到前一份留下的变量、文件和环境变量，整门课只启动一个解释器、超时后才多启动一个，核对不写任何产物；`code-tests.test.ts` 用替身执行方检查共用入口：期望任务排在第一份程序之前、同一次调用里运行，核对时每份候选程序各调用一次，超时按阶段归因，期望值算不出、学习者的值太大、结果缺项或不合约定时没有结论，执行方不守约时按服务失败处理；`grading.test.ts` 让判分经 `judgeAnswer` 和 `python.run`（由另一个 Node 沙箱按同一约定提供）判小课程代码题、Parsons 题和随包课程 `py17.k2.q3` 的参考答案、等价写法、初始代码和每种错误写法，结论与核对相同，一次判分只调用一次服务；课程文件换成 CRLF 换行后核对通过、题目版本不变、判分结论不变；学习者的程序设随机种子、写文件、改环境变量影响不到期望值。沙箱本身的限制和任务之间的状态恢复由运行器包的测试检查。学习记录、教学流程、测验与辅导的测试见各开发说明的验证入口，`learning-facts.test.ts` 覆盖答案或运行前导改正后的重判、没有证据时不阻塞也不记失败、从事实重算状态，以及每次作答写入字节数与重算次数的代价关卡。Pyodide 包没有准备好或这台机器建不了沙箱时，需要运行代码的测试会跳过并写明原因；设置 `REPA_TEST_REQUIRE_ENV=1` 时改为失败。
