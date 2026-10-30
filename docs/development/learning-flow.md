# 教学流程与判分

学习插件通过 `menu.select`、`task.advance` 和提交方法组织上课与复习。正式原答、采用判分和任务转换共用[学习记录入口](learning-records.md)；界面读取[学习契约](learning-protocol.md)恢复画面。

## 设计思路

一道练习答对以后，程序需要知道它是否独立完成，以及它改变了哪个 KP 的进度。因此，判分先回答原答是否正确，教学转换再结合接受记录中的事前帮助判断证据资格。辅助后的正确答案仍保留正确反馈，但不会计入连对；聊天、讲解和例题也不建立已学状态。

每个 KP 先展示讲解和例题，再进行练习。两次连续独立正确后进入下一 KP，每个 KP 最多尝试五次；第五次先检查两连对，全部 KP 通过才完成 lesson。这部分沿 MA 公开的课内规则，见[官网课内流程](https://www.mathacademy.com/how-it-works)和 [The Math Academy Way，第 397 页](https://www.justinmath.com/files/the-math-academy-way.pdf#page=397)。重试没有进一步推进时才补关键先修，也沿[公开的补救方向](https://www.mathacademy.com/how-our-ai-works)。

以下数值和完整调度策略属于 Repa 假设：失败后冷却 48 小时，重试保留已过 KP；复习最多五题、至少三对且最后两题连续对，限时 10 分钟；菜单最多三项，避免相近项，并在连续三个 reviews 后提供合法新课。复习期间关闭辅导和参考读取是维护者决定，与 MA 可查 lesson 的做法不同。

## 实现细节

### 任务、菜单与重算

`flow.ts` 装配插件方法，`flow-state.ts` 从日志提取任务与原答证据，`flow-menu.ts` 对学生模型库的完整候选应用教学资格。新课要求直接先修已学；到期本身不撤销资格。相同 topic、直接依赖或共享直接先修的候选不同列，仍合法的菜单项保留身份。失败冷却且没有其他任务时，菜单提供原因和最早恢复时间。读取状态时重新校验时间敏感的菜单资格；冷却在当天到期也会恢复候选，只有菜单变化或跨天时才保存，重复读取不重抽候选。

默认插件通过 `connectLearning` 的 `hooks.beforeRestricted(task)` 接入[辅导中止](learning-tutor.md)：程序先保存 `preparing` 和读取／辅导限制，再等待底座中止路径完成，随后开始计时与交付。准备失败后，`task.resume` 沿原任务身份继续。

复习使用开始决策保存的 seed 打散 KP 顺序，先轮流覆盖 KP，再补余题。交付优先未见题，耗尽时重复并标记。选项、排列块和选择格的排列使用服务端 `crypto.randomInt`，不从公开 revision 推导；排列、不透明 id 和私有映射一起冻结到日志，恢复直接读取这些记录，不重新洗牌。数据行顺序保持原样。

首次进入一轮强制重教时清除上一轮的 KP 进度和失败位置；这一轮失败后的重试保留已通过 KP，只重置未通过 KP 的尝试数和连对数。初始化、判分和重放都继承同一份本轮进度。

初学只在整节通过后调用 topic 级模型更新。lesson 首次通过质量取 1；review 通过取独立正确数除以有效题数，失败取 `max(0.2, 1 - 独立正确数/有效题数)`，无作答超时取 1。它们都是 Repa 假设。正式作答引起的更新以最后一份有效原答的接受时间为锚点，判分服务延迟不把旧表现当成新的表现。更新和预演都沿模型库默认配置，关闭隐式传播。严重逾期时，一次通过后仍到期就继续按实际状态调度。

截止时存在及时收下的待判原答，会先等待显式恢复；采用其结果后，先判断通过，再判断五次尝试失败；只有仍需继续作答时才判断超时。关闭空间不暂停计时，重新读取状态或请求中止时先完成到期终结，旧守卫收到携带终态的 `stale_state`；超时的模型更新时刻取原截止时间，使关闭后延迟打开不改变这次更新的锚点。规则题复用 `gradeSlot`；开放题经 `completeStructured`，只发送本题、原答、参考解与 rubric。服务失败、格式不合格和 `unsure` 保留为待恢复，不记为学习失败。

申诉先追加目标判分版本与原因，再重判原答。新的采用判分与重算投影一起追加，原答、旧判分、已选任务和交付保留。已选任务若失去先修资格，后续推进和新提交会报告 `stale_state`，学习者可以中止后重新选择。反馈页通过原提交定位已交付的 KP；重判使它之前的 KP 重新未通过时，同样阻止推进，而当前 KP 正常通过后仍可进入下一 KP。反事实重算使用记录副本，不改写原始日志。

历史重判也会改变补救路径：仍有已学状态的 topic 强制 review，失去已学状态的 topic 则转入 lesson；lesson 所需但尚未学会的先修一起进入补救。重放负责形成这份可执行要求，菜单与已选任务的开始检查共用 `topicEligible`，避免菜单提供自身资格检查必然拒绝的唯一任务。

### Python 内部执行边界

`repa-python-batch-v1` 的 schema 定义在 `@repa/python-runner/protocol`（[protocol.ts](../../packages/python-runner/src/protocol.ts) 的 `PythonCapabilitiesSchema`、`PythonBatchInputSchema`、`PythonBatchResultSchema`），Web 与 Desktop 用运行器包提供 `python.run`（#51、#52）。`python-execution.ts` 是薄适配层，只调用 `host.services.call("python.run", …)` 并核对结果：

- `kind: capabilities` 返回 `protocol`、实际 `runtime`、`runner` 摘要和 `freshInterpreter: true`。`runtime` 只比较 Pyodide、Python 和包版本：`prelude` 是课程给的输入，前端探测时并不知道它。
- `kind: execute` 携带原 `submissionId`、将采用的 `gradeRevision` 与有序 `tests`；每项包含唯一 id、program、prelude、setup、夹具、captures 和 doctest 输入，不包含期望表达式、期望值、参考解或 rubric。
- 返回同一提交身份与目标判分版本、实际 `runtime`、`runner`、新解释器保证和同序结果。每项状态为 `completed`、`timeout`、`failed` 或 `not_run`；超时和失败携带 `prepare`、`program`、`capture`、`doctest` 或 `cleanup` 阶段。
- 整批终止以后只允许剩余项为 `not_run`。学习者代码和被检查调用的超时形成判分，代码自身抛出的异常放在 `completed.result.error`。`failed` 表示执行环境失败，任何阶段都留待恢复；准备与收尾超时、版本不符、缺项及 `too_large` 同样留待恢复。

课程核对整门课共用一个解释器，依序运行每份候选程序的全部测试；任务之间由 `runner.py` 恢复状态，恢复失败或超时才换新的解释器，与判分在一批测试之内的做法相同。比较函数与正式判分共用。完整核对成功后原子生成课程根目录的 `expected.json`；只检查结构或限定 topic 时不发布产物。每道题的 binding 同时绑定题目与信用版本、测试、夹具、课程运行环境（包括 prelude）和 `runner.py` 内容摘要。加载课程时剔除缺项或版本失效的预计算结果；交付快照保存本题产物。

生产交付先探测服务语义。服务不满足内部批次接口，或者缺少有效期望值时，选题跳过代码题与带测试的 Parsons；某个 lesson 的未过 KP 无可用题时，不提供该 lesson。已交付后发生的服务故障则沿原 submission 恢复，不替换原答。

## 未完成项与待验证项

- #51 已用真实 Web Worker 走通探测和批次执行，课程题的参考解与 `expected.json` 比较一致，见 #51 的验证记录。Desktop（#52）同步同一份实现后需要在 Electron 里再走一遍。
- 辅导、内容授权读取和受限开始中止已接入，见[辅导说明](learning-tutor.md)；quiz、retake、XP、日目标与 ETA 已接入，见[测验与进度说明](learning-quiz-xp.md)。
- 真实学习体验及算法对后续表现的解释，仍需后续组合试用和实际作答资料。

## 验证入口

在仓库根目录运行学习包的 `check`、`test`、`build` 和完整 `npm run course:check`。课程核对及依赖 Python 的测试可通过 `REPA_PYODIDE_PACKAGES` 指向已有离线 wheel 目录。

`learning-flow.test.ts` 通过真实空间宿主和日志验证 py01、隔天复习、冷却、补救、菜单、独立资格、重判及关闭重开。`python-execution.test.ts` 验证批次顺序、版本、超时阶段、未执行项和比较失败分类。三处真实杀进程与残缺日志恢复继续由 `learning-records.test.ts` 覆盖。

运行测试时设置 `REPA_LEARNING_EVIDENCE=/absolute/directory`，会在新的 `counterfactual-*` 子目录保留反事实用例的原始 JSONL、删去关键作答的证据副本和同一决策时刻的菜单对照，供抽样复核。证据副本保留原 seq，仅供分析，不作为可直接追加的恢复日志。

2026-10-21 在 Ubuntu 24.04、Node.js 22.22.2、npm 12.0.2 下完成类型检查、构建和协议浏览器构建。学习包 125 项用例全部通过，包含全量课程核对；模型库 28 项通过。本轮新增 7 项回归用例，覆盖超时中止、反馈页申诉、重教重试、同日冷却到期、及时提交的即时／延迟判分以及私有随机排列恢复。课程 CLI 全量核对通过，覆盖 48 个 topic、962 道题、811 份 verify 和 1,479 次测试执行，两轮生成的期望值产物字节一致。打包预览确认包含 `expected.json` 和教学流程产物。
