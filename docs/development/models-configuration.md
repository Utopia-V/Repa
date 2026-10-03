# 模型连接与运行配置

这一部分让用户在 Repa 里配置模型连接、管理多个账号，并选择不同空间和会话使用的模型。当前可以通过 CLI 和公开接口使用，图形设置页面仍待接入。

## 设计思路

这里复用了 Pi 的底层实现，在此之上支持多个账号同时使用。登录、凭据刷新和模型调用交给 Pi；Repa 为每个连接分别保存服务地址与认证身份，让不同会话和任务使用各自的账号。用户无需为了同时使用这些账号，自建一个中转站或号池。

请求受理时会记下本次使用的连接、账号和模型。这样，修改默认配置只影响之后的新请求，已经排队的任务仍按原来的选择执行。旧认证因此需要继续保留，直到明确注销或移除连接时清理。具体保存方式和注销行为见下文。

## 实现细节

### 配置一个连接

在仓库根目录运行：

```sh
npm run dev:backend -- configure
npm run dev:backend -- /path/to/learning-space
```

运行 `configure` 后，先选择已有连接，或创建一个新连接。接着按服务商支持的方式填写 API key 或完成 OAuth 登录，最后选择模型并设为应用默认值。

已有登录可以继续使用，选择重新登录才会建立新的认证身份。输入密钥时终端隐藏内容，也不会把它写入输入历史。退出向导时会等待登录取消完成。

已启动独立后端时，使用 `configure --connect /absolute/path/connection.json`。自定义模型目录可通过 `--connection-config /path/to/connection.json` 提供，文件结构见 [ConnectionInputSchema](../../packages/repa/src/models/schema.ts)，其中不填写凭据。`authMode: "none"` 用于无需凭据的本地服务；仅覆盖已知 provider 的 `baseUrl` 时继续使用 Pi 内置模型目录。

`--agent-dir` 仍控制 Pi 资源和默认运行设置。Repa 应用目录优先取 `ApplicationOptions.appDirectory`，其次取显式 `agentDir`，否则使用 `$XDG_CONFIG_HOME/repa` 或 `~/.config/repa`。应用目录中的 `models/connections.json` 保存连接定义；`models/auth/<authId>.json` 是交给 Pi 管理的独立凭据文件。

### 连接身份、请求绑定与注销

`connectionId` 标识连接，名称仅用于展示。模型选择使用 `{ connectionId, id }`，其中 `id` 是该连接目录中的模型标识。创建、查询、更新和移除使用 `connection.*`；更新和移除必须携带读到的 `revision` 作为 `base`。provider 和认证模式属于固定身份，更换它们需要新建连接。

同一 provider 可能同时用于个人账号和学校网关。如果两者共用 provider 名下的一个凭据槽位，修改其中一个账号就会影响另一个。当前每次明确登录使用新的 `authId` 和 Pi 凭据文件，成功后再发布为该连接的当前身份。普通配置和历史只保存非秘密标识。凭据写入、OAuth 续期和文件并发访问继续由 SDK 处理。

独立会话请求和排队请求在受理时保存连接定义、认证身份、模型及运行选项。修改名称或端点、切换默认模型、再次登录，都不改变已经受理的选择。例如排队请求绑定旧网关时，稍后把连接改成新网关，旧请求仍发送到原端点。代价是旧认证槽位需要保留到明确注销或移除连接；自动续期继续更新原槽位，不改变绑定身份。

`auth.logout` 和 `connection.remove` 停止使用该连接的当前工作，等待实际结束，再由 SDK 清理该连接的全部凭据槽位。已经切换到另一连接的运行继续执行。旧队列保留原绑定并报告认证失效，不借用新账号继续发送。需要接续时，使用 `session.continue` 建立新的选择，原失败记录和已经进入历史的输入继续保留。

同一会话仍使用相同运行身份时复用 Host，保留文件读取基准、扩展和历史。仅改名或切换同连接中的模型不重建 Host；端点、认证身份或模型目录改变后，关闭旧的空闲 Host，并在同一份 Pi 会话历史上创建新实例。连接服务按操作创建 runtime，不维护另一套跨连接缓存。

### 登录协议与当前 provider 边界

`auth.start` 返回 `loginId`，`auth.get` 查询状态及当前 challenge。challenge 包含普通输入、秘密输入、选择和手动回调码；`auth.reply` 必须同时携带 `loginId` 与 `challengeId`。完成、失败和取消都可查询，过期 challenge 不接受新回复。URL、设备码和进度通过专用认证查询提供，不进入普通连接列表或会话历史。

`drain` 期间拒绝开始新登录，已经开始的登录仍可回复或取消，否则等待用户输入的认证会阻止后端退出。取消模式主动取消登录，并等待 SDK 收尾。SDK 已保存凭据但后续状态同步失败时，返回 `synchronizationRequired`，不把已完成的保存误报为未登录。

具名连接只使用自身明确保存的认证，不借用进程中的 API key 或 Pi 默认凭据文件。Pi 0.87.1 的当前接入限制如下：

- OAuth provider 可能按账号改写 endpoint，因此 OAuth 连接不同时接受 `baseUrl` 覆盖。
- Vertex 支持显式 API key 和 service-account 文件；未固定身份的默认 ADC 入口不用于具名连接。
- Bedrock 支持显式 bearer token 和 AWS profile。SDK 的环境读取会让进程级 `AWS_BEARER_TOKEN_BEDROCK` 覆盖 profile；出现这一组合时返回 `auth_environment_conflict`，需选择显式 token 或调整后端启动环境。未固定身份的默认 credential chain 不用于具名连接。

这些限制属于当前 SDK 适配，而非永久产品要求。升级时优先检查 SDK 能否完整表达独立认证上下文，删除已经失去作用的适配。

### 按项配置与来源

[ConfigStore](../../packages/repa/src/configuration/store.ts) 依次解析定义默认值、应用、空间和会话覆盖。每项定义持有 schema、默认值和允许修改的作用域；`ApplicationOptions.settingsDefinitions` 接受能力提供的命名空间。定义不携带数据库或其他生命周期要求。

| 命名空间 | 当前设置 |
| --- | --- |
| `prompts` | 基础提示、追加内容及项目说明、Skill、环境、学习语境和文件变化来源 |
| `runtime` | 连接与模型、思考强度、工具、压缩参数、重试参数 |
| `summaryPrompts` | 压缩调用的系统提示与摘要任务指令 |

`settings.get` 返回定义、有效值、覆盖来源和当前作用域的修订。`settings.set` 使用该修订修改单项；`settings.reset` 删除覆盖并恢复继承。空字符串、空列表和 `false` 均保留其明确含义。`runtime` 中的 `null` 表示采用 SDK 或装配默认值，模型项的 `null` 表示尚未选择 Repa 连接；`summaryPrompts` 中的 `null` 表示使用 SDK 默认提示，空字符串表示明确清空。

受理请求时从同一组设置文件快照解析多个命名空间，保存实际选项与来源。默认思考强度通过 Pi 的 `clampThinkingLevel` 适配实际模型，显式选择则校验模型是否支持。临时选择和模型切换只更新内存中的 `SettingsManager`，不会改写用户的 Pi 默认配置。压缩参数同时覆盖 SDK 的单模型设置，使持久记录与执行一致。

应用覆盖位于 `repa-settings.json`，空间和会话覆盖位于 `.repa/settings.json`。新格式为 `repa.settings` 版本 2，以 `namespaces` 保存逐项值。读取版本 1 的 `prompts` 时保留原值和修订，实际修改所属文件时写入版本 2。未登记命名空间的数据继续保留，重新启用能力后由其定义解释。

### 提示预览与压缩

`prompts.preview({ spaceId, sessionId })` 返回静态装配结果及各项设置来源。它通过 `DefaultPackageManager.resolve` 跳过缺失包，以静态资源入口读取已有 Skill 和项目说明，不建立 Agent、不执行扩展工厂、不安装包。缺失包和扩展贡献标为动态来源，在实际运行时确定。

主调用准备后，实际系统提示与工具定义进入原请求的 `prompt` 字段，`run.get` 聚合查询；不另建提示历史库。学习语境沿用原快照，只在提示来源中保存引用和修订，避免每次状态事件复制整份背景。

压缩仍由 Pi 的 `compact` 完成，包括准备数据、分段、计算用量、重试和保存压缩记录。Repa 补充的是压缩提示词的配置。

Pi 0.87.1 没有逐段替换这些提示词的公开入口，因此 [summary.ts](../../packages/repa/src/agent/summary.ts) 在模型调用前，根据本次准备数据识别 Pi 生成的摘要请求，再替换其中的系统提示和任务指令。原历史和用户明确追加的要求继续保留。已有扩展接管压缩、且用户未覆盖摘要提示时，继续沿用扩展行为。

这处适配依赖 Pi 生成摘要请求的格式，升级 Pi 时需要重点复核：请求是否仍能被准确识别，替换是否保留历史和附加要求，失败与取消是否仍按预期结束。如果上游提供等价入口，这层适配就可以收缩。

覆盖失败会结束本次压缩并返回错误，避免用户明确选择的提示词又变回默认值。取消后不保存不完整摘要。

### 独立模型调用

`model.complete({ spaceId, requestId, input, model, system, thinkingLevel?, maxTokens? })` 使用 `ModelRuntime.completeSimple` 和 SDK 的重试函数，不创建会话。调用受理时固定连接及选项，通过 `request.get`、`request.cancel` 和 `processing` 事件查询与取消。重传先返回原记录，不重新解析默认配置。

结果采用 `repa.model-response` 版本 1 的表示，保存实际回复、用量、已准备输入和来源资源。显式空系统提示保留为空。资源保留、后端关闭及中断结果继续使用[后台请求生命周期](requests.md#独立后台处理)。

## 未完成项与待验证项

本节对照 [#18](https://github.com/Utopia-V/repa/issues/18) 的交付与验收要求，记录当前候选尚未覆盖的部分。

| 项目 | 当前状态与使用影响 | 后续工作 |
| --- | --- | --- |
| 显式配置的跨模型／跨连接自动回退 | 未实现。当前支持同一模型调用的 SDK 重试，以及重新选择连接后手动接续任务；任务不会按配置自动改用另一模型或账号 | 由 #18 接续回退策略的配置、执行与实际选择记录，并验证费用和数据去向符合所选策略 |
| 真实云端 OAuth 登录与凭据刷新 | 待验证。登录接口与 Pi 认证机制已接入，现有回归覆盖已保存 OAuth 凭据的 SDK 解析，尚未使用真实账号走通云端登录和刷新 | 取得相应账号授权后验证登录、刷新、取消与注销，记录实际覆盖的 provider |
| Web／Desktop 设置页面 | 待前端接入。当前通过 CLI 或公开接口配置连接、模型和提示，图形界面尚不能完成这套操作 | 由 [#10](https://github.com/Utopia-V/repa/issues/10) 接入配置页面，并与 #18 的公开接口联调 |

## 验证入口

在仓库根目录运行 `npm run check`、`npm test` 和 `npm run build`。当前 Linux 检查全部通过。模型集成使用真实 Pi 0.87.1、本地 HTTP provider 或 faux provider，未调用付费模型。

- [model-connections.test.ts](../../packages/repa/test/model-connections.test.ts)：同 provider 的独立凭据、端点绑定、登录/注销和本地无密钥调用；Vertex 显式凭据文件与 Bedrock profile 的 SDK 解析。
- [model-api.test.ts](../../packages/repa/test/model-api.test.ts)：真实客户端、多会话、队列与配置切换、注销、独立调用、静态预览和退出期认证。
- [configuration.test.ts](../../packages/repa/test/configuration.test.ts)：逐项继承、空值、冲突、作用域、未登记数据与旧格式接续。
- [summary.test.ts](../../packages/repa/test/summary.test.ts)、[pi-context-integration.test.ts](../../packages/repa/test/pi-context-integration.test.ts)：实际主调用和压缩输入、工具选择、摘要覆盖失败及取消。
- [cli-models.test.ts](../../packages/repa/test/cli-models.test.ts)：真实 CLI 配置后进入普通会话，秘密输入、重登录和中断收尾。
