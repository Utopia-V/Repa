# 输入、请求与运行

会话输入由 `RepaApplication` 受理，`requests/store.ts` 保存请求与队列，`PiConversationHost` 把开始处理的输入交给 Pi 0.87.1。当前协议仍是未发布的 v1，前后端按同一提交联调。

## 设计思路

当你提交一条消息，后端会按提交方式立即处理或放进队列。即使连接随后断开，你也需要知道消息是否已经受理、由哪次运行处理，以及最后得到什么结果。因此，请求记录先保存这次提交，运行记录再描述 Agent 的实际执行。

Agent 工作期间，你可以补充要求。每次补充都是新的请求，却属于同一次运行，所以请求与运行并不是一一对应的。查询某次输入时使用请求 ID，查询或取消正在进行的工作时使用运行 ID。

Pi 已经提供输入投递、工具循环、历史和取消机制。Repa 在它们之前接入持久受理与调度：独立后续请求先留在 Repa 队列中，真正开始时再准备当前内容、建立运行并交给 Pi。这样，重启后能查到原提交，也能决定哪些任务需要恢复，而不是依赖进程中的队列自动继续。

## 提交与查询

`session.submit({ target, requestId, input, dispatch, selection? })` 返回持久受理记录。`target` 包含 `spaceId` 和 `sessionId`，`dispatch` 决定怎样处理：

| 提交方式 | 行为 |
| --- | --- |
| `{ kind: "start" }` | 空闲时启动；已有运行或更早的可执行队列时返回 `session_busy` |
| `{ kind: "steer", expectedRunId }` | 补充到指定运行，使用它的配置和入口背景；目标已经改变或结束时，保存 `not_entered` 结果 |
| `{ kind: "queue" }` | 作为独立后续请求排队；空闲且队列未暂停时立即开始 |

接入客户端时，需要保留自己生成的 `requestId`。如果应答丢失，你可以用相同标识和原始载荷重传，后端会返回原记录；改变载荷则返回 `request_id_conflict`。后端先查重，再解析配置，所以重传也不会套用后来修改的默认设置。

`request.get({ spaceId, requestId })` 查询输入、绑定配置、运行归属和投递状态；未找到时返回 `unknown`。应答丢失或连接中断后，客户端可以先用原标识查询。

`run.get({ spaceId, runId })` 查询运行，`run.cancel` 用相同标识取消它。取消后先进入 `cancelling`，等 Pi `abort()` 和运行收尾完成，再记录终态。steer 已经属于该运行，不会另起工具循环，也没有独立的执行结果。

### 输入和受理配置

输入的 `parts` 可以包含文本、草稿选区、内容引用、资源和带格式的表示。草稿选区使用提交时的文字；内容引用在实际开始时读取，并记录本次读到的修订。图片通过 Pi 的 `prompt` 或 `steer` 图片入口发送，格式转换和尺寸处理由 SDK 完成。其他资源保留引用和说明，按需要交给材料能力提取。

独立请求受理时保存提示配置、具名连接及认证身份、模型、思考强度、工具、压缩和重试选项。`selection` 可以显式覆盖本次选择，模型使用 `{ connectionId, id }`，空工具列表表示本次不提供工具。调用来源由服务端记录，包含已认证宿主的非秘密标识。

尚未选择连接或模型时，请求可以先受理，开始执行时报告 `connection_required`。配置完成后，通过 `session.continue` 明确接续。若显式选择了不存在的连接或模型，则在受理前返回 `connection_not_found` 或 `model_not_found`。连接绑定和认证生命周期见[模型配置](models-configuration.md)。steer 使用目标运行已有的配置，不重新选择账号和模型。

主调用准备好以后，实际提示写入请求的 `prompt` 字段；压缩调用也记录实际摘要提示来源。`run.get` 从所属请求汇总这些信息，普通状态事件只通知变化，不反复发送全文。

## 排队、退出与接续

`queue.list` 返回按受理顺序排列的请求，以及 `running` 或 `paused` 状态。当前运行正常完成后自动处理下一项；运行失败、中断或被取消时，后续任务可能需要重新判断，因此队列暂停，等待 `queue.resume` 明确恢复。启动另一个新任务不会恢复原队列。`queue.cancel` 只取消指定的未开始请求，不改变队列的暂停状态。

每项独立请求在受理时固定配置，在开始时读取当前内容和已启用的背景。队列里的请求不会提前批量送进 Pi；轮到它时，才取得自己的运行 ID。

能力通过 `sessions.submit` 提交输入时，可能需要等待应用完成其他操作。受理前的等待使用父调用的取消信号；父调用取消或插件关闭后，等待也结束。一旦应用已经受理，新请求就有了独立的持久记录，后续按自己的生命周期执行和取消。

最后一个前端离开后，后端会处理已经提交且可执行的队列；等待中的交互可以在重连后回答。`shutdown({ mode: "cancel" })` 停止当前工作，保留未执行项；`drain` 等待可执行工作结束。重新打开空间后，保留下来的队列处于暂停状态，需要明确恢复。

### 接续失败的工作

`session.continue({ target, requestId, previousRequestId, input?, selection? })` 为失败、取消、中断或未接入的请求建立一次新的提交。会话空闲时启动，忙时排队，原记录保留。

接续使用当前历史和当前文件。原输入尚未进入历史时，开始处理前补入；已经进入时，关联原消息，并追加本次要求。真正开始时还会核对一次投递状态，避免连续接续同一请求时重复补入。后续工具动作由 Agent 根据现状决定，不重放过去的工具调用。

## 历史与订阅

输入的 `delivery` 有三种状态：`pending`、`entered` 和 `not_entered`。`entered` 表示输入已经进入 Pi 历史，并附上实际消息标识；Agent 是否完成处理，需要查看所属运行。

Host 在 Pi 最后的 RPC input hook 中关联输入，把请求标识随实际用户消息保存。prompt 和 Skill 展开由 Pi 完成。扩展自行处理的输入可能不会形成用户消息，此时按实际结果记录。重开空间后，也会根据 Pi 历史核对投递状态。

`session.history({ spaceId, sessionId, revision?, before?, around?, limit? })` 返回历史和所选分支位置的 `revision`，默认 100 条，最多 200 条。首次读取固定当前 Pi leaf；后续带上这个修订，即使会话又增加消息，也能读取同一段历史。

`before` 使用上一页返回的游标；`around` 取得指定消息附近的窗口，两者互斥。`session.get` 和会话范围快照提供最近 100 条消息，应用和空间范围快照只提供活动运行，不附带各会话的完整历史。读取历史不会打开 Agent 实例，搜索与定位见[搜索接入](search-materials.md#历史查询固定-pi-分支位置)。

订阅事件包含 `previousCursor` 和新的 `cursor`，它们按该订阅实际接收的事件连续递增。其他会话的事件不会造成缺口。客户端发现缺口后重新取得快照，完成重同步前暂停应用后续增量；重连时按服务端缓存或新快照恢复。

## 独立后台处理

包管理、独立模型调用和客户端能力调用，都可能在没有 Agent 会话时发生。它们使用 `BackgroundRequests` 保存受理、配置、进度、交互与结果，不为此创建会话。

空间请求带有 `spaceId`，可以使用该空间的内容服务。应用请求省略 `spaceId`，记录保存在应用目录，也没有空间内容入口。两者使用相同的去重、取消和结果保存过程。应用在创建处理实例时提供记录目录、独占访问检查、变化通知和交互入口。

公开客户端通过 `request.get` 查询，通过 `request.cancel` 取消；应用请求在这两个接口中都省略 `spaceId`。应用或空间订阅发送 `processing` 变化，快照中保留尚未结束的处理。交互属于对应 `requestId`，通过 `interaction.reply` 回答。

取消终态要等处理函数真正结束，后端退出也会等待处理和内容操作收尾。重开后把中断结果保留下来，不自动重做。原选择保存在 `options`，受理时的配置保存在 `configuration`，重传不会重新解析它们。

各入口复用这套记录时，另有以下约定：

| 入口 | 接入方式 |
| --- | --- |
| `model.complete` | 用 Pi `ModelRuntime.completeSimple` 和 SDK 重试处理明确输入，记录回复、用量和来源资源；不创建会话 |
| `capability.invoke` | `inline` 和 `background` 都保存请求，区别是公开方法等待结果还是先返回回执；Agent 工具已归父运行，不另建后台记录 |
| `package.install/update/remove` | 保存包管理进度与结果；当前 SDK 进入安装后无法中途取消，改包前即标记后端需要重启 |
| `execution.run` | 保存命令结果和已经发生的输出；取消后的请求保持 `cancelled`，不会因保留输出而改报完成 |

对应细节见[独立模型调用](models-configuration.md#独立模型调用)、[能力调用](capabilities.md#公开调用与-agent-工具)、[包管理](plugins.md#安装更新与移除)和[命令执行](execution.md)。

## 持久格式与资源

| 内容 | 保存位置 |
| --- | --- |
| 运行起止记录 | `.repa/runtime/runs.jsonl` |
| 会话请求，文件版本 1 | `.repa/runtime/requests/<requestId>.json` |
| 队列暂停状态 | `.repa/runtime/queues.json`；顺序由请求受理序号确定 |
| 空间独立处理，文件版本 1 | `.repa/runtime/processing/<requestId>.json` |
| 应用独立处理 | `<appDirectory>/runtime/processing/` |

空间锁由 `RuntimeStore` 持有。应用独立处理则在首次使用时取得自身记录目录的 `proper-lockfile` 租约，不借用某个空间的锁。目录被另一后端占用时返回 `application_runtime_in_use`；租约受损时取消并退出，正常关闭要等任务和记录收尾后再释放。两类处理记录都通过原子替换保存。

请求受理前检查并保留输入资源，处理过程中读到的材料和生成的结果追加给同一父请求。会话工具结果进入历史后，由会话持有；新建分支也建立自己的保留关系。运行结束后，请求只需继续保留原输入。

独立后台处理成功时，最终保留输入和交付结果，释放仅供本次处理使用的中间资源。失败或取消时，已经取得的资源按记录保留。结果所需资源在报告完成前核对。应用请求若声明需要持有某个空间的资源，返回 `space_required`，应改为在所属空间中调用。

客户端断开、上传准备结束或会话历史删除，都不会清除仍被请求记录持有的字节。当前请求记录持续保留，尚未提供清理接口。完整保留规则见[资源说明](resources.md)。

空间备份包含空间请求与其资源，应用请求不随某个空间备份。复制时映射请求归属及标准输入、结果中的内容和资源引用；业务格式内部的引用由所属能力处理。Pi 历史由 SDK 保存，历史命令和当时的工作目录作为实际记录保留。

打开空间时，先恢复会话、请求和资源，再发布空间状态。恢复失败会释放尚未登记的租约；补回所需数据后，可以在同一后端重新打开。

## 未完成项与待验证项

| 项目 | 当前状态与影响 | 后续工作 |
| --- | --- | --- |
| 交互答复的重传确认与竞争结果 | `interaction.reply` 接受首次有效答复后删除待答交互，后续答复统一返回 `interaction_expired`。如果确认消息丢失，你重试时无法区分答复已接受还是交互确实过期；两个前端同时回答也无法查询已处理结果 | 由 [#19](https://github.com/Utopia-V/repa/issues/19) 接入 [#16 §9.2](https://github.com/Utopia-V/repa/issues/16) 约定的答复身份与结果确认，[#10](https://github.com/Utopia-V/repa/issues/10) 据此处理重试。[#20](https://github.com/Utopia-V/repa/issues/20) 的后台交互与 [#21](https://github.com/Utopia-V/repa/issues/21) 的授权交互复用同一行为 |

## 验证入口

- [application.test.ts](../../packages/repa/test/application.test.ts) 和 [model-api.test.ts](../../packages/repa/test/model-api.test.ts)：通过 Pi、本地 provider 和公开客户端，验证输入、队列、接续、取消、重连、重开及连接选择。
- [capability-api.test.ts](../../packages/repa/test/capability-api.test.ts)、[capability-resources.test.ts](../../packages/repa/test/capability-resources.test.ts) 和 [plugin-api.test.ts](../../packages/repa/test/plugin-api.test.ts)：验证能力与包管理的受理、资源、应用租约和关闭，也覆盖受理前取消会话提交。
- [background-requests.test.ts](../../packages/repa/test/background-requests.test.ts)：使用临时记录、空间资源和独立进程，验证应用请求、交互、取消、中断恢复及旧空间格式。
