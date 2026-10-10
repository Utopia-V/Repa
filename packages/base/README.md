# Repa 底座骨架

`@repa/base` 把空间文件、长期状态插件和 Agent 会话接到一个本机协议上。Web 与 Desktop 已通过它连接本机服务；学习插件与领域界面接入留给后续任务。旧后端和领域包从 `pre-rebuild` 标签取用。

## 使用

在仓库根目录运行，要求 Node.js 22.22.2 以上与系统 Git：

```sh
npm ci
npm run build --workspace=@repa/space-history
npm run build --workspace=@repa/base
npm run start --workspace=@repa/base -- serve --home /path/to/repa-home
```

服务只监听 `127.0.0.1`，stdout 输出一行 `{ "url": "ws://…/rpc", "token": "…" }`。启动方应把这行内容当作私密连接信息交给客户端，不放进公开日志。省略 `--home` 时使用 `REPA_HOME`，再回退到 `~/.repa`；`REPA_TOKEN` 可提供已有令牌，否则随机生成。`--port` 默认自动分配，SIGINT、SIGTERM 会等待资源关闭。

加载示例插件：

```sh
npm run start --workspace=@repa/base -- serve \
  --home /path/to/repa-home \
  --plugin "$PWD/packages/base/examples/notes-plugin.ts"
```

`--plugin` 可重复，模块导出 `default` 或 `plugin`。这些模块是本机可信代码；这里提供显式加载入口，安装、发现和版本管理不属于本次骨架。

浏览器从独立子路径引用客户端：

```ts
import { RepaClient } from "@repa/base/client";

const client = await RepaClient.connect({ url, token });
client.on("session.event", event => renderEvent(event));
client.on("confirm.request", async ({ id, request }) => {
  const value = await askUser(request);
  await client.call("confirm.reply", { id, value });
});
await client.call("space.open", { root: "/path/to/space" });
const session = await client.call("session.create", {});
await client.call("session.send", { sessionId: session.id, text: "查看这个空间" });
```

`askUser` 和 `renderEvent` 由前端实现。命令确认返回布尔值，登录输入和选择返回字符串，取消返回 `null`；`display` 展示链接或进度，阅读后回复即可。登录确认只交给发起连接，其他连接不能代答。

客户端不自动重放请求。连接中断或显式设置的请求超时会返回 `ConnectionError`，其中 `outcome` 为 `unknown`；重连后读取 `session.history` 与当前插件状态，再判断原操作的结果。普通调用默认等待完成，连接与初始化限时 15 秒。

`connect` 已完成 `initialize`，调用方不需要再初始化一次。用 `onConnectionChange` 订阅断线，返回的函数用于取消订阅；客户端本身不自动重连。两个前端的连接层在断线后重新向宿主取得连接信息，再连接服务，沿用现有断线提示。

Node 宿主通过独立子路径拉起服务：

```ts
import { startRepaProcess } from "@repa/base/process";

const backend = await startRepaProcess({ home: "/path/to/repa-home" });
const client = await RepaClient.connect(backend.connection);
// 宿主退出时先关闭客户端，再等待后端释放空间和会话。
await client.close();
await backend.close();
```

共享入口启动构建后的 `repa-base serve`，读取 stdout 的连接信息，不写连接文件。Web 开发服务器关闭和 Electron 退出时，各自等待后端收尾；客户端断开本身不关闭服务。Electron 使用 `nodeExecutable` 和 `environment` 传入自身可执行文件与 `ELECTRON_RUN_AS_NODE=1`。`closed` 可用于观察进程退出，`close()` 可以重复调用并等待正常收尾；异常退出会返回错误。只有启动失败的进程回收设置 5 秒强制终止期限。这个 Node 入口不从浏览器客户端导出。

## 结构与责任

四个模块的接口在 [`space.ts`](src/space.ts)、[`agent.ts`](src/agent.ts)、[`plugins.ts`](src/plugins.ts) 和 [`protocol.ts`](src/protocol.ts)。协议服务负责装配与生命周期，插件宿主只接收空间、模型接口和事件回调，不依赖协议。Agent 库只出现在 `src/agent/` 内部。

采用一个包的子路径导出，而不是再建两个小包：`@repa/base/client` 与 `@repa/base/protocol` 的运行依赖保持浏览器可用；`@repa/base/plugin` 提供插件作者的接口类型，不引入宿主实现。插件通过 `import type` 使用 `Plugin`、`Host`、`Tool` 等接口。

```text
<home>/agent/                 模型凭据、自定义模型、Agent 设置和 skills
<home>/settings.json          命令策略、最近 20 个空间、应用提示覆盖
<space>/.repa/lock/           带心跳的跨进程排他锁
<space>/.repa/sessions/       会话记录
<space>/.repa/history.git/    影子 Git
<space>/.repa/plugins/<id>/   插件自有数据
<space>/.repa/prompts.json    空间提示覆盖
```

每个服务当前持有一个活动空间，多个授权连接共享它。切换空间会关闭原空间的会话与插件，再释放锁。锁使用 `proper-lockfile`；进程异常退出后的陈旧锁在 30 秒后可回收，正常关闭立即释放。

一次 Agent 运行包在 `space-history.record` 内，工具写入归入这次运行；运行结束的通知在历史提交完成后发出。会话内保留一个 `runId` 关联条目，重连后可用它找到影子 Git 中对应的修订并撤回。插件独立文件写入使用自己的来源。外部编辑由监听器收集，通知只负责唤醒插件，插件再用 `history.changes(cursor)` 拉取变化。插件启动也会追赶，游标及领域状态由插件自己维护。

空间宿主在打开及每次历史提交后安排一次维护检查，等待 30 秒没有新提交后调用 `history.maintain()`。松散对象达到 1,024 个或 pack 达到 32 个才打包；失败交给 `onError` 并重新等待，关闭空间时则等待最后一次检查和维护完成后释放锁。维护与活动共用历史队列，永久保留历史，不裁剪提交或不可达对象。测量、成本和调用约定见[空间历史维护](../space-history/README.md#历史维护)。

`record` 动作持有历史队列，因此应先读取历史，再进入动作。动作内的 `files.write` 自动加入当前活动；显式嵌套 `history.record`，或在动作内调用 `history.list/changes`，会返回明确错误而不是死锁。插件界面方法即使只更新自己的数据目录，也会触发一次状态唤醒。

[`notes-plugin.ts`](examples/notes-plugin.ts) 演示完整插件接口：说明、工具、少量 view、变化追赶、前端方法与关闭；还通过 `rewrite`、`summarize`、`organize` 演示三种模型入口。内部 notebook 子插件由父插件构造 Host，只能通过文件接口访问 `notes/`，数据目录也落在父目录下。后台 Agent 工作的 id 就是会话 id，前端用会话事件查看进度，用 `session.abort` 取消。排队任务收到取消后不会调用模型；如果空间正被前一活动占用，取消的完成响应会等待它取得队列并收尾。队列与任务句柄都只在内存中存在。

## 提示、状态与缓存

基础说明、空间根目录的 `AGENTS.md`、Skill 目录、工具说明和每个插件的说明各占一段。Skill 来源限于 `<home>/agent/skills/` 和 `<space>/.repa/skills/`。有效配置按默认、应用覆盖、空间覆盖依次合成；编辑文本、停用和恢复默认分别通过 `prompt.set/reset` 完成。`prompt.preview` 返回有效分段和单列的 view，与运行采用同一分段装配代码。

运行开始时读取一次 view，与最近的有效版本比较，变化才通过 Pi 的 `nextTurn` 队列追加。这样首轮也是先放系统提示与工具声明，再放用户消息和 view；以后删除旧 view 就不会改变稳定前缀的位置。默认每个来源累积 3 份旧版本后，在回合结束时批量清理，下一次请求使用清理后的上下文；缓存已过期时提前清理，寿命采用模型公开的 short 缓存寿命作保守判断。压缩不把旧 view 当成会话事实写入摘要，完成后补回最新一份。清理使用追加的上下文编辑记录，原始会话证据仍保留。

缓存保温使用内嵌运行时的 idle 策略，在模型声明缓存寿命、估算收益达到内置门槛时请求。每个 Agent 模型回复以及保温、压缩的 usage 都可从会话记录或事件中核对 `input`、`output`、`cacheRead`、`cacheWrite`。`input` 是非缓存输入，完整输入为 `input + cacheRead + cacheWrite`；一次压缩可能包含两个模型请求，会话条目保存其合计。Pi 把服务未提供的缓存计数映射为 0，因此判断字段是否真的被报告还需检查原始响应。真实 Codex 的用量、清理代价和保温限制见[核实报告](../../docs/research/base-real-model-check.md)。

## 协议入口

协议版本为 `1`，采用带令牌的 JSON-RPC 2.0 WebSocket。参数、响应与通知类型见 [`protocol.ts`](src/protocol.ts)。

| 组 | 方法 |
| --- | --- |
| 连接 | `initialize` |
| 空间 | `space.list/open/create/close` |
| 会话 | `session.list/create/history/send/steer/followUp/abort/setModel/compact/fork` |
| 确认 | `confirm.reply`，通知 `confirm.request` |
| 历史 | `history.list/changes/undo` |
| 插件 | `plugin.list/call`，通知 `plugin.event` |
| 提示 | `prompt.list/set/reset/preview` |
| 模型 | `model.list`、`auth.login/setKey/logout` |
| 设置 | `settings.get/set` |

运行增量、工具调用、usage 和起止通过 `session.event` 通知。`session.send` 等待整次运行；运行中的 `steer/followUp` 使用内嵌运行时的队列。无发起连接的后台命令在询问策略下无法取得授权，会被阻止；Full Access 是显式设置，不由插件自行提升。

## 本次实现的决定与核实

- **提示段名适配**：Pi 0.87.1 不接受含冒号的段名。公开来源仍为 `plugin:<id>`，内部无碰撞编码；段落保留可读来源标签，对外历史转换回 Repa 来源。SDK 的完整提示渲染函数不在公共导出中，因此预览提供实际采用的命名分段，不复制 SDK 渲染器或额外创建预览会话。
- **第一条用户消息的持久化**：Pi 新会话默认延迟到首次 assistant 才写文件。这里先创建空文件，再用公开 `SessionManager.open` 让 Pi 建立自己的 header；之后 user、tool 和 assistant 均走正常 SDK 追加路径。
- **回合结束编辑上下文**：真实 SDK 会话已验证 `agent_before_settle` 返回 `context_edit`，旧 view 从下一次请求中消失，原记录保留。没有修改消息对象、代理 SessionManager 或匹配内部提示字符串。
- **压缩恢复**：公开 `session_compact` 钩子发生在压缩记录和上下文刷新之后、重试请求之前；在这里通过公开追加及刷新接口补回 view，兼顾手动和自动压缩路径。
- **登录映射**：真实 `ModelRuntime.login` 配合本地脚本化 OAuth 提供方，经 WebSocket 完成链接展示、选择、授权码、密文输入、持久化和登出。`auth.setKey` 使用原生 API-key 登录保存凭据；需要多步环境配置的提供方使用 `auth.login`。

## 已知限制

- **Pi 0.87.1 的 view 身份检查已有[本地补丁](../../patches/@earendil-works+pi-coding-agent+0.87.1.patch)。** SDK 重建 custom message 对象后，补丁按内容判断请求前缀仍然有效，本地 SDK 测试覆盖含 view 的原生保温；本轮回归又发现补丁仍受 view 时间戳差异影响，详见下方升级评估中的基线缺口。锁定 Codex 模型目录没有声明缓存寿命，所以本次真实服务仍不启动保温；Codex 适配器也没有传递保温要求的 1 token 输出上限。保温续期效果仍待具备这些条件后核实，不能用正常对话的缓存命中代替。
- `~/.repa/agent/auth.json` 中的 Codex OAuth 已验证真实请求、锁内刷新、轮换结果持久化和刷新后接续。首次交互登录仍由原有脚本化提供方测试覆盖；真实核实脚本复用已有登录。
- 影子 Git 按所属包的规则排除 `.repa/`、用户 Git、嵌套仓库、忽略项和大文件。因此 `history.undo` 撤回空间文件，不回滚插件数据库、会话或设置。插件根据变化流更新自己的状态。
- 插件是可信本机代码，文件接口的路径检查不是进程沙箱。通用命令与文件工具沿用内嵌运行时的权限语义；命令在询问模式下须确认。空间外部写入不属于影子 Git 的撤回范围。
- 外部编辑器不受内部活动队列协调；恰好发生在运行期间的外部修改可能归入该运行。进程突然退出时，未提交内容在下次打开归为外部变化。空间历史永久保留，维护只整理对象布局。

## 验证入口与交付统计

```sh
npm run check --workspace=@repa/base
npm run build --workspace=@repa/space-history
npm run build --workspace=@repa/base
npm test --workspace=@repa/base
npm test --workspace=@repa/space-history
```

普通测试使用临时空间与真实 Git、WebSocket、SDK、CLI 子进程，模型服务边界为脚本化假提供方。真实模型核实独立运行，避免 `npm test` 消耗订阅额度：

```sh
npm run real-model-check --workspace=@repa/base -- --output /tmp/repa-real-check.jsonl --limit 30
```

2026-10-10 的收尾检查使用本 worktree 自有依赖、Node.js 24.20.0 和 Git 2.43.0：两个包的类型检查和构建通过，`space-history` 的 53 项测试全部通过；`base` 的 62 项测试中 61 项通过，唯一失败为原有含 view 保温回归，原因见下方[缓存补丁的基线缺口](#缓存补丁为什么仍然需要)。新增维护、宿主、用量和工具取消回归均通过，脚本 `--help` 入口通过。真实服务证据沿用冻结报告，本轮验证用真实 SDK 与离线提供方完成。

脚本先构建当前公开入口，使用临时空间和笔记插件，结果文件必须不存在。默认读取 `~/.repa/agent`，也可用 `--agent-dir` 指定。运行前关闭使用同一 Agent 目录的 Repa 进程；脚本临时调整 Agent 设置，正常收尾按原字节恢复，刷新后的凭据由 Pi 保留在原文件。恢复发生冲突时保留设置副本并报告其本机位置。`--skip-refresh` 跳过显式 OAuth 刷新检查；真实调用会使用订阅额度。

### 例行核实改用 Pi 用量记录

脚本现在直接汇总公开 `session.history` 中 Pi 保存的 usage。`input` 仍为非缓存输入，完整输入为 `input + cacheRead + cacheWrite`，命中率为 `cacheRead / 完整输入`；没有输入时命中率为 `null`。每步保留助手、压缩及保温条目的原用量，并提供同口径合计。压缩可能包含两份摘要请求，Pi 保存它们的合计，因此脚本也只报告一个压缩操作的用量。

`--limit` 的单位改为 **Pi 模型操作数**：助手消息数加压缩条目数加保温条目数，不是 HTTP 请求数。每次发送或手动压缩前检查剩余额度，自动压缩和重试关闭；一次发送或压缩等待超过 90 秒时取消会话。意外工具响应在宿主同步事件中取消，阻止工具执行与后续模型调用。Pi 额外保存的零用量取消助手消息也计入助手消息数，所以异常终态的条目数可能超过开始前预留的一个名额，但不表示多发了对应数量的请求。

OAuth 刷新不计入模型操作数。对话设置仍使用 SSE，压缩则交给 Pi 自己选择传输。锁定 Codex 目录没有缓存寿命声明，因此当前组合不会产生自动保温；idle 观察字段改为 `modelOperationsDuringIdle`，明确只统计 Pi 历史中出现的操作。

HTTP 拦截层和其测试分别删除 **425 行、435 行，共 860 行**。连同用量汇总替换、工具续轮守门和离线测试，本项新增 228 行、删除 925 行，净减少 **697 行**（相对 `d6bf108e9`，只统计核实脚本及其测试）。保留 token 用量原义所需的数据都有 Pi 记录，因此不再保留 HTTP 拦截办法。原记录中下列诊断无法从 Pi 恢复，已从新输出中移除：

- HTTP/OAuth 尝试次数、状态、耗时和被阻止的 WebSocket 次数。
- 每个压缩子请求的分项用量，以及服务端缓存字段是缺失还是明确返回 0。
- 线上 input 项数、公共前缀项数、instructions 字符数和请求中的 view 数。
- 原始响应与 Pi usage 的逐次比较，包括 `usageMatchesRaw`；新的合计不再沿用 `totalRequests` 的字段名。

失败记录中的合计仅覆盖 Pi 已保存的条目。例如，第一份压缩摘要成功、第二份失败时，Pi 不保存压缩合计，已成功子请求的用量也无法恢复。这种失败的实际 token 总数未知，缺少条目不能解释为消耗 0。前缀结构仍由既有真实 SDK 接入测试核对；例行真实脚本检查回复与状态是否匹配，不再重复采集线上请求正文。

上一轮[核实报告及冻结数据](../../docs/research/base-real-model-check.md)保留原貌，其中 HTTP 请求数和传输诊断仍表示当时实际观察到的值；运行当前脚本以本节说明为准。用新的汇总口径离线重算 `run-05` 的 Pi usage，非缓存输入 **18,003**、完整输入 **33,363**、输出 **438**、缓存读 **15,360**、缓存写 **0**，命中率 **46.039%**，与原报告的 token 数一致。17 条助手消息加 1 次压缩为 18 个 Pi 模型操作；原报告的 19 次模型请求并没有被改写成 18 次请求。

离线用量测试使用锁定的真实 SDK 和 faux provider，核对两份摘要合并为一项压缩用量、汇总与 `getSessionStats()` 一致，以及工具取消后不写文件、不发续轮。当前脚本的命令入口、类型和离线行为均已验证；本轮真实服务的执行结果仍以既有冻结核实为证据。

## Pi 1.1.0 升级评估（仅评估）

当前底座仍锁定 `@earendil-works/pi-ai` 和 `@earendil-works/pi-coding-agent` 0.87.1。2026-10-10 核验时，npm `latest` 为 1.1.0；npm 在 2026-10-07 22:16:26 UTC 发布，GitHub release 在当天 22:26:31 UTC 发布。调查固定使用 `v0.87.1`（`f07218c4d4bbc12bef056a7058c3dd49dfe41abe`）、`v1.1.0`（`abe508e1b89912adde45528136c3221eb69acdd7`）以及对应 npm 发布包。升级依据采用固定 tag 和发布包。[官方发布](https://github.com/earendil-works/pi/releases/tag/v1.1.0)、[npm 包](https://www.npmjs.com/package/@earendil-works/pi-coding-agent/v/1.1.0)。

1.1.0 值得作为下一次小范围升级的目标。底座目前使用的原生会话、命名系统提示、队列和上下文编辑入口仍然存在，因而不需要重写 Agent 接入。新增的图像、分类、虚拟模型和 MCP/codemode 也不要求一起接入。不过，含 view 的缓存保温补丁仍有必要，新 `openai` OAuth 还需要宿主提供安装标识，因此升级不是只改两个版本号。[SDK](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/sdk.ts)、[登录实现](https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/src/auth/oauth/openai-chatgpt.ts#L225-L238)。

### 已使用入口的兼容性

| 底座使用入口 | 0.87.1 → 1.1.0 的核对结果 | 升级时需要处理什么 |
| --- | --- | --- |
| `createAgentSession` | `cwd`、`agentDir`、`modelRuntime`、`model`、`sessionManager`、`settingsManager`、`resourceLoader` 和 `customTools` 保留。`tools` 增加通配符与全列表 `+name`／`-name` 修饰符，普通精确名称白名单仍可使用。[SDK 参数](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/sdk.ts#L32-L106) | 当前普通工具名称可沿用。插件名称若含 `*` 或以 `+`／`-` 开头，会被新选择语法解释，接入边界应拒绝此类歧义名称。 |
| `DefaultResourceLoader` | 普通 `extensionFactories` 与 `builtin: true` 工厂分开；`noExtensions` 控制资源路径发现，普通 inline factory 仍加载。SDK 创建的 loader 不会自动提供内置 MCP/codemode 工厂。[工厂分类](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/resource-loader.ts#L371-L398)、[加载路径](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/resource-loader.ts#L677-L711) | 保留底座现有禁用资源发现、自有工厂注入方式；无需启用新内置扩展。 |
| `systemPromptOptions` 命名段落 | `customPrompt`、`sections`、`contextFiles`、`skills`、`appendSystemPrompt` 保留。新增 `hiddenTools` 用于 `prepareLoadout` 隐藏声明；命名段落仍按 transcript 当前状态生成变化条目。[提示构建](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/system-prompt.ts#L1-L74)、[段落差异](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/system-prompt.ts#L210-L251) | 沿用 `applyPromptSections`；回归修改一个来源只追加该来源，首项系统提示和工具声明保持。 |
| custom message 与 `nextTurn` | `sendCustomMessage` 签名和 `nextTurn` 队列保留。`before_agent_start` 之后构造 user 与 pending custom 消息，再把系统／工具更新放到最前面。[首轮顺序](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/agent-session.ts#L2060-L2113)、[队列入口](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/agent-session.ts#L2283-L2335) | 首轮和后续 view 的稳定前缀策略可沿用。`steer`／`followUp` 返回值由 `Promise<void>` 改为 `Promise<QueuedInputDisposition>`；底座当前只等待完成，可继续使用。 |
| `context_edit`、`turn_end`、`agent_before_settle` | 上下文编辑条目、boundary draft 联合以及可返回 `entries`／`continue` 的形状保留。边界仍先保存草稿，再刷新 canonical projection；`agent_before_settle` 位于重试、压缩和排队续轮之后。[边界类型](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/extensions/types.ts#L935-L1052)、[收尾](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/agent-session.ts#L1894-L1920) | 批清旧 view 与保留原始证据的实现可沿用。`agent_settled` 新增 `aborted`，当前非穷尽事件映射不受类型破坏；需要向客户端公开该信息时再扩充协议。 |
| 缓存保温 | `CacheWarmer` 的发布 JS 在两版之间相同；`cacheContextIsCurrent` 仍逐项比较消息对象身份。[身份判断](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/sdk.ts#L369-L380) | 迁移补丁并修复下述时间戳缺口，重新生成 1.1.0 patch，不能直接删除。保留含 view 与不含 view 的保温、上下文真实变化停止保温、用量落盘回归。 |
| `ModelRuntime` 登录 | 原有三参数调用仍合法，`AuthPrompt`／`AuthEvent` 联合保持；新增可选第四参数 `LoginOptions`。新 `openai` ChatGPT OAuth 实际要求 `getDeviceId()` 返回 UUID，缺失会立即抛错。[登录委托](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/model-runtime.ts#L819-L833)、[安装标识要求](https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/src/auth/oauth/openai-chatgpt.ts#L225-L238) | `Runtime.login` 传入 `getDeviceId: () => settings.getOrCreateDeviceId()`，可以同时使用 `agentName: "Repa"`。选择、密文、授权码、链接和取消映射沿用。 |
| `SettingsManager` | `create(..., { projectTrusted: false })`、`inMemory`、错误读取、`flush`、缓存模式读写保留；新增 `getSettings`、`getOrCreateDeviceId`、codemode 等设置。缓存模式仍只读全局设置，Pi 默认仍为 `streaming`。[缓存设置](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/settings-manager.ts#L1045-L1055)、[安装标识](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/settings-manager.ts#L1193-L1206) | 保留 Repa 当前默认 `idle` 与不读取空间 `.pi/settings.json` 的做法；复用原生全局安装标识，登录后核对保存与重建。 |
| `edit` 同名覆盖 | 内置定义先进入注册表，customTools 随后按名字覆盖定义和执行器；新的工具 exposure/loadout 层仍保留这一路径。[注册表](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/agent-session.ts#L3495-L3566) | 精确 edit 无需换入口；回归全角标点、混合换行与拒绝规范化匹配。Anthropic 1.0.1 新 inline tools 改善的是会话中途重定义的缓存行为，不替代初始注册表覆盖。 |
| `tool_call` 钩子 | 返回 block 和抛错阻止执行的路径保留；新增 `parentToolCallId`，`ctx.executeTool` 嵌套调用也走同一钩子。[工具钩子](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/agent-session.ts#L657-L690)、[嵌套执行](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/agent-session.ts#L742-L794) | 当前 bash 确认可沿用；普通与嵌套调用都应遵守同一权限判断。当前 loader 未启用 codemode，升级不会自动增加嵌套执行路径。 |

### 缓存补丁为什么仍然需要

现有补丁只放宽 `sdk.js` 的消息前缀检查：对象身份相同，或者序列化内容相同，才视为同一份上下文。1.1.0 的 `sdk.ts:378` 和发布包 `dist/core/sdk.js:222` 仍只有前一种判断。与此同时，`SessionManager` 将 `custom_message` 投影为上下文时仍重新创建消息对象，AgentSession 在边界完成后又把投影消息装回 Agent state。因此，即使 view 的内容没有变化，保温器保存的消息对象也可能与当前对象不同，这条失效路径仍在。[custom 消息投影](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/session-manager.ts#L439-L460)、[边界刷新](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/agent-session.ts#L938-L944)。

本轮还复现了 **0.87.1 基线补丁的时序缺口**：`sendCustomMessage` 给 view 设置 `Date.now()`，保存 custom 条目时又生成持久时间戳；两者相差 1 ms 时，内容相同的 view 在投影前后也无法通过当前 `JSON.stringify` 整对象比较。原有“含视图的会话在补丁后仍能原生缓存保温”测试因此报 `conversation context changed`，实际调用数为 1 而非 2；两次取时相同的运行则能保温。Node 22.19.0 和 24.20.0 都已复现失败，相关 runtime、view 实现和测试与任务基线 `d6bf108e9` 逐字相同。补丁仍保持当前版本，后续修复需要区分实际模型上下文与重建时产生的时间元数据，并验证真实内容变化仍会停止保温。

这说明补丁的责任仍在，而不是说明旧版本的 patch 文件可以原样套到新版本。升级时应针对新发布包重新生成补丁，并用真实 SDK 回归确认：内容相同的重建对象仍允许保温，view 被删除、替换或真实上下文前缀变化则停止保温。

### 两版之间需要关注的其他变化

已核对 0.87.1 之后的全部发布段落：0.99.0、0.99.1、0.99.2、1.0.0、1.0.1、1.0.2、1.0.3、1.0.4 和 1.1.0；同时核对 pi-ai 与 pi-agent-core 对应 changelog。[coding-agent changelog](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/CHANGELOG.md#110---2026-10-07)、[pi-ai changelog](https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/CHANGELOG.md#110---2026-10-07)、[agent-core changelog](https://github.com/earendil-works/pi/blob/v1.1.0/packages/agent/CHANGELOG.md#110---2026-10-07)。

- 0.99.x 新增 MCP/codemode、工具 exposure/loadout、分类与图像模型、虚拟模型、ChatGPT OAuth，并改变工具选择与内置扩展加载。当前底座的 chat-only 模型读取保持原意，新增能力各自等待产品需求；首个 user 消息即落盘的修复则使上游新会话默认行为达到底座已有的首轮恢复要求。底座当前先创建空文件、再用 `SessionManager.open`，还承担创建时立即登记的生命周期责任，不能仅凭这项修复删除它。
- 1.0.0 从 agent-core 移除实验 harness 和 durable 子路径。底座使用 coding-agent 的 `AgentSession` 与 `SessionManager`，这些入口保留，无需因此改用 pi-durable。TUI 全屏、主题与 MCP OAuth 变化不进入当前底座 SDK 链。
- 1.0.1 删除发布包 `npm-shrinkwrap.json`，传递依赖改由消费者的锁文件约束；同时修复 `brace-expansion`，并为 Anthropic 提供保持缓存的原生 inline tool 重定义。1.0.2 增加按 thinking level 的采样配置，ModelRuntime 可以原生采用。
- 1.0.3 将 Azure provider 从 `azure-openai-responses` 改为 `azure`。使用旧 provider 的凭据、模型配置、默认模型／enabledModels／thinking-level 键和 Repa 保存的 ModelRef 要迁移；旧会话恢复需要单独核对。`azure-openai-responses` API id 与 `AZURE_OPENAI_*` 环境变量保持。OAuth 刷新在请求取消后完成并保存旋转 token 的修复也会进入 ModelRuntime。
- 1.0.4 修复隐藏工具仍出现在系统提示的问题，并扩充工具通配符／MCP 选择。当前精确白名单可沿用；相关原生 loadout 必须通过声明与缓存回归。
- 1.1.0 为消息、工具结果和执行事件增加可选 `durationMs`，为 `agent_settled` 增加 `aborted`。pi-ai 要求自定义 stream 返回 `AssistantMessageEventStream`，普通手写 `EventStream` 子类不再满足类型；底座使用原生 `ModelRuntime` 和 `fauxProvider`，不需要重写 stream。Bedrock reasoning、provider retry、Anthropic 登录端口、长提示定价和上下文限额估计等修复由原生调用链采用。缓存收益和成本变化仍需要按所用真实提供方测量。

### 升级工作范围与待验证项

建议把升级作为独立任务完成，按下面的次序收敛：

1. 明确只升级 `@repa/base`，还是同时迁移仍锁 0.87.1 的 `packages/repa` 和 `packages/organization`。只迁 base 时会有两代 Pi 副本，需要核对 npm hoist、导入解析和 patch-package 实际覆盖的包；同时迁移则需要另核两个模块的使用入口。
2. 更新目标范围内的 Pi 版本与锁文件，核对新增 `pi-codemode`／`pi-mcp` 等传递依赖；Pi 1.1.0 发布目标为 ES2024，Node 要求为 `>=22.19.0`，底座当前 `>=22.22.2` 满足。不要为了上游从源码运行方式而更换 Repa 的构建器。
3. 迁移缓存补丁并处理已复现的时间戳缺口，补上 LoginOptions 安装标识与应用名；如实际使用 Azure，再安排凭据、配置和已保存引用的迁移。
4. 在目标发布包上完成类型检查、底座与 space-history 测试、WebSocket 端到端回归；重点覆盖首轮顺序、单段更新、批清 view、默认 overflow 压缩与第一份重试、取消／队列终态、精确 edit、命令确认、登录持久化和含 view 缓存保温。

以当前 base 使用面估计，依赖、补丁与登录适配约需半个到一个工作日；目标版完整回归与提供方核验约需另一个到两个工作日。整仓迁移和 Azure 旧数据处理按实际消费者另计。这是工程工作量估计：本次完成发布包类型与固定源码调查，1.1.0 上的类型检查、实际会话回归及真实提供方调用留给已授权的升级任务。当前实现与验证基准仍为 0.87.1。
