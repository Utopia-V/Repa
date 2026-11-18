# 测试版 v0.1.0-test.1 的学习数据与标准答案

这里冻结了第一个测试版留下的学习数据，以及测试版自己对这些数据算出的结果。以后改学习插件的持久格式、重放或课程组织时，[`test1-fixtures.test.ts`](../../test1-fixtures.test.ts) 用当时的代码打开同一份数据，在同一时刻取同样的读数，与这里的标准答案逐项比较。试用者手里的数据必须由新版本直接读出，过去的结论、XP 和学生模型不能因升级而变，这份数据就是这条要求的验收基准。

测试不通过时，不改标准答案，也不改测试去迁就：那说明新代码读测试版数据的结果变了，要找出是哪一项、由哪个提交引入，再判断这一变化是否可以接受。读数的取法可以随协议或内部结构改动（见下文“读数”），标准答案不改。

唯一的例外是给学习者看的说明文字：它不属于学习的含义，有意改写时在测试的 `REWORDED` 表里登记字段与改动的 PR，比较时两边都略去该字段。结论、时刻、XP、学生模型一类的读数不得登记。

## 怎样产生

数据和标准答案都由标签 `v0.1.0-test.1` 的代码产生，产品代码一行未改。

1. 在标签上另开工作树，取入合并 #168 带来的端到端走查（`git checkout "$(git log -1 --format=%H --grep='合并 #168：' dev)" -- scripts/verify package.json`；从标签到合并 #168 只加了走查，产品代码相同），再应用 [`tools/walk.patch`](tools/walk.patch)。补丁只改走查脚本：甲的课多一份很小的课件来源，做课的 Agent 多写一份 `AGENTS.md`，走查后面加了乙到戊四个空间的步骤；另有冻结与取数两个脚本，时钟可以停在给定的时刻。
2. `npm ci`、`npm run build:packages`，再运行走查（`npm run verify`，Pyodide 离线包用 `REPA_PYODIDE_PACKAGES` 指定）。走查在一个临时 HOME 的 `Repa/` 下依次产生五个空间，与试用者的布局相同，全程无界面，模型是本机的假模型。
3. `node scripts/verify/test1-freeze.mjs <走查目录> <这个目录>`：复制各空间与应用配置里的 `settings.json`，去掉空目录（Git 不保存空目录，数据以提交进仓库的样子为准），把本机绝对路径换成占位，并扫描一遍（含解压后的 `history.git` 对象），还有本机路径、用户名或 key 就报错。
4. 把 dev 上的 [`test1-readings.ts`](../test1-readings.ts) 与 [`test1-read.ts`](../test1-read.ts) 复制到标签工作树的同一位置，运行 `npx tsx --tsconfig scripts/verify/tsconfig.json scripts/verify/test1-capture.ts <这个目录>`，写出 `answers.json`。
5. 再把 [`test1-prefix-capture.ts`](../test1-prefix-capture.ts) 复制过去，在 `packages/learning` 下运行 `TZ=Asia/Shanghai npx tsx test/fixtures/test1-prefix-capture.ts <这个目录>`，写出逐前缀的标准答案 `prefixes.json.br`（见下文“逐前缀的读数”）。它只读这个目录里的数据，数据不变时可以单独重新产生。

取数文件随学习插件的内部结构改动，dev 上的版本不一定能在标签上运行。重新产生时用产生标准答案的那一版：`answers.json` 与 `prefixes.json.br` 的 `producedBy.readings` 记着它的 sha256，在 `git log -- test/fixtures/test1-readings.ts` 里找内容相同的那一版。

重新产生时，走查的时钟以运行当天上午 10 点为起点，所以日期和全部标准答案都会变；要整份重新产生，不能只替换其中一部分。

## 五个空间

都在 `home/Repa/` 下，空间名就是学习者起的课名。走查用的课（`scripts/verify/course/`）有 `os01`、`os02` 两个 topic；随包的 Python 课课程 id 为 `python`，共 48 个 topic。

| 空间 | 课程 id | 怎样产生 | 留下的情形 |
| --- | --- | --- | --- |
| 甲 `操作系统 走查` | `verify-walk` | 原有走查：起名建课，假模型做课、核对、换用；第一节故意答错一道填空；关闭再打开；在新会话里改正答案并换用，旧作答重判为对；第二节的开放题判分途中关闭再打开，补判为对；隔天复习；立即备份并导出 | 有 `AGENTS.md`（做课的 Agent 记下的学习者要求）、`materials/` 下一份很小的课件，课程清单的 `slides` 来源指向它 |
| 乙 `操作系统 复习` | `os-review` | 同一门课换了课程 id 和标题，topic 与题目编号与甲完全相同；第一节全对；第二节交上开放题时判分被扣住，关掉应用，再打开时没有可用的模型，开放题停在没判出，接着做完（`os02.k2.q2` 故意答错）；隔天接好模型再打开，开放题补判为对 | 两门课都有 `os01`、`os01.k1.q1`；第二节当天通过而没有 XP，隔天补判后这节课的 12 XP 记在第二天 |
| 丙 `Python 入门` | `python` | 新空间里选“学习自带的 Python 课”；py01 说一次“不会”仍通过；py02 答两题后中止；py02 两次停在 `py02.k1`（中间学完 py12） | 空间里没有 `course/`；强制补救：菜单只剩 py01 的复习 |
| 丁 `先学 Python 再学进程` | `os-basics` | 先选随包的 Python 课，py01 必做题全对，py02 答一题后中止；再在新会话里请 Agent 做一门自制课并换用；自制课第一节通过，第二节答两题后停在开放题上 | 换课以后测试版用自制课重放整段日志，Python 那一节的结论变为 `ended`，它的 20 XP 和学生模型里的 py01 都不再出现 |
| 戊 `Python 测验` | `python` | 选随包的 Python 课连学九节（要运行代码的题都说“不会”），课与复习的累计 XP 到 150 以后菜单出现测验；开始测验，答一题停下 | 测验待开始、进行中、超时三种状态 |

乙到戊的课由走查经后端的协议调用学习插件的方法来上（[`walk.patch`](tools/walk.patch) 里的 `test1-rpc.ts`），声明的能力与 Web 前端相同；标准答案取自课程文件，选项按交付事实的 seed 换成这次交付的编号。走查的界面助手只会作答选择和填空，随包课里的排序、表格与多空填空只能这样作答。这个连接不提供页面里的 Python，所以要运行代码才能判的题都说“不会”，判分当场记为错。

`snapshots/先学 Python 再学进程/python-only/` 是丁在做自制课之前整份复制的空间：之后换用课程改了学习记录以外的文件，所以那一刻的样子不能从最终数据里截出来。

## 文件

| 路径 | 内容 |
| --- | --- |
| `home/Repa/<课名>/.repa/plugins/learning/` | 学习插件的数据目录整份：`format.json`、`records.jsonl`，有自制课时还有 `course.json`、`building.json` 和换用的副本 `courses/<摘要>/` |
| `home/Repa/<课名>/course/`、`materials/`、`AGENTS.md` | 空间里的课、课件和学习者要求，有的空间才有 |
| `home/Repa/<课名>/.repa/sessions/` | 会话记录：做课、课程核对、判分等模型调用 |
| `home/Repa/<课名>/.repa/history.git` | 空间历史，各空间只有走查时的几次提交（共约 30 KB），以后的合并要用它测“搬动” |
| `home/Repa/<课名>/.repa/format.json`、`.ignore` | 空间的格式标记 |
| `repa-home/settings.json` | 应用配置，`recentSpaces` 列出五个空间 |
| `snapshots/` | 见上一节 |
| `marks.json` | 走查记下的时刻：各空间学习记录当时有几行、最后一条的时间 |
| `answers.json` | 标准答案 |
| `prefixes.json.br` | 逐前缀的标准答案，brotli 压缩的 JSON |
| `tools/walk.patch` | 产生数据所用的走查改动，相对于合并 #168 时的 `scripts/verify/` |

本机路径已换成占位：走查的临时 HOME 为 `/home/learner`，应用配置目录为 `/home/learner/.config/repa`，仓库根目录（会话里的提示提到插件说明的位置）为 `/opt/repa`。会话里的模型是假模型（提供方 `repa-verify`），没有任何真实的 key；`agent/models.json` 与 `auth.json` 不在其中。

体积：五个空间共约 680 KB，其中会话记录约 400 KB（主要是课程核对的子会话，每道题一份）；`answers.json` 约 300 KB。

## 读数

`answers.json` 的 `cases` 是 17 个取数点。每一项写明取哪个空间（或 `snapshot`）、学习记录只留前几行（`facts`，学习记录只追加，前缀就是当时盘上的学习记录；之后只追加了学习记录以外的会话和历史，学习插件不读它们）、有没有可用的模型、取数时刻 `at` 与它的上海时间。取数时进程的时区固定为 Asia/Shanghai，前端声明的能力与桌面端的 Web 前端相同（`capabilities`），插件的时钟停在 `at`。

| 取数点 | 时刻 | 看什么 |
| --- | --- | --- |
| `a-after`、`a-evening`、`a-later` | 复习做完一分钟后、当晚、三天后 | 甲的各项随时间的变化，三天后 os01、os02 都到期 |
| `b-day1-end`、`b-day1-evening` | 第一天结束时的日志，没有可用的模型 | 开放题没判出，这节课已通过而没有 XP |
| `b-after`、`b-later` | 隔天补判一分钟后、三天后 | 补发的 12 XP 记在第二天，今日 XP 为 12 |
| `c-after`、`c-evening`、`c-later` | 第二次停在 `py02.k1` 一分钟后、当晚、三天后 | 强制补救与失败的课 |
| `d-python-only` | 做自制课之前 | 只学过 Python 时：py01 通过、20 XP |
| `d-after`、`d-later` | 换用自制课、第二节做到一半以后 | Python 的结论与 XP 消失；任务停在作答画面 |
| `e-near-quiz` | 差一节课到门槛（143 XP） | 测验尚未出现 |
| `e-quiz-due` | 刚到门槛（161 XP） | 待开始的测验：第 1 场、抽到的 5 个 topic |
| `e-quiz-running` | 开始测验、答了一题 | 进行中的测验与截止时间 |
| `e-quiz-timeout` | 当晚 | 截止时间过后按超时结算，强制复习 |

每个取数点的 `reading` 按含义命名，不照搬协议的形状，以后协议改了也能比较：

| 字段 | 含义 | 来自 |
| --- | --- | --- |
| `serverNow`、`factCount` | 插件的时钟、学习记录的条数 | `state.get` |
| `course` | 正在学的课 | `state.get` |
| `progress` | 本地日期、时区、日目标、今日与累计 XP、学完的 topic 数、估计完课日期 | `progress.get` |
| `restriction` | 复习或测验期间的限制、能否问辅导、能否查内容 | `state.get` |
| `currentTask` | 当前任务：类型、topic、阶段、结论或中止原因、等待作答的交付、开始与截止时间、各知识点进度、出过的题（含课程里的题目 id）和每份作答的处理状态与显示的对错 | `state.get`，题目 id 取自学习会话 |
| `menu` | 菜单的候选、没有候选时的原因与恢复时间 | `state.get` |
| `building`、`autoExpand` | 做课的状态（课、各部分及其状态与出处、后台展开、做课的会话）与设置；花费不在其中，它由宿主汇总会话用量 | `building.get`、`settings.get` |
| `dailyGoal` | 学习者设定的日目标 | 重放 |
| `tasks` | 每项任务：类型、topic、选定与结束时刻、被下一项取代的时刻、结论（`passed`、`failed`、`timeout`、`unresolved`、`aborted`、`ended`，未结束为 `null`）与得出结论的时刻、各知识点进度、每份作答的题目、是否“不会”、最后一次判分及其时刻 | 重放 |
| `awards` | 每一笔 XP：哪项任务、多少、记在哪一刻、是否测验 | 重放 |
| `xp` | 累计 XP，以及触发测验所用的课与复习的累计 XP | 重放 |
| `student` | 学生模型里每个已学 topic 的各项量（`repNum`、`memory`、`speed`、`lastRepetitionDay`、`interval`）、此刻的 memory、是否到期，以及按这些量推出的到期时刻 | 重放 |
| `lessonProgress`、`lessonFailures`、`reviewFailures` | 课内继承的知识点进度、失败的课（停在哪个知识点、是否连续两次）、没通过的复习 | 重放 |
| `remediation`、`consecutiveReviews` | 强制补救的 topic 及其方式、连续复习的次数 | 重放 |
| `quiz` | 已开始的测验场数、待开始的测验（第几场、出现时的累计 XP、抽到的 topic）、进行中的测验（topic、开始与截止时间） | 重放与 `state.get` |

“重放”指测试版的学习插件打开空间时从学习记录重放出的状态（`LearningSession` 的 `replay` 与它叠加出的 `fold`），协议不直接给出。取法见 [`test1-readings.ts`](../test1-readings.ts)：插件经底座的插件宿主在进程内打开，模型由 `ModelTestDriver` 代替（取数时不发模型请求）。取数脚本对每个取数点另起一次标签上的后端，时钟同样停在 `at`，经协议取 `state.get`、`progress.get`、`building.get`、`settings.get`，与进程内的原样结果核对一致，才写下标准答案。

## 逐前缀的读数

17 个取数点只看几个时刻。`prefixes.json.br` 对每个空间（以及丁换课前的快照）学习记录的每个前缀，从 0 条事实到全部，各取两次读数：一次在前缀最后一条事实的时刻，一次在 25 小时以后、其间没有新的事实，这样跨过了本地日期，进行中的测验也过了截止时间。共 735 个前缀、1470 次读数，字段与上表相同，只少了做课的状态与设置（`building`、`autoExpand`，学习记录不影响它们）。课程取这个空间打开时实际用的那一门：丁的前缀用换用后的自制课读（测试版打开丁的数据就是这样读的），快照的前缀用随包课读。丁的部分前缀停在自制课里没有的知识点上，测试版此时读不出状态，读数记为报错原文。

取法见 [`test1-readings.ts`](../test1-readings.ts) 的 `readPrefixes`：每个前缀单独写一份学习记录，末尾加半行，学习记录就只读不写，打开时的补判不会写进去；读数直接取学习会话的 `view`，不经插件方法，也就不触发后台补判。前后两个前缀只差一条事实，比较报出最早不同的那一处，就知道是哪条事实之后读数变了。

原文约 13 MB，前后前缀的读数大半相同，压缩后约 65 KB。dev 在 2026-11-18 的代码（合并 #175 之后）读出的结果，除 `REWORDED` 登记的两处说明文字以外，与这里全部相同。

## 值得以后各步注意的情形

- 甲、乙两门课的 topic 与题目编号完全相同（`os01`、`os01.k1.q1`），只有课程 id 不同；丙、丁、戊三个空间的课程 id 都是 `python`。合并空间时按编号对应会相撞。
- 丙、丁（换课前）、戊学的是随包的课，空间里没有 `course/`，也没有 `course.json`、`building.json`。
- 丁换用自制课以后，测试版用当前的课重放整段日志：随包课的那一节结论由 `passed` 变为 `ended`，20 XP 和学生模型里的 py01 不再出现，菜单和进度只看自制课。这是测试版当时给出的读数，按“结果与测试版相同”的要求，以后的版本打开这份数据也应如此；要改变它，需要先决定并说明。
- 乙的第二节在第一天就通过，但开放题没判出时不发 XP；第二天补判为对，这节课的 12 XP 整笔记在第二天，第一天的今日 XP 只有第一节的 15。
- 戊的测验超时结算后，答错和没答的 topic 都进入强制复习，菜单只给其中一项复习。
