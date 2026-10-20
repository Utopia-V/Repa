# 学习插件的前端契约

`@repa/learning/protocol` 提供任务画面、提交恢复、内容读取和 `python.run` 的 TypeBox schema、静态类型及宽松读取入口。当前交付的是供后端与 Aqua 审阅、共用的契约，方法处理器由学习记录、教学、辅导和测验任务接续实现。

## 设计思路

重新打开学习页面时，你需要知道正在做什么、答案是否收下，以及还能执行哪个操作。因此，界面查询一份完整的 `LearningState`，而不是从聊天消息推断进度。这份状态包含当前课程、任务、菜单、限制、服务端时间和进度；其中任务携带公开交付及已接受的原答，可以独立恢复测验画面。

答案被接受和判分完成是两个时刻。`Submission.processing` 把它们分开，`submissionId` 则把第一次提交、断线查询、继续判分和申诉关联起来。界面即使没有收到响应，也可以先确认这份提交的实际状态，再决定是否重交。后端负责把接受记录写好后才返回 `recorded`，把判分结果写好后才推进任务。

这些形状复用底座的内容块、`Item`、原答、结构检查及错误信封。学习协议只补充领域状态，不另建客户端、事件通道或运行时。公开入口的运行时依赖只有 TypeBox 和浏览器可用的底座协议；课程运行时、夹具和测试计划复用课程 schema，不复制第二套定义。

## 实现细节

### 调用与读取

经现有 `RepaClient` 调用：

```ts
import { readLearningResult } from "@repa/learning/protocol";

const raw = await client.call("plugin.call", {
  pluginId: "learning",
  method: "state.get",
  input: {},
});
const state = readLearningResult("state.get", raw);
if (state.ok) renderLearning(state.value);
```

`learningMethods` 登记每个方法的 `input` 和 `result` schema，`LearningInput<M>`、`LearningResult<M>` 从中推导。发送端用底座 `parse` 或 `Value.Check` 严格校验；读取端用 `readLearningResult`、`readLearningEvent`、`readLearningError`。Python 服务另有 `readPythonRunRequest` 和 `readPythonRunResult`。

宽松读取会去掉新增字段，保留认识的字段并检查类型；错误类型导致读取失败。不认识的 verdict 读成 `ungraded`，不认识的来源不显示。未知任务阶段使状态读取失败，界面应要求更新客户端，不猜测可执行操作。嵌套 `Item` 仍经 `readItem` 补齐能力要求，未知作答位不会被误读为可以提交的残缺题目。底座的宽松读取也支持可空对象和数值，例如空任务、未开始的计时与尚不可估算的 ETA；TypeBox 的枚举沿用字面量联合的类型检查和未知值处理规则。

### 状态与方法

所有时间都是服务端 Unix 毫秒。`revision` 是当前空间内学习状态的单调递增序号；可观察状态变化后递增，单纯刷新页面不重抽菜单。日进度另带本地自然日及 `timeZone`，完成率在 0 到 1 之间，`etaDays: null` 表示当前没有足够依据显示估算。

| 方法 | 输入与结果 |
| --- | --- |
| `state.get` | 空输入，返回 `LearningState`，包括课程、任务、菜单、限制和进度 |
| `menu.select` | `menuId`、`candidateId`，选择 lesson 或 review 并返回当前状态 |
| `task.advance` | `taskId`、`expectedStage`、`expectedRevision`，从讲解到例题、练习或后续阶段，返回状态 |
| `task.resume` | 同一组任务守卫，继续 `preparing` 的受限开始步骤，返回状态 |
| `task.abort` | 同一组任务守卫，中止当前任务，返回状态 |
| `submission.get` | `submissionId`，返回 `absent` 或 `found`、当前 revision；后者包含完整 `Submission` |
| `submission.submit` | `taskId`、`deliveryId`、预留的 `submissionId` 和 `response`，返回 `SubmissionReceipt` |
| `submission.resume` | 原 `submissionId`，继续待恢复判分，返回同一提交的 receipt |
| `submission.appeal` | 原 `submissionId`、`expectedGradeRevision` 和申诉原因，重判原答，返回 receipt |
| `content.search` | `query`、`offset`、`limit`（最多 20），搜索当前任务和已学内容，query 也可填 topic/KP id 以解析概念链接；返回短命中、版本引用、原学习位置及可空 `nextOffset` |
| `content.read` | `refs`（最多 8）、块 `offset`、`limit`（最多 64），按版本批取讲解、例题、卡片、KP 或已释放解析 |
| `content.open` | `ref`，记录实际打开，返回服务端 `openedAt`；重复打开保留为查看行为，不改变掌握证据 |
| `quiz.start` | `menuId`、`candidateId`，经受限开始路径进入测验，返回状态 |
| `quiz.finish` | 任务守卫，整场交卷并返回状态；重试先查询，已结束场次沿原身份返回既有结果 |
| `quiz.retake` | `menuId`、`candidateId`、`originalTaskId`，开始菜单提供的重考，返回状态 |
| `progress.get` | 空输入，返回 `serverNow` 和日目标、XP、完成率、可空 ETA |
| `progress.setGoal` | 正整数 `dailyGoalXp`，返回更新后的状态 |

`LearningTask.phase.stage` 区分 `preparing`、`explanation`、`example`、`awaiting_answer`、`judging`、`recovery`、`feedback`、`completed` 和 `aborted`。讲解和例题直接带当前内容页；作答阶段引用 `deliveryId`；判分、恢复与反馈阶段引用 `submissionId`。交付还明确携带 topicId 与 kpId，界面不从不透明题目 id 猜所属知识点；其他细节从同一任务的交付、提交和 KP 进度取回。任务完成后可以与新菜单同屏，`task: null` 则表示当前没有任务。

任务守卫同时检查阶段和 revision。阶段会反复出现，因而只比较阶段名不足以挡住旧画面的重传。重复交卷沿已结束任务身份返回既有状态；其他陈旧操作返回刷新所需的当前状态。测验交付按 `deliveries` 的顺序显示，`submissions` 表示已锁定的原答，尚未接受的交付仍可作答。开始时间和整场截止时间都由后端保留，断线或关闭不暂停；按服务端接受时刻 `< deadlineAt` 判断及时，及时接受的待判提交在交卷后仍可继续处理。

### 提交身份与反馈资格

插件签发 `taskId`、`menuId`、`deliveryId`，并在每次交付时预留一个 `submissionId`。前端沿用这些身份，不自行给重试生成新 id。一次交付只接受一份原答；同 submission id、同载荷返回已有状态，不同载荷报冲突。判分等待期间释放串行入口，重复调用合并到已有处理，不重复推进或奖励。

`SubmissionReceipt` 延续原来的两个结果：`rejected` 表示结构不合格、没有接受，附 `processing.status: not_accepted` 和问题列表；`recorded` 表示原答已接受，附完整 `submission`。旧的 `SubmitResult` 与读取入口继续可用，新方法使用 `SubmissionReceipt`，通过 `readLearningResult` 读取。

接受后的处理状态依次可以是 `accepted`、`pending`、`interrupted`、`completed`。中断原因区分重启、服务失败、判分不确定和取消。它们不是新的学习失败证据。断线造成 outcome unknown 时先调用 `submission.get`：查到提交就沿它恢复；`absent` 才允许携原答、原 id 再交，后端仍重新检查交付和截止时间。查询与日志重放本身不重启判分。

`gradeRevision` 关联同一原答的采用判分版本。申诉检查 `expectedGradeRevision`，串行登记本次重判后再执行；重复请求等待已有重判，已采用新版本后再收到旧请求则刷新当前状态。旧判分、旧奖励和已经展示或选定的任务由后端记录保留，不因申诉覆盖。Python 请求里的 grade revision 指向这次将要形成的判分版本。

`Judge` 只说明来源。反馈中的 `evidence.status` 由后端给出：`eligible` 可以作为推进证据，`ineligible` 不具资格并可说明原因，`unresolved` 尚待处理。确定的隔离模型判分可以具备资格；前端不根据 `judge: model` 自行降级，也不把缺失的 evidence 推断为合格。独立正确还受提交前帮助等教学条件约束，由后端统一判断。

`dontKnow: true` 仍使用原 Item 引用和空 `answers`；practice 和 review 可用。后端依据交付模式拒绝 quiz 的 `dontKnow`，前端在 quiz 不显示该按钮；测验未答由整场交卷或超时表示。

### 公开内容与能力

交付中的 `item` 只允许底座公开字段。后端沿现有 `publicItem` 的白名单投影，并在交付时换成不透明的题目、选项、排列块和表格选择格 id，私有映射只保存在后端快照。前端不重新打乱顺序。当前协议与夹具表达最终公开形状，实际换号与持久化由教学和记录实现承担。

答案、解析和私有 rubric 不出现在作答前的 Item。practice 的反馈及解析在判分完成后释放，review 在任务结束后释放，quiz 与 retake 在整场交卷或超时后释放。查询、事件、前端内容读取和 Agent 工具共用这项授权检查。`processing: completed` 可以先于反馈释放，因此前端不能把“已判”当成“可看答案”。测试计划中的检查代码对前端可见，完整参考解仍按反馈时机释放。

`restrictions.tutorAllowed` 和 `referenceContentAllowed` 表示当前允许的行为。review、quiz 的 preparing 和进行阶段均关闭辅导与参考读取，结束后重新开放。`ContentRef` 带课程、topic、可选 KP、内容身份、版本和种类；`ContentPage` 带块范围、总块数和原学习位置，概念卡因此能回到原例题。读取旧内容使用指定版本，后端从交付快照或保留的学习内容提供它；不存在的版本明确报输入错误，不悄悄换成最新版本。

后端在交付前调用 `missingDeliveryCapabilities(context.caller?.capabilities, delivery)`。它复用 `canRender`，并为代码题补查 `python.run`；带测试的 Parsons 在 `requiresServices` 声明该服务。缺任何能力都返回缺项并保留原任务，等待可用连接，不换一道题来掩盖前端缺口。

### 事件与错误

底座 `plugin.event` 的 `pluginId` 为 `learning`，`event` 是 `LearningEvent`。事件只有类型、revision 和 task/menu/submission 身份，没有题面和答案。收到更新或重连时重新查询；丢事件不影响恢复，也不把事件当成状态增量。

处理器抛底座 `RepaFault(code, message, details)`，使用原有 JSON-RPC 错误信封；客户端从 `RpcError.data` 读取 code 和 details。`LearningErrorDetailsSchema` 描述 details，不包第二层错误：

| code | details.reason 及处理所需内容 |
| --- | --- |
| `invalid_input` | `invalid_structure`，附结构问题列表 |
| `stale_state` | `stale`，附当前完整 state，替换旧画面后再决定操作 |
| `submission_conflict` | `payload_conflict`，附 submission id，查询原答而不是覆盖 |
| `missing_capability` | `missing_capability`，附 missing 列表及 task id，保留任务等待可用前端 |
| `restricted` | `restricted`，附 task id 和 stage，按当前限制恢复界面 |
| `service_failed` | `service_failure`，附 service 和 retryable；先查询提交的持久状态，再决定恢复 |

### python.run

后端经 `host.services.call("python.run", request)` 发 `PythonRunRequest`，前端在 Web Worker 中运行课程锁定的 Pyodide **314.0.7**，回 `PythonRunResult`。领域请求的 `executionId` 用于识别实际执行尝试；delivery、submission、Item、slot 和目标 grade revision 都随请求与结果携带。后端接收时核对全部关联字段、运行时版本，以及每个请求测试 index 恰好返回一次，拒绝迟到或串题的结果。

请求的 `runtime` 包含 Python、包版本及 prelude；`fixtures` 和 `tests` 复用课程格式，`data` 给出测试未指定时的夹具。`program` 标明普通代码或后端按原答组装的 Parsons 代码，不含参考解。每个测试遵循现有检查器的次序：

1. 初始化规定运行时，核对实际版本，并加载所需包。准备好后才开始单次求值计时。
2. 在新命名空间执行 prelude、所选夹具和测试 setup，独立求值 expect 右侧表达式，序列化成 expected。
3. 在另一个新命名空间重做相同准备，运行学习者程序，再求值 expect 左侧表达式，收集 actual captures、stdout 和 doctest 的交互输出。doctest 输入的解析沿现有 `parseDoctest`，返回项与解析后的输入顺序相同。
4. 后端用现有 `sameValue`、`sameDoctestOutput` 比较值与输出，形成判分。前端不返回“正确”或自行决定证据资格。

`expected` 和 `actual.captures` 按表达式索引，每项为 `{ value }` 或 `{ error: { type, message } }`。value 是 `runner.py` 的 `canon()` 带标签记录，作为不透明数据传输，例如 `{ t: "int", v: "3" }`；整数、浮点、NaN、容器和表格都不转换为 JS 数值或显示字符串后再比较。

`PYTHON_RUN_LIMITS` 固定 Repa 工程参数：每次期望求值或原答运行最多 10 秒，包含其命名空间准备；值最多 10,000 个元素、深度 30、字符串或 repr 最长 20,000，单次输出最多 65,536 字符。超过值限制返回现有 `too_large` 标签，不截断后比较。它表示当前测试无法形成可靠比较，应待恢复／修正测试，不据此把学习者判错。

原答的异常放在 `actual.error`，原答超时为 `student_timeout`，二者可以形成学生代码失败。运行时初始化、版本不符、夹具/setup 或期望求值失败属于环境问题：分别返回整体 `unavailable` 或该测试的 `environment_failure`，后端保留待恢复。期望 captures 的 error 同样按环境问题处理。Worker 意外结束不能自动归为学生超时，只有明确在原答运行期限耗尽时才使用 `student_timeout`。

底座通知 `service.closed` 时，前端结束对应执行并销毁 Worker，不再提交结果；调用方取消、断线和初始化失败也不能形成学习失败证据。每次重试生成新的 execution id，但沿原 submission 和目标判分版本继续。前端沙箱执行、取消以及后端形成判分仍待双方接入。

## 未完成项与待验证项

| 项目 | 当前范围与接续 |
| --- | --- |
| Aqua 审阅 | 待核对各阶段画面、操作、原学习位置及 Python 请求／结果夹具；审定后的字段供前后端共用 |
| 方法与授权检查 | 记录任务实现接受、去重、日志与恢复；教学任务实现推进、换号、反馈释放和判分；辅导与测验任务接入限制、内容和进度 |
| Python Worker | 当前提供载荷和比较兼容夹具；Aqua 接入 Pyodide Worker，并与后端核对隔离求值、失败分类、上限和取消 |
| 故障与学习效果 | 真实杀进程恢复由记录任务验证；完整学习体验、实际作答改变帮助及学习外负担由后续组合试用检验 |

## 验证入口

在仓库根目录运行：

```sh
npm run check --workspace=@repa/base
npm test --workspace=@repa/base
npm run build --workspace=@repa/base
npm run check --workspace=@repa/learning
npm test --workspace=@repa/learning
npm run build --workspace=@repa/learning
npm run build:protocol --workspace=@repa/learning
```

[`learning-contract.test.ts`](../../packages/learning/test/learning-contract.test.ts) 检查严格发送、宽松读取、能力缺项、错误细节、恢复和 Python 比较形状，并用 esbuild 的 browser 平台独立打包公开入口。[连续夹具](../../packages/learning/test/fixtures/learning-contract.ts) 覆盖 lesson 原答、待判、重连待恢复、完成、菜单、受限测验、已答与截止时间，以及结束后可打开的概念卡。夹具用于审阅协议，各任务的方法处理器和实际故障另按所属任务验收。

2026-10-20 在 Ubuntu 24.04、Node.js 22.22.2 下验证：底座 283 个测试、学习包 73 个测试全部通过，无跳过；两个包的 check、build 及协议的独立浏览器构建通过。学习包全套测试以 `--test-concurrency=1` 串行运行，使用已有的离线 Pyodide wheel 缓存。
