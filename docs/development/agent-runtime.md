# Agent、提示与学习语境

`PiConversationHost` 将 Repa 的内容、提示配置和学习语境接到锁定的 Pi SDK 0.87.1。Pi 持有模型调用、会话历史、工具循环、重试、token 统计和压缩；Repa 持有需要提供哪些来源、何时读取空间当前语境，以及工具操作的内容身份和保存责任。

## 一次运行的入口

1. `RepaApplication` 受理请求前解析应用、空间和会话提示覆盖，保存本次 `promptSettings`。同标识重传先查询原请求，不重新读取默认值。
2. 运行实际开始时，Host 取得当前学习语境视图并装配系统提示。语境读取失败发生在新用户消息进入 Pi 历史之前，运行记录保留失败原因。
3. Host 根据当前分支和压缩边界得到实际工作消息，比较最近完整语境快照。变化或缺失时，追加 `repa.learning-context` 自定义消息，然后交给 Pi 处理用户输入。
4. 工具调用和后续模型轮沿用该运行的提示与入口语境。工具仍能读取当前文件；下一次独立运行才重新取得入口语境。

当前应用输入仍是 `run.submit` 的文本请求；持久 steer、队列、结构化输入与显式失败任务接续按 Issue #16 后续接入。Host 的 `send(text, settings)` 接收本次已经确定的设置，不主动查询实时全局覆盖。

## 配置与实际来源

`settings.get` 返回逐项有效值、覆盖、来源和覆盖修订。继承顺序为默认值、应用、空间、会话。`settings.set` 保存完整的单项值，`settings.reset` 删除该项覆盖；空字符串、空列表和 `false` 都是有效覆盖，不表示恢复默认。

当前 `prompts` 命名空间包含 `base`、`append`、`projectInstructions`、`skillCatalog`、`environment`、`learningContext` 和 `fileChanges`。基础提示与追加段可以明确为空；项目说明还受宿主的扩展信任约束。默认启用学习语境、Skill 清单和工作目录说明，默认不载入项目说明，普通文件变化采用 `on-demand`。

应用配置目录优先使用 `ApplicationOptions.appDirectory`，其次使用显式 `agentDir`，否则使用 `$XDG_CONFIG_HOME/repa` 或 `~/.config/repa`。Repa 的应用提示覆盖保存在其中的 `repa-settings.json`，外部材料授权保存在 `repa-content-access.json`；Pi 的模型、认证及自身设置继续使用 Pi 配置入口。空间和会话覆盖保存在空间内的 `.repa/settings.json`。

提示由 [assembleSystemPrompt](../../src/agent/context.ts) 装配。Host 使用最后的 Pi inline extension，通过 `before_agent_start` 提供运行入口提示，通过 `context_with_system` 提供每次请求的完整系统提示并保留 Pi 解析的工具定义。后一个入口也覆盖扩展命令直接触发模型的路径，因此显式空提示和关闭的来源不会回落到 SDK 默认值。Repa 不包装 `prepareNextTurnWithContext` 或 `transformContext`，也不直接写入 Agent 的消息或系统提示状态。

普通文件变化在 `context` 事件中合并检查。需要告知时，在这次模型请求前通过 `SessionManager.appendCustomMessageEntry` 保存一次变化消息，再用 `refreshContext()` 刷新公开投影并将消息交给本次请求。这个边界位于已完成的工具调用与结果之后；Pi 0.87.1 的 `sendCustomMessage({ triggerTurn: false })` 在流式执行中会延后到工具轮结束，不能用于要求本次调用立即看到的变化。文件保存本身仍不启动模型。

工具说明仍来自实际启用的工具定义，可信扩展可以执行自己的代码和模型请求。辅助摘要提示、工具启用配置及扩展贡献的统一编辑界面尚未接入；当前设置不能被解释为已控制所有第三方代码的行为。

## 背景在工作视图与历史中的位置

学习语境快照包含完整正文、所见来源及修订。Pi 的 JSONL 保留过去实际提供过的消息；空间内容持有当前语境。关闭 `learningContext` 后，Host 从模型工作视图排除该来源，并停止自动补回；独立预览、文档和绑定仍然存在。

压缩后，`projectContext` 通过 Pi 的公开会话树接口寻找压缩边界以前的最近完整快照。若它已离开保留段，就放回对应摘要之后；保留段中已有的快照继续沿用原位置。Pi 显式 `context_edit` 省略或替换了该快照时，不从原始历史复活旧正文。

`withModelContext` 为交给 SDK 的 `SessionManager` 提供局部代理，只适配 `buildSessionProjection()` 与 `buildSessionContext()`；历史读写、分支和持久格式继续委托给原实例。`projectSessionContext` 同时维护模型消息及其原始条目来源，使 Pi 的现有 token 估算和模型请求使用同一份含回填背景的投影。原实例仍可读取未被 Repa 投影改变的历史，没有额外写入背景副本。

保留这处适配的原因是 Pi 0.87.1 在请求的 `context` hook 之前，直接根据会话投影决定是否压缩；只在发送前添加背景会遗漏这部分估算。此前直接改写 `agent.state.messages` 的接法已不再控制 SDK 后续请求。计数算法继续由 Pi 提供；以后若增加等价的公开投影扩展点，应优先替换这处代理。

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

取消在交给内容操作前检查。已经进入保存过程的操作先按内容模块规则收尾；成功落盘的结果不会因为稍后到达取消而改报为未保存。当前没有命令工具，也没有把 Pi 默认 `edit.renderCall` 的直接磁盘预览路径接入受管理内容。

## SDK 升级与验证

依赖由 `package-lock.json` 固定，当前使用 `@earendil-works/pi-ai` 与 `pi-coding-agent` 0.87.1，TypeBox 对齐为 1.3.27。公开 Repa 协议保持 v1。版本依据、保留适配的原因及更多可复用入口见 [Pi 调查](../research/pi-ecosystem-compatibility.md#12-pi-0871-的接入与升级)。补丁定位继续参考 ADR 0003 所列固定 Codex 源码。

升级时先对照实际使用的接口与上游行为变化，再检查生产者和消费者：提示与工具定义、会话投影及来源、计量与压缩、工具 I/O、扩展直接请求、已有会话读写。SDK 新增相同职责的公开机制时，一并判断旧适配能否删除。模型调用、认证、计量和压缩算法继续复用 Pi。

当前验证入口：

- [agent-context.test.ts](../../test/agent-context.test.ts)：来源开关、分支与重复压缩、投影消息和来源对应，以及 Pi 上下文编辑。
- [pi-context-integration.test.ts](../../test/pi-context-integration.test.ts)：真实 SDK 与 faux provider 核对实际请求中的系统提示、工具后续轮、背景回填、文件变化和扩展直接调用。provider 使用 `TranscriptContext`，断言通过 Pi 的 `getCurrentSystemPrompt()` 等入口解析系统状态。
- [pi-session-0.84.3.jsonl](../../test/fixtures/pi-session-0.84.3.jsonl)：由发布版 0.84.3 的 `SessionManager` 生成的会话格式 3 样本，包含完整背景、交流与压缩。集成测试复制后用 0.87.1 接续并重开，检查旧条目与原文件前缀保留。
- [application.test.ts](../../test/application.test.ts)：公共客户端、运行记录、取消、重试、会话恢复与独立后端进程。

这些测试使用本地确定性模型，当前执行环境为 Linux。真实 provider 与其他平台继续由对应集成验证覆盖。
