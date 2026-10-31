# 学习插件

## 概述

`@repa/learning` 是 Repa 的学习插件：按课程安排上课、复习和测验，只记学习者的作答事实，学习状态从事实重算；包内还有课程格式、课程检查工具和随包的 Python 课。

## 怎么用

### 装配插件

底座按包根目录的 `repa-plugin.json` 加载本插件，插件 id 为 `learning`，入口是构建后的 `dist/plugin.js`。开发时在仓库根目录运行 `npm run dev:learning -- --home /absolute/repa-home`：它先构建库包，再加载本插件启动底座，只开放辅导 Agent `learning-tutor`，见[辅导说明](../../docs/development/learning-tutor.md#agent-与学习产品入口)。

在代码里装配时调用 `createLearningPlugin({ sources, connect })`。`sources` 是课程来源，缺省读随包的 Python 课；`connect` 换掉教学方法的装配，测试用它取回学习会话。插件打开时先核对数据目录的格式标记，再读入学习记录、重放出学习状态，见[学习记录说明](../../docs/development/learning-records.md#插件与接入)。

### 从前端调用

前端经底座的 `plugin.call` 调用学习方法，用 `@repa/learning/protocol` 的 `readLearningResult` 等入口宽松读取结果。这个入口只依赖 `typebox`、`@repa/base/protocol` 和 `@repa/python-runner/protocol`，浏览器里也能用。方法、状态、错误和 `python.run` 的约定见[前端契约](../../docs/development/learning-protocol.md)，判分反馈的类型见下文的[公开约定](#公开约定)。

### 写课与检查课程

随包的第一门课在 `courses/python/`，清单是其中的 [`course.yaml`](courses/python/course.yaml)；写课的要求和写法见[写课说明](courses/README.md)。写好以后，在仓库根目录检查：

```sh
npm run course:runtime -- --from <离线包目录>   # 第一次准备 Pyodide 包；不给 --from 时从 jsDelivr 下载
npm run course:check                           # 检查全部课程，最后打印 topic 数和题目数
npm run course:check -- --topic py17           # 只对 py17 运行代码核对，结构仍查整门课
npm run course:confirm -- --dry-run            # 看要发给模型的核对请求；去掉 --dry-run 才真正调用
```

课程命令运行前由 TypeScript 更新本包的 Node 产物及其依赖，构建入口见[增量构建](../../docs/development/README.md#增量构建)。课程有多少 topic 和题目，以 `course:check` 的输出为准。

### 学习行为的说明

插件的各项学习行为由开发说明分别记录：

| 行为 | 说明 |
| --- | --- |
| 学习记录、重放与补判、恢复命令、导出学习数据 | [学习记录说明](../../docs/development/learning-records.md) |
| 上课、复习、菜单、判分与 Python 执行边界 | [教学流程说明](../../docs/development/learning-flow.md) |
| 测验、换题重考、XP、日目标与完课估算 | [测验与进度说明](../../docs/development/learning-quiz-xp.md) |
| 辅导 Agent、内容读取与受限开始 | [辅导说明](../../docs/development/learning-tutor.md) |
| 前端调用的方法、状态与错误 | [前端契约](../../docs/development/learning-protocol.md) |

### 验证

在仓库根目录运行 `npm test --workspace=@repa/learning`。Pyodide 包没有准备好或这台机器建不了沙箱时，需要运行代码的测试会跳过并写明原因；设置 `REPA_TEST_REQUIRE_ENV=1` 时改为失败。下表列出课程格式、课程检查和判分入口的测试；学习记录、流程、测验和辅导的测试，见各开发说明的验证入口。

| 测试 | 检查什么 |
| --- | --- |
| `relations.test.ts` | 先修、补救与覆盖分开检查，退役 id 不复用，题目版本与核对版本各自的边界 |
| `rules.test.ts` | 用一份小课程逐项弄坏结构、先修、完整性、来源、链接、数的写法和标准答案 |
| `items.test.ts` | 规则判分、字面量比较、投影和两种版本 |
| `protocol.test.ts` | “不会”的结构检查，反馈与提交结果的严格校验和宽松读取，公开入口只加载 `typebox`、底座的交互词汇和运行器协议 |
| `confirm.test.ts` | 用假的模型输出检查模型核对：请求里不带答案和解析，选项编号换成不透明的再换回，记录的写入、并入与失效，请求数上限和 `--log` |
| `code.test.ts` | 在 Pyodide 里核对小课程和随包课程：各类错误都能报出，候选程序之间互不影响，整门课只启动一个解释器，核对不写产物 |
| `code-tests.test.ts` | 用替身执行方检查共用入口：调用顺序、超时归因、没有结论的情形和执行方守约 |
| `grading.test.ts` | 同一份作答经检查和判分得出相同的结论；课程文件换成 CRLF 后，题目版本和结论都不变 |
| `plugin-format.test.ts` | 数据目录的格式标记：新数据写当前版本，旧格式、坏标记和更新的版本都使插件停用，原数据逐字节保留 |

## 公开约定

底座的交互词汇只管向用户要结构化的输入：题面、作答位、作答、只查结构的 `checkResponse` 和版本 `contentVersion` 都从 `@repa/base/protocol` 导入，与前端和对话询问用的是同一份。判对错、提交结果和“不会”属于学习插件，定义在 [`src/protocol.ts`](src/protocol.ts)，经 `@repa/learning/protocol` 导出；作答的题目引用和结构问题列表直接取底座的 schema，不另行定义。插件方法照着它返回，前端的学习组件照着它渲染。

| 名称 | 含义 |
| --- | --- |
| `Verdict` | `correct`、`partial`、`incorrect`；`ungraded` 是本来就不判，`pending` 是已保存、判分还没完成 |
| `Score` | `{ earned, max }` |
| `Judge` | 判分来源：`rule`、`tests`、`model`、`person`。来源与证据资格分开，确定的隔离模型判分也可以参与课内推进，资格由后端的 `evidence` 给出 |
| `Mark` | 选项、单元格（`行 id/列 id`）或排列位置上的标记：`correct`、`incorrect`、`missed` |
| `TestResult`、`CriterionResult` | 代码题测试用例的结果（`hidden` 的只报结果）；按评分要点的反馈（`unsure` 表示判分方没有把握） |
| `SlotFeedback`、`Feedback` | 作答位一级和整题一级的反馈；`expected` 是参考答案，只在插件决定释放时出现；`Feedback.item` 指向作答时的题目和版本 |
| `LearnerResponse`、`checkSubmission` | 底座的作答加上 `dontKnow`。学习者说“不会”时不带作答，只查题目和版本；平常的作答交给底座的 `checkResponse` |
| `SubmitResult` | `rejected`：格式不对，没有记为作答，只交回问题列表；`recorded`：已记为一次作答，练习时通常带反馈，测验交卷前不带 |
| `readFeedback`、`readSubmitResult` | 前端宽松读取，用底座的 `readLenient`：不认识的字段丢掉，认识的字段类型不对时读取失败；不认识的 verdict 读作 `ungraded`，不认识的 judge 丢掉，标记、测试结果和评分要点里不认识的条目逐条丢掉 |

`learningMethods`、`LearningState`、`SubmissionReceipt`、`ContentRef` 的用法见[前端契约](../../docs/development/learning-protocol.md#实现细节)。规则判分（[`src/check/grade.ts`](src/check/grade.ts)）返回的也是这里的 `Verdict`。

## 课程格式

课程内容和学习记录分开存放。课程是每个 topic 一个 YAML 文件，可以用编辑器改、用 git 管理、打包分享；学习者做过的事情作为事实记在插件自己的数据目录里，按“题目 id 加版本”引用课程里的题，见[学习记录说明](../../docs/development/learning-records.md)。

### 文件与 schema

讲解、题目和答案写在同一个 topic 文件里：讲解是块文字里的 Markdown，题目是结构化数据。作者只学一种语法，Agent 也容易写对，git diff 按行就能看清。解析用 `yaml` 包：它保留行列位置，按 YAML 1.2 core schema 读取，本身没有其他依赖。课程文件不许用锚点与别名。读出来的内容先按 TypeBox schema 严格校验，不认识的字段直接报错，问题定位到文件的行和列。

题目的写法贴近交互词汇的 `Item`：题面、五种作答位、选项和单元格的字段名都一样，只在作答位上多出答案、比较方式、核对程序和测试这些私有字段。投影成学习者看到的题目时按白名单取字段，私有部分不会带出去。

| 文件 | 内容 |
| --- | --- |
| [`src/format/schema.ts`](src/format/schema.ts) | 课程清单、topic、知识点、概念卡、题目、作答位、数据夹具和测试的 schema |
| [`src/format/load.ts`](src/format/load.ts) | 读取 `course.yaml` 与 `topics/*.yaml`，校验 schema，核对清单与文件一一对应 |
| [`src/format/diagnostics.ts`](src/format/diagnostics.ts) | YAML 解析，把 schema 错误转成带行列的中文说明 |
| [`src/format/markdown.ts`](src/format/markdown.ts) | 把 Markdown 字符串拆成内容块，找出链接 |

### 题目版本

题目版本（`questionVersion`）复用底座的 `contentVersion`，只由学习者看到的内容和判分方式决定。知识点归属、题型和只为检查而写的字段（`verify`、`manual`、代码题的 `accepts` 与 `rejects`，以及 topic 末尾的 `verified`）都不进版本，所以改答案会让过去的作答按新答案重判，改归属不会。公开 `Item` 的 `version` 是另一个版本 `itemVersion`，只覆盖作答前的公开题面。两种版本各包括哪些内容，学习记录又怎样用它们决定是否重判，见[学习记录说明](../../docs/development/learning-records.md#题目版本)。

### 资格、补救与信用

学习资格、补救和信用依据不同，所以格式分开保存它们：topic 的 `prerequisites` 只列直接先修，决定能不能开始这节课；KP 的 `keyPrerequisites` 指出做不下去时从哪里补起；topic 的 `encompassings` 独立声明带权的覆盖关系，学生模型按它在 topic 之间传递信用（FIRe）；题目的 `measures` 记录直接考查的知识点。写法见[写课说明](courses/README.md#资格补救与信用分开写)，学生模型怎样使用这张图见[学习记录说明](../../docs/development/learning-records.md#课程来源与模型)。随包 Python 课迁到这套格式时对每条原先修边的判断，记录在[课程关系核对](../../docs/research/python-course/relations-review.md)。

## 课程检查

题目的答案要独立算一遍才可信。能用程序算的，由作者写的 `verify` 程序算出答案，再按作答位自己的判分规则去判；代码题用判分的同一个入口去判参考答案、等价写法、常见错误写法和作答框里的初始代码；程序算不出的作答位列进 `manual`，由模型只看题面独立再解。代码都在课程清单 `runtime` 声明的 Pyodide 里运行，与学习者运行代码的版本相同，不用本机的 CPython 和 pandas 代替。

### 检查什么

`checkCourse()` 依次做四件事，每个问题都带英文错误码和中文说明：

1. 读取与 schema 校验。
2. 交叉规则（[`src/check/rules.ts`](src/check/rules.ts)）：id 唯一、前缀正确且不在 `retiredIds` 中；先修图与覆盖图分别检查引用、重复、自指和环；KP 的关键先修属于先修祖先；题目直接考查的知识点存在、只在本 topic 内且不重复；每个 topic 的知识点数在 `MIN_KPS` 与 `MAX_KPS` 之间，完整 topic 的每个知识点有概念卡、讲解、例题、至少 `MIN_PRACTICE` 道练习、复习和测验题池；复习和测验题至少有一个由程序判分的作答位，不含开放作答；一道题最多一个按测试判的作答位；来源登记在清单里，用法在许可范围内；链接只用 `https:` 和 `repa:concept/`，概念引用指向存在的知识点；每个作答位要么有 `verify`、要么列进 `manual`、要么由测试负责；标准答案引用的选项、块和单元格存在；要按写法显示或比较的文字写成字符串，小表里的数保留写法（`001`、`1e3`、未声明 `float` 的小数都会报出）；doctest 不超过 `DOCTEST_LIMITS`。
3. 标准答案自洽（[`src/check/questions.ts`](src/check/questions.ts)）：投影出的 `Item` 符合交互词汇；用标准答案拼出的作答能通过 `checkResponse`，并按判分规则得满分；登记的错误答案确实判错；复习和测验题的 `manual` 作答位有当前题面、判分定义和运行依赖的核对记录，`verified` 里的记录指向本 topic 存在的题和作答位。
4. 运行核对（[`src/check/code.ts`](src/check/code.ts)）：核对实际加载的 Pyodide、Python 和包版本与清单一致；每个任务先运行清单的运行前导 `runtime.prelude`，学习者在 Repa 里运行代码时用同一份；运行 `verify` 并判它算出的答案，`key` 里写的每个可接受值都要与算出的答案一致；代码题和 Parsons 题用判分的入口（见下文的[代码题的测试](#代码题的测试)）去判参考答案和 `accepts`，必须全部通过，`rejects` 和作答框里的初始代码必须至少错一个测试；期望值算不出来时报 `test_expect_failed`，执行环境出了问题、得不出结论时报 `test_unavailable`。比较在沙箱外进行，超过运行器序列化上限（`runner.py` 的 `CELL_LIMIT`、`REPR_LIMIT`）的值不截断比较，直接报“太大，无法比较”。核对不生成任何产物。

### 代码题的测试

代码题的题目里只存答案本身，即测试的期望表达式和参考解，不存算出来的值：值依赖运行环境，例如文字列在 pandas 3 是 `str`、在 pandas 2 是 `object`。所以判分时在运行学习者程序的同一个环境里、在程序之前当场算出期望值，再与程序的结果比较。这样不必保证算值的环境与判分的环境相同，课程文件的换行符或运行器文件变了，也不影响判分。

[`src/code-tests.ts`](src/code-tests.ts) 是检查工具和判分共用的入口：`runCodeTests(run, plan, programs)` 用执行方 `run` 判若干份程序。执行方按 `@repa/python-runner/protocol` 的约定运行一批测试：判分时是 `frontendTests(host)`，经前端的 `python.run`，页面每次调用用一个新的 Worker；课程核对时是 Node 沙箱的 `runTests`，整门课一个解释器。以后学习者用自己装的 Python 时，再加一个按同样约定运行本机 `python` 进程的执行方。

带 `expect` 的测试各对应一个期望任务：程序为空串，在只有前导、夹具和 setup 的命名空间里依次对期望表达式求值，同一个测试里相同的表达式只算一次。第一次调用先运行全部期望任务，再运行第一份程序的测试，所以期望值与程序在同一个执行方里、并在程序之前算出，程序改不到它。判分只有学习者的一份程序，一次提交只调用一次执行方，不因算期望值多开 Worker；核对时参考答案之后的每份候选程序各调用一次执行方，沿用第一次算出的期望值。

每个测试的结论：比较通过为 passed；程序抛异常、capture 的值或打印、doctest 输出不符为 failed；程序、capture 求值或 doctest 阶段超时为 timeout；准备或收尾超时、执行环境失败、期望值算不出来、学习者的值太大无法比较为 unavailable，不算程序对错；整批停下以后的测试为 not_run。一份程序有测试 failed 或 timeout 就判错，全部 passed 才判对，否则没有结论：判分时留待恢复，核对时报错。

两条路径用同一个入口、同一套比较和 `runner.py` 的同一条执行路径，同一道题、同一份作答的结论相同。前提是课程代码（期望表达式、夹具和 setup）结果确定、只读取而不改动运行环境，候选程序也不改动已导入的模块：核对时整门课共用解释器、期望值只算一次，判分时每次提交在新的 Worker 里重新算。随包课程符合这些前提；[`test/grading.test.ts`](test/grading.test.ts) 拿小课程的代码题、Parsons 题和随包课程的一道 DataFrame 代码题，逐份比对两条路径的结论。

### 模型核对

复习和测验题里列进 `manual` 的作答位，由 `npm run course:confirm` 用一次隔离的模型调用独立再解；`course:check` 对缺少当前核对记录的题报 `manual_unconfirmed`，例题和练习不强制。[`src/check/confirm.ts`](src/check/confirm.ts) 把投影出的 `Item`（与学习者看到的同一份，不含答案、解析和核对程序）写成文字请求，系统说明只交代任务和输出格式；读回模型的 JSON 作答以后，先做 `checkResponse` 结构检查，再逐个 `manual` 作答位按判分规则比对。输出不合格式时重试一次，仍不行就记为“输出不合格式”交给人看。全部一致时，在 topic 文件末尾的 `verified` 段记下题目 id、核对范围、核对哈希、模型和日期；写回时只替换这一段，文件其余部分逐字不动。记录不在题目里，所以几个人同时写不同的题不会互相冲突。

新记录的 `scope: question-runtime-v1` 标明核对范围。`version` 是题目原有定义（题面、判分规则、解析、测试和实际用到的数据）加课程 `runtime` 的哈希，不含信用归属，运行前导缺省按空串处理；所以只改知识点归属时，已有的独立解题证明仍可使用，改答案或运行依赖就要重新核对。独立解题请求或判分语义变化时，应升级 `scope` 并重新核对相应证明。旧的无 `scope` 记录保留原样：只有原算法重算的哈希相同，且 `runtime` 与 [PR #48](https://github.com/Utopia-V/repa/pull/48) 合入时冻结的 Python 课程基线完全一致时才复用。原基线固定在核对入口旁边，不从当前清单倒推；实际的 Pyodide 与 wheel 版本仍由完整的 `course:check` 核验。

发给模型的是换过 id 的题目：单选多选的选项、排列块和表格选择格的 id 按出现顺序换成 a、b、c……（课程里的 id 可以带含义，例如 `faithful`，原样发出去等于告诉模型答案），模型的回答再换回课程里的 id 去判，报告和日志里的差异也写课程里的 id。多行代码选项原样缩进排在编号下面，选择格显示标签，带 `startLine` 的代码块每行前写行号。只有一列要填的表格，模型答 `{行 id: 值}` 也接受。

[`src/check/model.ts`](src/check/model.ts) 用 `--agent-dir`（默认是应用配置目录下的 `agent/`，遵循 `REPA_HOME`）创建底座的 Agent 运行时，经它的单轮 `complete` 调用 Pi 的模型接口，凭据由 Pi 从其中的 `auth.json` 读取。`--log` 的文件在发请求之前独占创建，已存在就报错，之后每道题有结果就写一行。写 `verified` 段时，并入的是写入那一刻磁盘上的记录，先写临时文件再改名，同一个 topic 上同时进行的核对不会丢掉对方的记录。

### 沙箱与离线包

代码核对用 [`@repa/python-runner`](../python-runner/README.md) 的 Linux 沙箱，沙箱建立不了时报 `sandbox_unavailable`，不改用不受限的运行。整门课共用一个解释器，测试按 `python.run` 的约定成批运行，与判分走同一条执行路径；任务之间由 `runner.py` 恢复常被改动的全局状态，恢复失败或任务超时才换一个新沙箱。检查结果的 `summary.code.interpreterStarts` 记下启动过的解释器数，应等于 1 加上超时、崩溃和恢复失败的次数，测试按它核对代价。沙箱限制了什么、任务之间恢复哪些状态、超时怎样归因，见运行器包的说明。

准备离线包的 `npm run course:runtime` 由本包提供，因为课程清单决定要哪些 Pyodide 包：它把清单的 `runtime` 交给运行器包，由运行器包算出 wheel 及其依赖，再下载或复制并核对，存放位置和核对方式见运行器包的[离线包](../python-runner/README.md#离线包)。

## 尚待查证的假设

学习流程和学生模型要用到许多数值和规则，Math Academy（MA）公开的资料只给出了其中一部分。没有给出的部分，Repa 先用简单的默认值，等真实作答和使用来校准或推翻。这一节逐条列出这些假设：它控制什么、出处是什么、什么证据会让它改变。数值只写在代码里，流程的在 [`src/parameters.ts`](src/parameters.ts)，学生模型的在 [`DEFAULT_MODEL_CONFIG`](../learning-model/src/model.ts)，这里只引用名字。

出处分三种：MA 公开，指官网、Justin Skycak 的书与文章或采访里给出的；Repa 猜测，指公开资料没有给出、由 Repa 先定的；研究结论，指本仓库研究得出的判断，其中学生模型的研究在未合并的研究分支 learning-model-research（2026-10-10）。MA 公开而直接照用的规则不列在这里，例如课内连对几题通过（`KP_PASS_STREAK`）、练满几题失败（`KP_MAX_ATTEMPTS`）、连续复习以后给新课（`REVIEWS_BEFORE_LESSON`）、复习不限时和测验没答的题算错，出处写在代码注释和教学流程说明里。课、复习、测验通过与失败规则的公开出处，2026-10-31 的一次调查逐条核对过：[官网 How It Works](https://www.mathacademy.com/how-it-works)、[How Our AI Works](https://www.mathacademy.com/how-our-ai-works)、[The Math Academy Way FAQ](https://www.justinmath.com/the-math-academy-way-faq/) 和 [Golden Nuggets #39 采访](https://www.justinmath.com/golden-nuggets-podcast-39/)。

要比较两组学生模型参数，用 `new Replay(course, model)` 按另一组参数重放同一份学习记录，再比较两边对到期和间隔的预测。

### 学生模型

| 名称 | 控制什么 | 出处 | 什么证据会改变它 |
| --- | --- | --- | --- |
| `dueMemory` | memory 降到多低算到期，也就是复习什么时候出现 | Repa 猜测；MA 只说降到“足够低”时到期 | 跨天复习的真实作答：到期时的独立正确率明显偏高，说明复习来得太早；明显偏低，说明太晚 |
| `fullCreditMemory` | 提前复习打多少折：memory 越高，这次复习给的信用越少 | Repa 猜测；MA 公开提前的复习要打折，折扣的形状没有公开；研究结论：提前折扣在 Junyi 数据上不可识别 | 提前复习与按时复习以后的保持表现 |
| `intervalBase`、`maximumInterval` | 理想间隔随 repNum 增长多快、最长多久 | Repa 猜测；MA 只说间隔能长到一年以上 | 跨天作答里间隔与之后独立正确率的关系；Junyi 数据的作答间隔太短，看不出长期保持 |
| `decaySlope` | 逾期越久，失败时 repNum 退得越多 | Repa 猜测；MA 公开这个倍数从 1 起、逾期越久越大，形状没有公开 | 严重逾期以后复习失败的学习者，之后的复习表现 |
| `initialSpeed`、`minimumSpeed`、`maximumSpeed`、`passSpeedStep`、`failSpeedStep` | speed 的起点、范围和每次显式复习以后的调整。测验每个 topic 只出一题，答错这一题就按 `failSpeedStep` 降速 | Repa 猜测；MA 按学习者能力与 topic 难度之比估计 speed，换算方法没有公开 | 同一学习者在不同 topic 上的复习表现；测验里答错一题的 topic，之后的复习是否确实更差 |
| 初学的起点 | 课通过时 repNum 与 memory 从零起，加上这节课的质量 | Repa 猜测；MA 没有公开新课完成时的初值 | 课后第一次复习的表现与课的质量的关系 |
| 多条路径取最大值（`repetitionWeights`） | 一次复习经几条包含关系传到同一个 topic 时给多少信用 | Repa 猜测；研究结论：多路径的合并规则在 Junyi 全权重图上不可识别 | 按题标出实际调用的组件技能，比较直接练习与隐式练习之后的表现 |
| memory 的含义 | memory 是调度量，界面和辅导不能把它当作会不会的概率 | 研究结论：换算成概率需要另作研究 | 跨天作答上 memory 与独立正确率的校准 |

### 信用传递（FIRe）

| 名称 | 控制什么 | 出处 | 什么证据会改变它 |
| --- | --- | --- | --- |
| 课程里 topic 的 `encompassings` 权重 | 学会或复习一个 topic 时，信用按多大比例传给它覆盖的已学 topic；失败时负信用按同样的比例传给覆盖它的 topic | Repa 猜测：随包 Python 课的正权重统一取同一个值，逐边依据见[课程关系核对](../../docs/research/python-course/relations-review.md)；MA 公开权重是实际练到的平均比例；研究结论：真实图、随机图和模型凭题目文字画的图对下一题的预测几乎相同，现有证据不支持靠未经验证的隐式信用压缩复习 | 隐式复习以后的独立表现：与显式复习以后相当，就保留或调高权重；明显更差，就调低或置零 |

### 课与复习

| 名称 | 控制什么 | 出处 | 什么证据会改变它 |
| --- | --- | --- | --- |
| `LESSON_COOLDOWN_MS` | 课失败以后多久才能重试 | Repa 猜测；MA 官方 FAQ 只说过几天再试 | 冷却长短不同时重试的通过率 |
| `KP_WRONG_LIMIT` | 同一个知识点答错几题，这节课就中止、算失败，之后照常冷却和补救 | Repa 假设。MA 公开答错太多会中止整节课（How Our AI Works），阈值没有公开；用户报告按整节课计，答错 3 到 4 题即中止。Repa 按知识点计：每个知识点各错一题、随即连对，说明学习正在发生；错误集中在同一个知识点，才说明没学会 | 被中止的课冷却以后重试的通过率；通过的课之后的复习表现 |
| `REVIEW_MAX_QUESTIONS`、`REVIEW_PASS_CORRECT`、`REVIEW_FINAL_STREAK` | 复习怎样算通过、出满几题算失败 | Repa 猜测；MA 公开典型的复习有几道题、答对答错的先后影响判定，完整判定没有公开 | 复习通过或失败以后的保持表现：判定过严时，没通过的复习之后也答得好 |
| 质量（`quality` 与 `FAIL_QUALITY_FLOOR`） | 课、复习、测验交给学生模型多大的信用：通过时取独立答对的比例，失败时取 1 减去这个比例、不低于下限 | Repa 猜测；MA 公开通过得越好信用越大，采访举例说勉强通过只值一部分，计算式没有公开；研究结论：质量曲线在 Junyi 数据上不可识别 | 质量不同的通过以后，下一次复习的表现；勉强通过的课会很快到期，要看这样的复习是否来得太早 |
| 求助以后答对不算独立 | 作答之前问过辅导或读过参考内容的作答不计入连对和独立正确 | Repa 猜测；MA 公开复习可以回原课查资料，但这样的正确不能直接当作独立回忆 | 求助以后答对的题，之后独立作答的表现 |
| 中止复习时的判定 | 学习者中止复习时，把没判出结果的作答和还没出的题都当作答对仍不能通过，才记失败并做失败更新；其他情形不更新学生模型，topic 照旧到期 | Repa 假设：复习不限时，中止是离开复习的唯一方式，已作答的照常计算；MA 公开的资料没有说中止复习怎样算 | 学习者借中止回避失败的迹象 |

### 测验与 XP

| 名称 | 控制什么 | 出处 | 什么证据会改变它 |
| --- | --- | --- | --- |
| `QUIZ_EVERY_XP`、`QUIZ_WINDOW_XP` | 测验多久出现一次，出现以后还能推迟多少 | MA 公开（官网与书），但 2026 年的一次采访给了另一个间隔 | MA 官方口径的更新；测验来得太密或太疏 |
| `QUIZ_DURATION_MS`、`QUIZ_TOPICS` | 测验限时与题量 | 时长取 MA 采访里的口述例子；题量是 Repa 猜测，MA 按预计用时决定题量 | 学习者实际用时与超时的比例 |
| 测验选题（`sampleTopics`） | 在学过、有测验题的 topic 里，先选以往测验（含换题重考）测过次数最少的，次数相同时按这一场的 seed 随机；补足的 topic 优先出学习者没见过的题 | MA 公开随机选一组多样的已学 topic，降低以往测过的、被其他可测 topic 覆盖的 topic 的优先级（How Our AI Works），降低多少没有公开；按测过次数排序是 Repa 的细化，被覆盖的 topic 还没有降低优先级 | 有 topic 长期测不到，或连续几场考到同一批 |
| repa-xp-v1（`MIN_PASS_XP`、`REVIEW_XP`、`QUIZ_XP`，课按 topic 的预计用时乘独立答对的比例） | 每项任务给多少 XP，测验也由课和复习的 XP 触发 | Repa 猜测；MA 公开 XP 大致等于专注学习的分钟数、按表现奖惩，计算式没有公开 | 学习者实际用时与所得 XP 的对比 |
| `DEFAULT_DAILY_GOAL_XP` | 默认的每日目标 | Repa 猜测 | 学习者普遍改成别的目标 |

### 菜单与完课估算

| 名称 | 控制什么 | 出处 | 什么证据会改变它 |
| --- | --- | --- | --- |
| `MENU_SIZE` | 菜单最多列几项 | Repa 猜测；MA 采访说菜单最多几项、通常更少 | 学习者觉得选择太少或太多 |
| 相近项不同列（`learningMenu`） | 同一 topic、有直接依赖或共享直接先修的候选不同时出现 | Repa 猜测；MA 公开要把相近的新概念错开，相似的判定方法没有公开 | 学习者混淆相近的内容 |
| 完课估算（`ETA_WINDOW_DAYS`、`ETA_MIN_ACTIVE_DAYS`） | 剩余课时除以最近每天平均的学习量，写成日期；学习量按 XP 计 | Repa 猜测；MA 公开按近期每天的 XP 估计完课时间 | 估计的日期与实际完课日期的偏差 |

### 研究中仍属假设的部分

学生模型的研究在 Junyi 数据上比较了几组参数和几种图，结论是上面的提前折扣、间隔曲线、逾期惩罚、质量曲线和多路径合并都还没有成为可以直接用于产品的参数；Junyi 的作答间隔太短，也确定不了长期间隔。研究里另外几项做法只用于离线比较，没有进入产品：按近期作答估计 speed 的权重与先验、能力与难度的换算、把初次单题答对当作学会、把每条日志当作一次复习、把先修边当作包含边。研究重新开始时，这些做法与删除的研究开关（缩放、指数、capped-sum 路径合并和关闭 speed 更新）一起从 git 历史取回。

## 对模型的影响

学习内容只经辅导 Agent `learning-tutor` 进入会话；此外，开放题判分和课程的模型核对是不进会话的单轮调用。下面的 token 数按一个汉字约 1 token、其余字符约 4 个 1 token 估算，实际随模型的分词而变，会话里的实际用量从底座的会话记录读取。

- 辅导 Agent 的命名提示段只交代辅导职责，约 150 token；它能用的 `learning_task`、`learning_search`、`learning_read` 三项工具的声明约 400 token，另有底座的 `read` 用于续取长输出。这两部分在会话中不变，位于提示缓存的稳定前缀里，工具声明见[工具目录](../../docs/generated/tools.md)。
- 视图写出当前任务与阶段、课内当前知识点的进度，以及学过的直接先修中记忆最弱的几个，通常两三行，约 60 至 100 token。底座只在视图内容变化时把它追加在用户消息之后；先修排序用最后一条事实的时间，状态不变时文字不变，不打乱提示缓存。
- 工具输出写成分行文字，进入会话历史：`learning_task` 一次约 100 至 750 token，随包课程里最长的题连同题解也只有几 KB；`learning_search` 按默认条数一页约 1,300 token；`learning_read` 写出所读内容的全文。超过底座上限的输出由底座保存全文，只把开头和结尾交给模型，见[处理工具输出](../base/README.md#处理工具输出)。
- 开着通用 Agent 时，它汇集各插件的工具，也看到这三项学习工具的声明，但没有辅导的职责段和视图；`npm run dev:learning` 不开通用 Agent。
- 开放题判分对每份作答发一次隔离的结构化请求，只含本题题面、作答、评分要点和解析，不带会话历史，也不进会话。`course:confirm` 是写课时用的核对工具，每道题单独发隔离的单轮请求，只含学习者看得到的题面。

## 已知限制与暂缓

- 课程的代码核对只能在 Linux 上运行，沙箱的要求见[运行器包的已知限制](../python-runner/README.md#已知限制与暂缓)；Windows、macOS 上只能用 `--no-run`，社区作者可以先做结构检查。
- 课程核对整门课共用一个解释器。候选程序改动已导入的模块（例如给 pandas 打补丁）时，影响会延续到之后的候选和题目；随包课程没有这类代码，判分时每次提交用新的 Worker，也不受影响。课程要教这类写法时，再为相关的候选换新的解释器，见[学习插件重做](../../.agents/notes/proposed/architecture/2026-10-30-learning-plugin-refactor.md)。
- 一道题最多一个按测试判的作答位，有先后关系的多步代码题还不支持，`course:check` 以 `multiple_code_slots` 报出；等模型出题需要时再实现，见[学习插件重做](../../.agents/notes/proposed/architecture/2026-10-30-learning-plugin-refactor.md#检查工具)。
- 模型核对每道题只请模型解一次。选择题有猜中的可能，模型和作者也可能有同样的误读；一致只说明题面能读出这个答案。需要更强的核对时，可以换模型或多次采样，或在试用中看学习者的作答。
- 随包课程的覆盖权重是待校准的假设，见[尚待查证的假设](#尚待查证的假设)。迁移时有几条原先修边保留了学习资格，覆盖权重却置零；这些资格是否收窄、类比性的复用能否给信用，尚待维护者审阅，逐条问题见[课程关系核对](../../docs/research/python-course/relations-review.md#未完成项与待验证项)。权重由后续研究校准。
- 题目和讲解只经过程序核对、模型核对和作者自查，还没有学习者试做；试用以后再调整节奏、题量和难度。
- 学习记录、教学流程、测验与进度和辅导各自的未完成项，见对应开发说明的“未完成项与待验证项”。
