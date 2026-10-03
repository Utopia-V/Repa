# Agent、提示与学习语境

`PiConversationHost` 把 Repa 的内容工具、提示配置和背景接到 Pi 0.87.1。模型调用、会话历史、工具循环、重试、token 统计和压缩使用 SDK 的实现。

## 设计思路

当你开始一项 Agent 任务，Repa 需要把请求、所选配置和启用的背景交给 Pi。Pi 已经能够运行 Agent，这里要接入的是模型实际看到哪些内容、工具怎样读写空间，以及你的选择怎样用于本次运行。

这些信息由各自的模块准备。Application 受理请求并固定配置，内容模块提供文件与资源，学习能力生成当前背景，Host 再把它们接到 Pi。你要调整学习背景的组织方式，就修改学习能力；要调整文件保存，则在内容模块中处理。

背景的接入还会影响 token 统计和压缩。模型使用的消息多出一段背景时，SDK 估算上下文也应当看见它。因此，适配不只发生在最后发送请求的地方，还要覆盖 Pi 用于计量的会话投影。下面分别说明运行准备、提示来源和这处适配。

## 一次运行的入口

1. Application 解析应用、空间和会话设置，受理时保存连接、认证身份、提示和运行选项。重传先查询原记录。
2. 运行开始时，Host 准备已启用背景并装配提示。学习背景由 Application 调用选定的 `repa.context.preview` 取得，使用本次 Agent 的来源、取消信号和服务。准备失败时，新用户消息尚未进入 Pi 历史，请求保留失败原因。
3. Host 根据当前分支和压缩边界，找到最近的完整背景快照。视图变化或快照缺失时追加新消息；官方学习来源沿用 `repa.learning-context` 消息格式。
4. 工具调用和后续模型轮使用同一份入口提示与背景。工具可以读取当前文件，下一次独立运行再重新准备背景。

应用输入通过 `session.submit` 受理，独立请求、steer 和持久排队分别处理。Host 使用 Pi `prompt()` / `steer()` 及图片参数投递，应用记录实际进入历史的消息关联。独立队列在开始时才准备当前背景并启动新运行，失败接续不重放旧工具。公共接口与持久语义见[输入、请求与运行](requests.md)。

## SDK 能力与接入范围

以下依据锁定的 Pi 0.87.1。SDK 提供入口与 Repa 已经接通分别记录，实施任务只补对应差异；源码依据见[通用原语核验](../research/pi-ecosystem-compatibility.md#通用-agent-原语与应用边界)。

| 能力 | SDK 入口与当前接法 | 后续 Repa 接入 |
| --- | --- | --- |
| 运行中补充、后续输入与图片 | `AgentSession.steer()`、`followUp()`、`prompt()` 的 `streamingBehavior` / `images`，以及 `sendUserMessage()`；当前 Host 接文本、图片 `prompt()` 与 `steer()`，独立 follow-up 由持久队列在开始时投递 | 公开输入、目标运行、资源、历史关联及受理时配置绑定均已接通；图形输入组件继续消费相同契约 |
| 模型、认证与独立调用 | `ModelRuntime` 提供发现、认证、`complete()` / `stream()`；当前已接具名连接、Pi 独立凭据槽位和 `model.complete` | 后端与 CLI 已可配置，图形前端消费相同接口；实现与取舍见[模型配置](models-configuration.md) |
| 工具启用与运行选项 | `getAllTools()`、`setActiveToolsByName()`、`setModel()`、`setThinkingLevel()`；受理时固定选择，在 Host 的运行入口应用 | 可选工具包括已接入的内容工具、`bash`、已启用共享能力工具和可信扩展；配置不绕过所属执行权限 |
| 历史、计量、压缩、重试与取消 | `SessionManager`、`getContextUsage()`、`compact()`、`abort()`、`waitForIdle()`；当前已复用历史、自动压缩、重试及取消收尾 | 应用已保存请求与队列状态并提供历史分页；前端按公共接口接入，不另写历史树、计数器、工具循环或外层自动重试 |
| 命令执行 | `createBashToolDefinition()` / `createBashTool()` / `BashOperations.exec`；参数、截断与工具流程复用 SDK，实际进程由 Repa 执行适配层持有 | 授权、取消和独立 helper 已接通；平台安装条件见[执行说明](execution.md) |
| 内容与历史检索 | 已接通官方搜索能力，底层文本搜索使用原生 ripgrep，历史读取复用 Pi 的不可变条目与分支位置 | 查询范围、快照和定位见[搜索说明](search-materials.md) |
| Agent 资源与包 | `DefaultResourceLoader`、`DefaultPackageManager`、工具及扩展注册；当前已能加载可信 Pi 扩展、Skill 和提示 | 已接共享后端能力、静态多入口清单、可信资源过滤及安装级快照；前端组件加载仍由前端宿主接入，详见[插件装配](plugins.md) |

Pi 的队列负责运行中的实际投递，Repa 的请求记录保存来源、配置、资源和恢复状态。独立后续请求留在 Repa 队列，轮到它时再准备背景并建立运行；这样，每项任务的配置与资源都有明确归属，重启后也能查询原记录。

`createAgentSessionServices()` 与 `createAgentSessionFromServices()` 可用于收拢设置、模型与资源加载的装配，替换现有手工装配前保留提示覆盖、信任和自定义内容工具入口。`AgentSessionRuntime` 围绕替换当前会话组织生命周期；Repa 的多会话协调仍需保证切换查看对象不停止其他运行，不能直接用它替换应用层。

现有通用背景投影、内容工具与空会话持久化适配仍有具体用途：分别维持来源关闭和压缩后计量、共同保存语义，以及创建后立即可恢复的会话身份。SDK 承担相同行为时再移除这些适配。

## 配置与实际来源

`settings.get` 返回逐项有效值、覆盖、来源和覆盖修订。继承顺序为默认值、应用、空间、会话。`settings.set` 保存完整的单项值，`settings.reset` 删除该项覆盖；空字符串、空列表和 `false` 都是有效覆盖，不表示恢复默认。

当前 `prompts` 命名空间包含 `base`、`append`、`projectInstructions`、`skillCatalog`、`environment`、`learningContext` 和 `fileChanges`。基础提示与追加段可以明确为空；项目说明还受宿主的扩展信任约束。默认安装启用官方学习能力；其默认提示由学习能力提供，禁用组合时默认基础提示为空，用户明确保存的覆盖仍有效。自动学习来源、Skill 清单和工作目录说明按各自设置控制，默认不载入项目说明，普通文件变化采用 `on-demand`。整个学习能力关闭与仅关闭自动注入分别表达，见[学习语境](learning.md)。

应用配置目录优先使用 `ApplicationOptions.appDirectory`，其次使用显式 `agentDir`，否则使用 `$XDG_CONFIG_HOME/repa` 或 `~/.config/repa`。Repa 覆盖保存在其中的 `repa-settings.json`，外部材料授权保存在 `repa-content-access.json`，具名连接位于 `models/`；凭据文件交由 Pi 管理。空间和会话覆盖保存在空间内的 `.repa/settings.json`。`runtime` 与 `summaryPrompts` 的空值含义、注册入口及版本迁接见[模型配置](models-configuration.md#按项配置与来源)。

提示由 [assembleSystemPrompt](../../packages/repa/src/agent/context.ts) 装配。Host 在最后一个 Pi inline extension 中，通过 `before_agent_start` 提供入口提示，再通过 `context_with_system` 提供每次请求的完整系统提示，保留 Pi 解析的工具定义。后一个入口也覆盖扩展直接调用模型的路径，因此用户清空提示或关闭来源时，实际调用也使用这些选择。

普通文件变化在 `context` 事件中合并检查。需要告知时，在这次模型请求前通过 `SessionManager.appendCustomMessageEntry` 保存一次变化消息，再用 `refreshContext()` 刷新公开投影并将消息交给本次请求。这个边界位于已完成的工具调用与结果之后；Pi 0.87.1 的 `sendCustomMessage({ triggerTurn: false })` 在流式执行中会延后到工具轮结束，不能用于要求本次调用立即看到的变化。文件保存本身仍不启动模型。

工具说明来自实际启用的内容工具、共享能力工具与可信扩展定义。能力工具只描述适合模型填写的业务参数；Application 注入本次空间、会话、运行、请求身份和父取消信号，同一 `invoke` 处理 API 与工具路径，不再为工具另建后台请求。模型与会话窄服务继续复用既有调用和请求入口，见[共享能力](capabilities.md#作用域与服务)。

`prompts.preview` 通过 `discoverPluginResources` 读取能够确定的静态来源，使用与运行时相同的信任和资源选择。默认的官方学习实现可以直接生成视图；其他实现与动态扩展贡献只标记来源，实际运行时再执行。预览不会加载扩展或后台工厂，也不安装缺失包。

实际主调用和压缩提示保存到所属请求。压缩使用 Pi 的公开 `compact`，通过 `session_before_compact` 接入摘要设置，分段、计量、重试和记录仍由 SDK 完成。完整覆盖的适配与升级条件见[提示预览与压缩](models-configuration.md#提示预览与压缩)。统一的图形编辑界面由前端接入。

## 背景在工作视图与历史中的位置

学习语境快照包含完整正文、来源和修订。Pi JSONL 保存过去实际提供过的消息，空间中的文档保存当前内容。

`agent/background.ts` 通过 `BackgroundSource` 的 `codec/enabled/prepare` 取得、识别和控制背景。学习能力提供自己的 codec、旧消息模板和 preview 函数；Application 按能力选择取得视图，再交给 Host。默认组合在 Application 中接入，学习规则留在学习模块。

关闭 `learningContext` 后，Host 排除可识别的自动快照并停止补回，历史记录与独立预览保留。关闭整个 `repa-learning` 会停用官方组合和自动背景；没有替代实现时，公共学习调用返回未找到能力，已经保存的文档和绑定保留。具体开关含义见[学习语境](learning.md#关闭启用与替换)。

压缩后，`projectBackgrounds` 按每个背景 codec 通过 Pi 的公开会话树接口寻找压缩边界以前的最近完整快照。若它已离开保留段，就放回对应摘要之后；保留段中已有的快照继续沿用原位置。Pi 显式 `context_edit` 省略或替换了该快照时，不从原始历史复活旧正文。

Pi 0.87.1 在执行请求的 `context` hook 之前，就根据会话投影判断是否需要压缩。如果只在发送前补入背景，计量会漏掉这部分消息。

因此，`withModelBackgrounds` 为交给 SDK 的 `SessionManager` 提供局部代理，适配 `buildSessionProjection()` 和 `buildSessionContext()`。`projectSessionBackgrounds` 同时保留消息与原始条目的对应关系，让 Pi 的 token 估算和模型请求使用相同的含背景投影。历史读写、分支和持久化仍交给原实例，不额外写入背景副本。

这处适配依赖 SDK 的投影入口和压缩顺序。升级 Pi 时应重点核对；若上游提供等价的公开扩展点，就可以替换代理，计量算法始终由 Pi 提供。

Pi 的默认摘要准备直接读取历史，因此 `session_before_compact` 也处理已关闭的来源。过滤仅移除能识别的自动消息；用户消息、工具结果和已有摘要里的历史信息保留。完整快照因其他处理被截断或改写时，不依据旧 `details` 将它误认为完整背景。

普通文件的 `notice` 和 `diff` 根据本 Host 实际读取过的空间内对象提供变化，不扫描整个空间或因保存而启动模型。只读取片段时不假定模型掌握全文；无可靠旧文、二进制或过大差异使用位置提示。Agent 自己的保存结果已经报告的变化不再重复注入。空间外材料和 Skill 资源当前不进入自动变化跟踪；重建 Host 后也需要重新建立读取基准。

压缩后的 `estimatedTokensAfter` 也由 SDK 读取会话投影计算，不修改其返回字段。估算和 provider 实际用量仍有区别；强制提示及其他扩展的最终请求变换需结合真实调用观察，不能把估算解释成精确承诺。

Pi 的 system 消息条目保存提示与工具配置，不投影为公开交流消息；原始会话仍保留这些 SDK 元数据。Repa 的公开历史提供实际交流、工具结果、语境快照与摘要，本次选择的提示配置由运行记录持有。

## 内容工具与复用边界

| 工具 | 复用与 Repa 责任 |
| --- | --- |
| `read` | Pi 的参数、文本截断和图像格式化；I/O 使用 ContentStore 的同一份实际快照，支持路径与 `repa:document/<id>`、`repa:material/<id>` |
| `write` | Pi 参数与展示；既有文件使用本 Host 实际观察过的字节版本，未观察的整篇覆盖返回 `read_required` |
| `edit` | Pi 参数与已提交差异展示；定位和保存经共同内容操作，保持未请求修改的字符与换行 |
| `apply_patch` | Codex 风格的文本补丁；内容模块协调实际文件、身份移动与恢复记录 |

只读相关片段也能取得整篇保存所需的版本基准。完整正文的构造仍是调用者的责任，局部修改可以直接使用 `edit` 或补丁。工具适配器生成操作标识，保存成功后的观察基准来自实际回执，不能再读取一个更晚的版本冒充本次结果。

取消在交给内容操作前检查。已经进入保存过程的操作先按内容模块规则收尾；成功落盘的结果不会因为稍后到达取消而改报为未保存。命令产生的文件变化按外部编辑重新观察，不冒充内容事务。Pi 默认 `edit.renderCall` 的直接磁盘预览路径未接入受管理内容。

## SDK 升级与验证

依赖由 `package-lock.json` 固定，当前使用 `@earendil-works/pi-ai` 与 `pi-coding-agent` 0.87.1，TypeBox 对齐为 1.3.27。公开 Repa 协议保持 v1。版本依据、保留适配的原因及更多可复用入口见 [Pi 调查](../research/pi-ecosystem-compatibility.md#12-pi-0871-的接入与升级)。补丁定位继续参考 ADR 0003 所列固定 Codex 源码。

升级时先对照实际使用的接口与上游行为变化，再检查生产者和消费者：提示与工具定义、会话投影及来源、计量与压缩、工具 I/O、扩展直接请求、已有会话读写。SDK 新增相同职责的公开机制时，一并判断旧适配能否删除。模型调用、认证、计量和压缩算法继续复用 Pi。

当前验证入口：

- [agent-context.test.ts](../../packages/repa/test/agent-context.test.ts)：来源开关、分支与重复压缩、投影消息和来源对应，以及 Pi 上下文编辑。
- [pi-context-integration.test.ts](../../packages/repa/test/pi-context-integration.test.ts)：真实 SDK 与 faux provider 核对实际请求中的系统提示、工具后续轮、背景回填、文件变化和扩展直接调用。provider 使用 `TranscriptContext`，断言通过 Pi 的 `getCurrentSystemPrompt()` 等入口解析系统状态。
- [pi-session-0.84.3.jsonl](../../packages/repa/test/fixtures/pi-session-0.84.3.jsonl)：由发布版 0.84.3 的 `SessionManager` 生成的会话格式 3 样本，包含完整背景、交流与压缩。集成测试复制后用 0.87.1 接续并重开，检查旧条目与原文件前缀保留。
- [application.test.ts](../../packages/repa/test/application.test.ts)：公共客户端、运行记录、取消、重试、会话恢复与独立后端进程。

这些测试使用本地确定性模型，当前执行环境为 Linux。真实 provider 与其他平台继续由对应集成验证覆盖。
