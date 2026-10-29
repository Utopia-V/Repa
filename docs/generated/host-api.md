<!-- 由 scripts/docs/gen-host-api.ts 生成，不要手改。 -->

# 插件接口

## Host

底座交给插件的空间能力，插件通过它访问文件、历史、模型和前端服务。

| 成员 | 声明 | 说明 |
| --- | --- | --- |
| now | now(): number; | 底座与插件共用的当前时间，Unix 毫秒。 |
| space | space: { root: string; dataDir: string }; | 空间根目录与本插件独占的数据目录；持久状态写入 dataDir。 |
| files | files: Files; | 读写空间内的文本文件，写入归属当前运行或插件。 |
| history | history: History; | 查询文件变化，或以指定来源记录一组空间操作。 |
| models | models: Models; | 发起由宿主持有生命周期的模型请求与 Agent 工作。 |
| services | services: Services; | 调用前端声明的服务；输入与结果由插件和服务提供方约定。 |
| abortAgent | abortAgent(agent: string): Promise&lt;void&gt;; | 中止本插件声明的 Agent 的现有会话运行；等待 Pi 停稳并沿用原取消队列语义。 |
| emit | emit(event: unknown): void; | 向订阅空间的连接发布本插件的事件，宿主补上插件 id。 |

## Plugin

可由底座加载的插件定义；open 为一个空间创建独立实例。

| 成员 | 声明 | 说明 |
| --- | --- | --- |
| id | id: string; | 插件唯一标识，用作协议命名空间与独占数据目录名。 |
| open | open(host: Host): Promise&lt;PluginInstance&gt;; | 为一个空间打开实例；返回前失败时，插件负责清理已打开的子实例与局部资源。 |

## PluginInstance

插件在一个空间中的实例，向宿主声明能力并持有相应的关闭责任。

| 成员 | 声明 | 说明 |
| --- | --- | --- |
| instructions | instructions?(): string; | 交给通用 Agent 的常驻说明，作为插件命名提示段。 |
| tools | tools?(): Tool[]; | 本插件提供的 Agent 工具，打开时读取并校验名称与参数声明。 |
| agents | agents?(): AgentDefinition[]; | 本领域的 Agent；打开插件时读取一次。 |
| view | view?(): Promise&lt;string &#124; undefined&gt;; | 通用 Agent 当前需要的领域状态；undefined 表示本轮无可投影内容。 |
| onChange | onChange?(revision: string): Promise&lt;void&gt;; | 按修订追赶空间文件变化；宿主串行调度并在关闭前等待。 |
| methods | methods?: Record&lt;string, PluginMethod&gt;; | 公开给协议客户端的方法，以本插件 id 作为命名空间。 |
| close | close?(): Promise&lt;void&gt;; | 宿主取消模型并等待在途调用后关闭实例；此处还须等待插件自有通知与非模型后台工作。父插件自行关闭子实例时也负责先停止其工作。 |

## AgentDefinition

插件声明的 Agent。会话创建后工具与 view 来源固定，中途不换 Agent。

| 成员 | 声明 | 说明 |
| --- | --- | --- |
| id | id: string; | 所有插件间唯一，仅含小写字母、数字和连字符；general 留给底座的通用 Agent。 |
| description | description?: string; | 简短用途，交给前端显示，也写进父 Agent 的子 Agent 工具说明。 |
| instructions | instructions(): string; | 职责说明，作为提示段 agent:&lt;id&gt;。 |
| tools | tools: string[]; | 可用工具的名称：BUILTIN_TOOLS 中除 grep 外的内置工具、ask_user 与任一插件的工具。<br>内置文件工具限在空间内，仅 read 可以读取 .repa/tool-output/；bash 仍按命令策略确认。列了 grep 时插件打开失败，<br>需要搜索内容的插件提供自己的工具。 |
| subagents | subagents?: string[]; | 可以启动的子 Agent；启动时子 Agent 的工具不能超过本 Agent。 |
| direct | direct?: boolean; | 用户能否直接与它建会话；装配可以另行指定。默认否。 |
| view | view?(): Promise&lt;string &#124; undefined&gt;; | 只渲染本 Agent 的运行时状态，作为 view agent:&lt;id&gt;；运行限制放在 beforeRun。 |
| beforeMessage | beforeMessage?(message: UserMessage): Promise&lt;MessageDecision &#124; void&gt;; | 用户消息进入会话前的判断。返回拒收时消息不写入会话，前端收到 message_rejected；<br>不返回或返回 accepted 时照常处理，插件可以在这里只记下这次提问。抛错同样拒收。 |
| beforeRun | beforeRun?(): Promise&lt;MessageDecision &#124; void&gt;; | 每条消息真正运行前判断，包括排队后的消息；拒收时不写会话、不启动模型。 |
