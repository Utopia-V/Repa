# Pi 生态对 Repa 的可复用性调查

第 1–8 节的调查基准是 `earendil-works/pi` 的固定提交 [`8fa7eebd235355522c8104166b4f1f959b4e2f10`](https://github.com/earendil-works/pi/tree/8fa7eebd235355522c8104166b4f1f959b4e2f10)，相应 GitHub 链接均固定到该提交。第 9–11 节保留当时锁定版本 `@earendil-works/pi-coding-agent@0.84.3` 的局部核验，第 10 节另以固定版本的 Codex 编辑实现作比较。第 12 节记录当前 0.87.1 的接入与验证；当前代码责任见[开发说明](../development/agent-runtime.md)。各节结论按其版本解释，升级时核对受影响部分。

## 结论摘要

Pi 的可复用边界不是一个单一的“插件 API”。它有四层：资源（skill、prompt、theme）、运行时代码（extension）、可分发容器（package），以及可嵌入/可进程化的 Node agent runtime。对 Repa 最有价值的是 Node SDK + `DefaultResourceLoader` + AgentSession/Runtime + tool/provider/生命周期 extension；Rust 通过 `pi --mode rpc` 可以复用 Pi 进程内的 agent、模型、认证、工具和大部分非 TUI extension，但不能把 Node API 变成 Rust 原生库。

## 1. package、extension、plugin 以及生命周期

Pi 当前官方文档使用的概念是 **package** 和 **extension**；README 没有把 “plugin” 定义成另一个运行时实体。“plugin”若作为泛称，最接近 Pi package/extension；不能假设存在独立的 plugin manifest 或 plugin API。[packages.md](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/packages.md)；[extensions.md](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/extensions.md)。

* **Extension** 是 TypeScript 模块：导出接收 `ExtensionAPI` 的默认工厂，可注册 tool、command、shortcut、flag、provider，订阅 session/agent/model/tool/input 等事件，持久化自定义 session entry，并可使用 UI。自动发现位置是 `~/.pi/agent/extensions/` 与受信任项目的 `.pi/extensions/`，也可由 settings、`-e/--extension` 或 inline factory 提供。源码通过 jiti 加载，TypeScript 无需预编译。[extensions.md §Quick Start/Locations/Writing](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/extensions.md)。
* **Package** 是分发容器，可来自 npm、git（支持 tag/commit ref）、HTTP/SSH URL 或本地路径。它的 `package.json` 可在 `pi` 键中声明 `extensions`、`skills`、`prompts`、`themes`；没有 manifest 时按 `extensions/`、`skills/`、`prompts/`、`themes/` 约定目录发现。package 还可带普通 npm runtime dependencies、`video`/`image` gallery 元数据；因此一个 package 能同时携带代码、技能说明、可调用 prompt 模板和主题。[packages.md §Package Sources/Structure/Dependencies](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/packages.md)。
* 安装写入 global `~/.pi/agent/settings.json`，`pi install -l` 写入 project `.pi/settings.json`；npm 安装在相应 `npm/`，git checkout 在相应 `git/`。`pi -e` 是当前运行临时安装/加载。`pi list` 枚举，`pi remove` 删除 settings 项。`pi config` 以交互方式逐资源启用/禁用（可切 global/project scope）；manifest/package filter 还可按类型和 glob 缩小加载。[packages.md §Install and Manage/Filtering/Enable and Disable](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/packages.md)。
* 更新分为 Pi 自身和 package：`pi update --self`/`--self --force` 更新自身，`--extensions` 更新 packages，`--all` 两者都做，亦可指定一个 package。npm 未带版本通常随更新解析新版本；git ref 记录的是 pinned tag/commit，更新不会自动移动到新 ref，需重新 `pi install ...@new-ref`。项目 package 在启动时只有项目受信任后才会自动安装缺失项。[packages.md](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/packages.md)。
* global/project 同时出现同一 package 时项目项优先；项目项 `autoload:false` 是例外，可作为对 global 的 delta。源码实现了 `PackageManager`（resolve/install/installAndPersist/remove/update 等）及 `DefaultPackageManager`；可见 [package-manager.ts](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/src/core/package-manager.ts) 与 [resource-loader.ts](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/src/core/resource-loader.ts)。

## 2. Node SDK 直接嵌入

**可以复用，而且是最完整的集成面。** `createAgentSession()` 默认使用 `DefaultResourceLoader`；宿主也可传入自己的 loader。SDK 文档明确导出了 `DefaultResourceLoader`、`getAgentDir`、`DefaultPackageManager`，loader 可读取 extensions、skills、prompts、themes、context files，支持 additional paths、inline extension factories、各类 `no*` 开关和 override。[sdk.md §createAgentSession/ResourceLoader](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/sdk.md)；[index.ts](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/src/index.ts)。

可直接复用的能力包括：

* **Extension API**：`pi.on`、`registerTool`、`registerCommand`、`registerProvider`、`sendMessage`、session entry/label/name、tool allowlist、model/thinking 控制及 session/agent/model/tool/provider hooks。[extensions.md §ExtensionAPI/Events](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/extensions.md)。
* **Skills/prompts/themes**：loader 直接发现并交给 session；skill 采用 Agent Skills 的 `SKILL.md`，启动只把 name/description 放进 system prompt，模型按需读取全文；prompt 是 `/name` 展开的 Markdown，theme 是 JSON 色彩 token。宿主若不需要 TUI，仍可复用 skill/prompt，theme 通常只保留为数据或丢弃。[skills.md](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/skills.md)；[prompt-templates.md](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/prompt-templates.md)；[themes.md](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/themes.md)。
* **Provider extension**：extension 可注册/注销 provider，定义模型、API、streaming、OAuth/API-key 认证、请求/响应转换和 provider hooks；custom-provider 文档还支持覆盖已有 provider。[custom-provider.md](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/custom-provider.md)。
* **Agent/session**：`AgentSession` 管理 prompt、steer/follow-up、事件流、模型切换、compaction、abort；`AgentSessionRuntime` 负责 new/resume/switch/fork/clone/import，并在 runtime 替换后要求重新订阅 session 和重新 bind extensions。[sdk.md §AgentSession/Runtime](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/sdk.md)。

需要 Repa adapter 的地方是 settings/trust/session storage/默认 cwd 语义：`DefaultResourceLoader` 把 `cwd` 用于 `.pi` resources、祖先 `.agents/skills`、`AGENTS.md` 和 session directory，把 `agentDir` 用于 global resources；宿主可传自定义 cwd/agentDir、`SettingsManager.inMemory()`、`SessionManager.inMemory()`，但若想保留 package install/config/trust 体验，就要接入或替代这些 Pi 文件约定。[sdk.md §Directories/Settings](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/sdk.md)。

## 3. Rust 主程序 + `pi --mode rpc`

RPC 是独立 Node 子进程，不是 Rust crate。Rust 可以通过 stdin/stdout JSONL 驱动 Pi 的 agent/session/model/tools/extensions；RPC commands 覆盖 prompt/steer/follow-up/abort、state/messages、model/thinking、queue、compaction、retry、bash、session stats/export/switch/fork/clone/tree/commands，events 覆盖 streaming message、tool execution、agent/turn、queue、compaction、retry、extension errors。[rpc.md §Commands/Events](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/rpc.md)。

`--mode rpc` 启动路径仍创建正常 runtime，并将 CLI 解析出的 extension/skill/prompt/theme paths 和 extension factories 传入 resource loader；所以能运行内置/路径/package 解析出的 extension，前提是该扩展适合 rpc。README/源码的模式分支见 [main.ts](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/src/main.ts) 与 [rpc-mode.ts](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/src/modes/rpc/rpc-mode.ts)。

RPC extension UI 子协议：`select`、`confirm`、`input`、`editor` 是 stdout request + stdin response 的阻塞对话；`notify`、`setStatus`、`setWidget`、`setTitle`、`set_editor_text` 是 fire-and-forget。客户端可显示或忽略后者。`ctx.hasUI` 在 rpc 为 true，但 `ctx.mode` 是 `rpc`，不是 `tui`。[rpc.md §Extension UI Protocol](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/rpc.md)。

降级/无效项：`custom()` 返回 `undefined`；`setWorkingMessage/Indicator`、footer/header、editor component、tools expanded 是 no-op；`getEditorText()` 空字符串、`getToolsExpanded()` false；`pasteToEditor()` 退化为 setEditorText；theme 查询/切换不可用；widget 只支持 string[]，component factory 被忽略。故依赖真实 TUI component、键盘输入、editor state、footer/header/theme 控制的扩展需要 adapter 或在 rpc 下禁用。[rpc.md §Extension UI Protocol](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/rpc.md)。

## 4. 信任模型与常见隐含假设

Pi 明确警告 package/extension 以完整系统权限运行，skill 也能指示模型执行任意动作，安装前应审查源码。[packages.md](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/packages.md)；[security.md](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/security.md)。项目 `.pi` settings/resources/扩展只在项目 trust 通过后加载；非交互模式没有询问框，由 `defaultProjectTrust`、`--approve`/`--no-approve` 决定。[README.md §Project Trust](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/README.md)。

移植 extension 时常见隐含假设：

1. `ctx.cwd` 是当前项目 cwd，`ctx.agentDir`/settings/trust/session manager 是 Pi 的文件布局；扩展可能直接读取 cwd、`.pi`、session JSONL 或环境变量。
2. 默认存在 coding tools `read`, `bash`, Windows 下 `powershell`, `edit`, `write`, `grep`, `find`, `ls`；tool override 例子直接替换内置 tool，Repa 若工具名/输入输出不同须 adapter。[extensions.md §Overriding Built-in Tools](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/extensions.md)。
3. TUI 假设包括 `ctx.mode === "tui"`、可用 `ctx.ui.custom()`、component renderer、terminal keyboard/editor/footer/theme；rpc/print/json 会降级。
4. 生命周期有 session replacement、compaction、retry、streaming 等顺序和 abort signal；长驻进程应在 `session_start` 启动、`session_shutdown` 关闭，不能在可能不启动 session 的 extension factory 中盲目创建。[extensions.md §Long-lived resources](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/extensions.md)。

## 5. 兼容性分级

| 生态类别 | Node SDK 宿主 | Rust + RPC | Repa 不使用 Pi |
|---|---|---|---|
| skill（标准 `SKILL.md`） | **直接复用**，可由 loader 发现或显式注入 | **直接复用**，由 Pi 子进程加载；Repa 只消费行为 | **Adapter**：复用文件和约定，按替代运行时的能力接入发现、注入与按需读取 |
| tool-only extension（不依赖 TUI） | **直接复用** | **直接复用**，工具调用和结果走 RPC events | **Adapter**：重写 ExtensionAPI/tool schema 到 Repa tool API |
| provider extension | **直接复用**，Node 侧认证/streaming/provider registry 均可接 | **直接复用**，由 Pi Node 进程持有 provider；Rust 只驱动模型 | **基本不可直接复用**，需适配所选 provider/auth/stream 接口 |
| commands/dialogs | **直接复用**；SDK 中 command 仍可调用，但 UI 要宿主提供 | **部分复用/Adapter**：四类 dialog 有 subprotocol，需客户端应答 | **Adapter**：命令解析、交互与状态需接入所选宿主 |
| custom TUI | **直接复用**，需嵌入/使用 Pi TUI 运行时 | **基本不可直接复用**；`custom()` 等降级 | **基本不可直接复用**，需按所选前端适配或替代 |
| coding-tool override | **Adapter**：若 Repa 工具契约同构才可直连 | **Adapter**：Pi 内覆写后通过 RPC 暴露，不是 Rust 本地覆写 | **Adapter/重写** |
| session-internals（append entries/tree labels/runtime replacement） | **直接复用**，但宿主需遵守 Runtime 重绑语义 | **部分复用**：RPC 有 fork/tree/entries 等命令，不能任意使用 Node 对象 | **基本不可直接复用**，需映射到 Repa session model |
| theme | **直接复用**仅对 Pi TUI；非 TUI 仅可读取数据 | **基本不可用**：RPC `getAllThemes/getTheme/setTheme` 降级 | **基本不可直接复用** |

## 6. Pi 的核心工程收益（官方证据范围）

* `pi-ai`/provider 层提供多模型 provider、API key/OAuth、自定义 provider、模型目录和 streaming；README 的模型选项列出 provider/model/thinking，custom-provider 文档给出认证与流式 API。[README.md](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/README.md)；[custom-provider.md](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/custom-provider.md)。
* `pi-agent-core`/AgentSession 提供 agent loop：prompt、tool calls、steer/follow-up 队列、message/tool streaming、abort/cancellation、model/thinking state 和事件流。[sdk.md](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/sdk.md)。
* SessionManager 使用带 `id`/`parentId` 的 JSONL 树，可 resume、branch、fork、clone、navigate tree、标注；Runtime 管理会话替换。[sdk.md §Session Management](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/sdk.md)。
* AgentSession 内置 compaction 和 auto-retry，并以事件暴露 compaction/retry/summarization retry；这些不是 extension 才能拼出的外围约定。[sdk.md §Events](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/docs/sdk.md)。
* tools、extensions、skills、prompts、themes 是可配置资源；README 明确把工作流能力放到这些扩展面，核心保持最小。[README.md §Customization/Philosophy](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/README.md)。
* TUI、SDK、RPC 是三种消费边界：默认模式是交互 TUI；Node 宿主调用 SDK；非 Node 宿主用严格 LF-delimited JSONL RPC。[README.md §Programmatic Usage/Modes](https://github.com/earendil-works/pi/blob/8fa7eebd235355522c8104166b4f1f959b4e2f10/packages/coding-agent/README.md)。

## 7. 三种架构选择

1. **Node SDK 架构（复用最高）**：Repa 直接调用 `createAgentSession`/Runtime，注入自己的 cwd、settings、session manager、tools 或 loader；可保留 Node extension、provider、skills、prompts、Pi session/compaction/retry/streaming。代价是 Repa 接受 Node/TypeScript runtime 与 Pi 的生命周期和资源布局，或明确写 adapter。
2. **Rust + RPC 架构（复用中高）**：Repa 保持 Rust 主进程和自己的 UI/产品边界，Pi Node 子进程承载 agent/model/auth/tools/extensions/session。tool-only/provider/skill 复用度高；TUI custom、theme、editor/footer 只能降级；要实现可靠交互，Rust 必须实现 JSONL command/event 与 extension UI request/response。
3. **不使用 Pi（需选择替代运行时）**：可迁移 `SKILL.md`、Markdown prompts、JSON themes 及相关工具约定，但需要为模型连接、认证、Agent loop、会话、重试、压缩、流式执行和扩展选择并整合替代能力。这些能力可以来自其他 SDK 或成熟组件，也可以按需要自研。Pi 没有承诺跨宿主 ABI，原有 Pi Extension 的直接兼容性需要另行适配；失去 Pi 的统一实现与扩展兼容性，不等于所有通用能力都必须从零重写。

## 8. 关键限定

* 上述“可直接复用”指在 Pi Node runtime 中按官方 API 运行，不表示能把 TypeScript extension 编译成 Rust 原生插件。
* RPC 能加载并运行 extension/package 资源，是因为 Pi Node 进程仍执行 `DefaultResourceLoader`/package resolution；Rust 端仅是协议消费者。
* package/extension/skill 均是信任边界内的任意代码或任意模型指令；Repa 若把它们暴露给不受信项目，必须自行增加沙箱、审批或资源白名单。Pi 官方文档只提供 trust gating，不宣称 sandbox。

## 9. Pi 0.84.3 的包入口边界补充

本节依据当时锁定的 0.84.3 发布包中 `package-manager`、`resource-loader` 和 `extensions` 的类型与实现，以及使用 `SettingsManager.inMemory()` 的本地包解析探针。核验范围是包发现、位置解析与资源过滤，没有安装网络包、创建 AgentSession 或调用模型。

`PackageManager.listConfiguredPackages()` 与 `getInstalledPath()` 可以在没有 Agent 运行实例时取得已配置包及其位置，因此 Repa 可以复用包来源与定位，再读取各宿主所需的入口信息。Pi 的工具执行仍要求 `ExtensionContext`，其中包含会话管理、模型和会话 UI 等能力；Extension loader 创建的运行时动作在 runner 绑定前是抛错占位。这两种接口分别服务包管理和会话中的扩展执行，不能将任意 Pi 工具直接视为独立后台函数。

本地目录解析还有一项兼容细节：`resolveLocalExtensionSource()` 在目录没有 Pi manifest 或约定资源目录时，会把整个目录回退登记为 Extension。仅添加自定义 Repa 入口元数据不会改变这条规则。

| 本地解析条件 | Extension 数 | Skill 数 | prompt 数 |
| --- | --- | --- | --- |
| 只有自定义 Repa 入口声明，作为普通本地包直接交给 Pi | 1 | 0 | 0 |
| 同一目录由宿主将四类 Pi 资源过滤为空 | 0 | 0 | 0 |
| 仓库已有的 Pi 测试包，沿用原声明 | 1 | 1 | 1 |

空过滤使用现有 package filter 的 `extensions`、`skills`、`prompts`、`themes` 空数组完成，Repa 入口文件保持为普通包文件。上述结果支持在宿主适配层分别装配包的 Agent、后台和前端部分，而不是将全部已安装包原样交给 Pi 的扩展发现规则。各类 Repa 入口的公开字段和运行契约仍属于待定义的宿主接口。

## 10. Pi 0.84.3 的工具与服务复用边界

本节核对当时锁定的 0.84.3 发布包中的 `package.json`、`dist/index.d.ts` 及下列模块的类型和实现。编辑行为通过公开工具工厂与内存 I/O 复现，没有调用模型或写入实际内容文件。

| 能力 | 已有入口与实现 | 接入时保留的 Repa 责任 |
| --- | --- | --- |
| 读取、编辑与写入 | `createReadToolDefinition`、`createEditToolDefinition`、`createWriteToolDefinition` 及各自的 `operations`；模块为 `dist/core/tools/{read,edit,write}` | 授权、内容身份与修订、共同提交和资源关系；编辑行为须符合正文契约 |
| 命令执行 | `createBashToolDefinition` 的 `BashOperations.exec`；工具外层已有流式输出、截断及完整输出保留 | 实际执行环境、权限与取消收尾；替换执行器不自动提供沙箱 |
| 会话工作视图 | `SessionManager.buildContextEntries()`、`buildSessionContext()` 与分支查询，位于 `dist/core/session-manager` | Repa 语境快照的来源、比较与回填，以及公共数据投影 |
| 凭据与认证 | `ModelRuntime.create({ authPath, credentials })`，位于 `dist/core/model-runtime` | 凭据位置、具名连接和实际认证关联；该版本的内部 `AuthStorage` 类未从包入口导出 |
| Pi 运行设置 | `SettingsManager.fromStorage()`、`applyOverrides()` 等公开方法，位于 `dist/core/settings-manager` | Repa 的作用域、有效值来源、完整值覆盖与插件设置语义 |

包安装与定位继续使用第 9 节所述入口。工具 I/O 的可替换性提供了接入位置，不能单独证明修改协调已经成立：`withFileMutationQueue` 只串行化同一文件的修改，不覆盖多文件操作，也不自动协调其他前端入口。

`edit` 的 `applyEditsToNormalizedContent` 在精确匹配失败后使用规范化文本定位，再将受影响的行覆盖到原文本；范围外的其他行保留，但受影响行中未选中的字符仍可能改变。原文 `公式 x²；标记：ＡＢＣ`，以 `oldText: "ABC"`、`newText: "DEF"` 调用公开编辑工具，实际写回为 `公式 x2;标记:DEF`。同一验证中的下一行 `其他行 x²` 保持原样。实现还会先统一换行，再按检测到的样式恢复；混合 CRLF/LF 文件中未编辑行的换行也可能改变。相应实现位于 `dist/core/tools/edit.js` 与 `edit-diff.js`。

Codex 对比基准为固定提交 [`3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`](https://github.com/openai/codex/tree/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a)，以下为源码与相邻测试核对，未运行其 Rust 测试：

- [`seek_sequence.rs`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/apply-patch/src/seek_sequence.rs) 依次尝试精确、空白宽松和特定 Unicode 标点比较，返回匹配位置；比较过程不修改原行。其规则与 Pi 的整段 NFKC 规范化不同，不能假定两者接受相同输入。
- [`file_update.rs`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/apply-patch/src/file_update.rs) 的 `PreserveLineEndings` 路径按补丁的上下文行分隔实际替换，保留上下文原文；[`text_file.rs`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/apply-patch/src/text_file.rs) 保存各行原有的换行方式并据此重建文件。
- 该版本 [`ApplyPatchOptions` 的默认模式](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/apply-patch/src/lib.rs#L62-L95) 是 `NormalizeToLf`；保留换行的路径仍沿用补齐末尾换行的约定。补丁按行替换，与 Repa 的局部文本替换粒度也有区别。

可借鉴的机制是将定位时的宽松比较与实际修改分开，并从原内容保留未修改部分。采用范围仍以 Repa 的正文、冲突及恢复契约为准；有针对性地补足或替换不匹配的行为，其他适用工具和运行能力继续复用。

## 11. Pi 0.84.3 的提示装配入口与边界

本节核对 0.84.3 发布包的 `dist/core/resource-loader.d.ts`、`system-prompt.js`、`agent-session.js`、`extensions/types.d.ts`、`extensions/runner.js` 与 `compaction/compaction.js`，属于类型与源码核验，未调用模型。

- `DefaultResourceLoader` 提供 `systemPrompt`、`appendSystemPrompt`、`noContextFiles`、`noSkills` 及相应资源覆盖入口。项目文件可以通过 `agentsFilesOverride` 选择，Skill、prompt 等资源沿用原有加载与过滤。
- `buildSystemPrompt` 使用 `if (customPrompt)` 区分自定义与默认分支，所以空字符串不表示完全禁用。非空自定义提示后仍可能追加项目说明、Skill 清单和当前工作目录；只替换基础文本不能证明最终输入已经完全受控。
- `before_agent_start` 接收已组装的系统提示和构造选项，并可返回替换后的 `systemPrompt`。runner 和 session 使用 `!== undefined` 判断该返回值，因此这个入口能表达显式空内容；多个扩展会链式处理，接入时仍需核对贡献顺序和最终结果。工具文字指导由 `promptSnippet`、`promptGuidelines` 等工具定义字段提供。
- 默认压缩生成器将 `customInstructions` 追加到既有模板，内部另有摘要系统提示；它不等于完整模板替换。`session_before_compact` 可接管摘要结果，`session_before_tree` 提供摘要及指令替换入口。Repa 需要完全控制辅助调用的提示时，应在这些生命周期边界选择适配方式，继续复用准备数据、计量、记录与恢复机制。

## 12. Pi 0.87.1 的接入与升级

当前依赖锁定为 `@earendil-works/pi-coding-agent@0.87.1` 与 `pi-ai@0.87.1`，TypeBox 对齐为 1.3.27。本节依据发布包、[v0.87.1 源码](https://github.com/earendil-works/pi/tree/v0.87.1)、[changelog](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/CHANGELOG.md) 及仓库集成测试。

### 提示与会话投影

- provider 接收 `TranscriptContext`，系统提示与工具声明位于消息中。消费方使用 `getCurrentSystemPrompt()`、`getCurrentTools()` 解析，不能继续假定存在顶层 `context.systemPrompt` 与 `context.tools`。
- `before_agent_start` 可以提供强制系统提示，`context_with_system` 对完整请求提供变换入口。Repa 采用这两处正式扩展事件，覆盖普通请求、工具后续轮以及扩展命令直接触发模型的路径；删除原有的 `prepareNextTurnWithContext`、`transformContext` 包装和 Agent 状态写入。接口见[扩展文档](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/extensions.md#context_with_system)。
- `SessionManager.buildSessionProjection()` 成为 SDK 请求与计量的权威来源。Repa 通过只适配投影查询的局部代理加入自己的来源过滤与压缩回填，同时保留每条消息的历史来源。单独使用发送前的 context hook 不会改变 SDK 更早进行的压缩判定；直接赋值 `agent.state.messages` 也不能控制下一次请求。依据为 [AgentSession](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/core/agent-session.ts) 的请求准备与阈值压缩，以及 [estimateProjectedContextTokens](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/core/compaction/compaction.ts)。
- 新增的 `context_edit` 可以排除或替换消息对模型上下文的贡献。Repa 回填时尊重显式编辑，不修改原始交流历史。它不是学习语境的第二份权威存储。
- 流式执行中的 `sendCustomMessage({ triggerTurn: false })` 会延后追加。Repa 的文件变化告知在模型请求前，通过公开会话追加与刷新接口保存并提供一次，不插入尚未配对的工具调用和结果之间。

### 工具复用与保留差异

`read` 继续复用 Pi 的参数、截断与图片处理；`edit`、`write` 复用适用的工具定义和展示，确定的内容修改通过 Repa 共同入口保存。内容基准、跨文件恢复和资源关系属于 Repa。

对 0.87.1 的公开 `createEditToolDefinition` 使用内存 I/O 核验，未写入实际内容文件：将 `公式 x²；标记：ＡＢＣ` 中的 `ABC` 替换为 `DEF`，实际得到 `公式 x2;标记:DEF`，下一行未参与编辑的字符保持不变；混合 CRLF/LF 文本编辑中间行后，其他行的换行仍可能统一。第 10 节记录的差异继续成立。Repa 保留定位与写回分离的实现，具体理由及其可重新评估部分见 [ADR 0003](../adr/0003-share-file-based-content-operations.md#编辑与保存)。

### 通用 Agent 原语与应用边界

以下为 0.87.1 发布包的公开导出、类型与实现核验；新增接入仍需在对应功能实现时验证实际路径。

- [AgentSession](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/core/agent-session.ts) 已有 `steer()`、`followUp()`、带图片的 `prompt()` / `sendUserMessage()`、队列查询与清除、工具启停、模型和思维强度选择。`abort()` 与 `waitForIdle()` 处理实际空闲边界，包含运行后续处理；上层不以一次流结束代替整个工作完成。
- [ModelRuntime](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/core/model-runtime.ts) 提供模型发现、认证检查、登录注销及带认证的 `stream()` / `complete()`，可直接处理明确输入而不创建会话。`AuthStorage` 及其存储后端已不再公开导出，见[变更记录](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/CHANGELOG.md)；需要其他凭据存储时使用 pi-ai 的 `CredentialStore`。具名连接身份及多连接选择仍由 Repa 持有。
- [命令工具](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/core/tools/bash.ts) 的 `BashOperations.exec` 接收工作目录、输出回调、取消信号、超时与环境，可将实际执行交给沙箱适配器；工具工厂继续承担参数、输出截断和结果组织。Pi 的项目信任不构成命令隔离，具体限制由执行环境落实。
- `grep`、`find`、`ls` 提供基本文件检索，但可替换接口的覆盖范围需逐个核对。例如 [grep](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/core/tools/grep.ts) 的 operations 只替换目录判断和上下文读取，检索仍自行启动 `rg`。只替换读文件回调不足以证明整个搜索处于 Repa 授权范围内；内容身份、修订、材料表示和会话搜索也仍需对应能力接入。
- [DefaultPackageManager](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/core/package-manager.ts) 提供安装、更新、移除、配置来源与资源解析。Agent 工具、Skill 和提示继续走现成加载器；Repa 只补共享后台/前端入口和按需生命周期。实验性 client/plugin/server 在该发布版中仍是源码专用入口，不作为当前发布 SDK 的稳定应用协议替代品。
- [服务装配](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/core/agent-session-services.ts) 将 cwd 相关设置、模型与资源加载同会话创建分开，可评估用于收缩手工装配。[AgentSessionRuntime](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/core/agent-session-runtime.ts) 切换会话时先拆卸当前运行，不能直接代替 Repa 的多会话并行与独立查看语义。
- Pi 的输入队列承担运行期间的投递，不提供 Repa 的请求身份、绑定配置、持久排队与进程恢复记录。`SessionManager` 仍推迟无助手消息会话的首次落盘；Repa 立即发布空会话身份的适配有继续保留的依据。

当前应用接法与实施范围见 [Agent 开发说明](../development/agent-runtime.md#sdk-能力与接入范围)。

### 验证与维护范围

回归通过真实 SDK 和本地 faux provider 观察最终模型输入，覆盖空提示、关闭来源、工具后续轮、扩展直接请求、压缩回填及旧会话接续；投影测试检查消息与来源对应，并使用 Pi 自身的估算函数。0.84.3 生成的 JSONL 样本用于检查旧条目和原文件前缀保留。源码与具体测试入口见 [Agent 开发说明](../development/agent-runtime.md#sdk-升级与验证)。

升级的机械迁移、上游差异阅读和场景验证可以由 Agent 执行，验收仍依据 Repa 已确定的行为。上游承担了等价职责时删除相应兼容代码；尚有语义差异时，在所属边界保留适配并记录原因。这里记录的是当前版本的接入证据，真实 provider 行为、其他平台与长期使用规模仍由对应验证说明。
