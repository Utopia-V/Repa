# 学习辅导与即时回顾

学习插件声明 `learning-tutor`，围绕当前任务提供聊天、内容搜索和即时回顾。界面与 Agent 共用 `content.search`、`content.read` 和 `content.open` 的授权与记录入口；复习准备开始时就关闭这些帮助，直到任务结束。

## 设计思路

你在练习中提问以后，正确答案仍然可以帮助程序判断理解情况，但它不再是独立完成的证据。因此，`beforeMessage` 先经学习记录的串行入口记下一条求助事实，再让消息进入 Pi。参考内容的读取也在同一个入口检查当前任务，读到内容就同样记下。这样，作答被收下时，就能从事实的先后确定求助是否发生在它之前，而不必根据模型事后描述来判断。

复习则需要一段真正没有辅导的作答时间。教学流程先写下任务事实，任务停在 `preparing` 并生效限制，再等待 `host.abortAgent("learning-tutor")` 完成；Pi 停稳后才交付第一道题，从这一刻开始计时。准备失败时，任务仍是 `preparing`，重新打开以后可以沿 `task.resume` 继续。取消期间到来的消息沿底座原有行为报告 `cancelled`；取消完成后的受限消息由 `beforeMessage` 拒收。

模型不需要在每轮对话里接收整门课。Agent 的命名提示段只说明辅导职责，视图只投影当前任务、KP 进度、阶段、最新提交状态及最多三个相关先修。需要讲解细节时，再通过工具读取。工具每次执行都重新检查当前状态，视图也在模型请求前检查限制。因此，旧视图或已放行但尚未启动的消息都不能绕过后来生效的限制。

## 实现细节

### Agent 与学习产品入口

`plugin.ts` 默认把教学流程的 `beforeRestricted` hook 接到本插件的中止入口，并装配 `tutor.ts`。`learning-tutor` 可直接对话，只列出 `learning_task`、`learning_search` 和 `learning_read`；文件、命令、网络和子 Agent 工具均不在声明中。

在仓库根目录运行：

```sh
npm run dev:learning -- --home /absolute/repa-home
```

这个入口先构建学习包，再加载其静态插件清单，以 `--no-general-agent --direct-agent learning-tutor` 启动底座。Desktop 的启动与页面接线由 f/h 接续；使用 `startServer` 装配时，同样设置 `generalAgent: false` 和 `directAgents: ["learning-tutor"]`。

### 内容、版本与原学习位置

`tutor-content.ts` 从已经全量加载的课程建立只读索引，包含 topic 正文、KP 讲解、例题正文与解说、概念卡。正式练习、复习和测验题的私有定义不进入索引；题解只从已经释放的公开 submission 投影取得。可见范围是当前任务的 topic 与学生模型中已经学过的 topic。请求必须携带完整版本引用。读取只提供当前课程里的内容，课程换版以后旧版本的引用按不存在处理；猜题号、使用不存在的版本或读取尚未学过的 topic 都会失败。

| 入口 | 参数与结果 |
| --- | --- |
| `learning_task` | 读取当前 phase、交付的公开 Item、已接受原答和已释放反馈；返回 JSON 文本片段，`offset` / `limit` 按 Unicode 字符计数，默认 2,000、最多 3,000 字符；`version` 改变后从头重读 |
| `content.search` | 显式传 `query`、`offset`、`limit`，最多 20 项；按内容 id 稳定排序，返回 `ref`、标题、短命中、`origin` 和 `nextOffset` |
| `learning_search` | 同一处理器；省略时使用 `offset: 0`、`limit: 10` |
| `content.read` / `learning_read` | 最多 8 个 `refs`，以 `offset`、`limit` 选择内容块；工具默认从第 0 块读 8 块，单次最多请求 64 块 |
| `content.open` | 界面打开卡片或参考内容时核对授权，返回服务端 `openedAt`；课内作答之前打开记为一次求助 |

当前任务工具只从公开状态取值，不读取课程里私有的答案或 rubric。它也逐次检查限制、记录帮助，因而模型可以直接看见正在讨论的题目，而不必要求学习者重新转述。

搜索与批取的正常响应预算是 16 KiB；搜索可能提前返回 `nextOffset`，批取可能缩短最后一页或只返回前几个引用。每页的 `offset`、实际 `blocks.length` 和 `total` 用于继续读取，尚未返回的引用继续单独请求。分页保持课程原生内容块，不截断 Markdown 或代码块；某个单块已超过预算时报告 `content_block_too_large`，由内容作者拆分该块。预算和分页数量都是 Repa 的工程假设。

`ref` 是概念与内容的版本引用，`origin` 定位原任务及可用的原交付。概念卡的例子来自例题时，`origin.content` 指向该例题；来自已经交付的正式题时，`origin.deliveryId` 指向那份交付。界面可以用同一 `content.read` 入口取得原例题，或者回到原交付画面。前端渲染和对话内链接的实际交互由 f 接续。

### 帮助记录与受限开始

辅导和内容读取经学习会话的串行入口：读取当时的状态、校验限制，学习者确实得到帮助（提问，或搜索、读取、打开到了内容），而课内当前这道题还没作答时，追加一条 `help` 事实；每道题只记一次，作答收下与它共用队列。题目之外的查看和作答之后的帮助不影响作答是否独立，不写事实。追加后发出 `learning.changed`，界面据此重新查询 revision，避免下一次推进仍拿旧版本。

参考内容的限制也覆盖历史提交。插件在统一公开响应边界按返回时的当前任务判权；受限期间保留提交身份、原答与处理状态，隐藏反馈（包括期望答案）和题解。这条投影规则覆盖查询、幂等重试、恢复、申诉、状态以及错误携带的状态，不改变日志中的完整判分。内容读取与响应投影共用 `referenceAllowed`，因此历史结果不能绕过 `content.*` 的禁助限制。正式题解只在教学流程释放后可检索、读取。

视图的先修排序使用最后一条事实的时间，不使用每次查询时的相对时间。因此，状态相同时，视图文本保持稳定；下一轮运行通过 Pi 现有命名段和视图更新看到新状态。

复习的完整开始路径位于 `flow.ts` 的 `menu.select` / `task.resume`：先写下任务事实，再等待取消完成，然后交付第一道题，开始时间与截止时间由它算出。quiz/retake 走同一条路径，一次交付整场题目；恢复时沿同一步骤继续，见[测验与进度说明](learning-quiz-xp.md)。内容与消息限制已经按所有非 lesson 的未结束任务检查，覆盖 preparing、作答和恢复阶段。

## 未完成项与待验证项

- f/h 接续 Desktop 装配、概念链接、卡片和原位置跳转的界面交互。当前已验证真实客户端读取引用及原例题，没有声明界面验收完成。
- 真实辅导效果及学习外负担的变化，需要真实学习者使用。当前模型边界采用本地假 provider。

## 验证入口

在仓库根目录运行：

```sh
npm run check --workspace=@repa/base
npm test --workspace=@repa/base
npm run build --workspace=@repa/base
npm run check --workspace=@repa/learning
npm test --workspace=@repa/learning
npm run build --workspace=@repa/learning
```

`learning-tutor.test.ts` 使用真实 SDK、真实 HTTP/WebSocket 客户端及本地假 provider，组合验证 py01 上课、求助、判分、菜单、跨天复习、即时回顾和关闭后复制到新目录恢复。另验证稳定分页、8 引用批取、长文本续取、私有题解释放边界、取消停稳后才计时，以及准备失败后重开继续。设置 `REPA_LEARNING_EVIDENCE=/absolute/directory` 后，复制恢复用例会把关闭时的完整空间副本保存在新的 `tutor-restored-*` 子目录中。底座 `agent-messages.test.ts` 验证所有权拒绝、取消终态、排队清理与恢复聊天。
