# Repa

Repa 是一个独立、本地优先的通用 Agent 底座，连接有限的模型上下文与人的长期工作。材料、成果和领域状态保存在用户的空间中，每次运行读取相关视图，再由模型行动与程序计算更新。领域通过插件接入，底座复用 Pi 的通用 Agent 机制。

官方学习产品建立在这一底座上，目标是减少学习之外的心智负担。它要让已有课程、材料、知识关系和实际作答持续影响后续任务，而不是每次重新拼一套计划。缺少可用学习资料时，模型帮助建设内容；讲解和开放判断由模型承担，可计算的状态更新与调度由算法承担。

参与项目请阅读[贡献规范](CONTRIBUTING.md)与[项目目标和方向澄清](AGENTS.md)。通用概念见 [CONTEXT.md](CONTEXT.md)，学习领域见[官方学习能力](packages/learning/CONTEXT.md)。

## 当前实现与目标

当前代码提供本机后端、公开应用协议、无 UI 客户端、TUI，以及 Web／Desktop 工作台骨架。后端已经接通会话、持久请求、内容操作、模型连接、插件能力与空间快照。各模块怎样调用和验证，见[开发指南](docs/development/README.md)。

完整学习闭环尚未实现。当前默认组合中的文档学习语境、教学 Skill 和 FSRS 复习项属于早期原型；它们能保存和接续材料与记录，但不是已确定的学生模型、知识传播或任务选择算法。下一步需要修正领域装配与状态归属，同时为学习闭环建立可检验的算法依据，研究范围见[学习闭环与研究问题](docs/research/learning-loop.md)。

| 层次 | 责任与当前入口 |
| --- | --- |
| 通用底座 | 空间、内容、运行、公开协议与插件生命周期；见[开发指南](docs/development/README.md) |
| 官方学习产品 | 装配可直接使用的领域能力，承担教学与学习闭环；当前原型见[官方学习组合](docs/development/official-learning.md) |
| 领域插件 | 解释自己的实体、记录、算法与持久格式，通过能力调用和背景视图接入 Agent；见[能力宿主](docs/development/capabilities.md) |
| 前端 | 使用公开客户端呈现内容与发起操作；见[设计系统实现](docs/design-system-implementation.md)，由前端负责人推进 |

通用底座现在只消费显式提供的插件登记、背景来源和产品默认值；官方学习入口负责装配领域能力。已有持久数据、引用、授权和恢复语义继续保留，原型算法则不构成未来学习闭环的默认选择。

### 默认学习能力

官方学习入口默认装配教学、材料、规划、复习、整理与文档背景能力，启停和接入范围见[官方学习组合](docs/development/official-learning.md)。已有材料阅读、局部讲解、内容保存和独立复习仍可使用；图形工作台尚未提供完整学习界面，当前组合也没有实现 MA 式的学生状态与统一任务选择。

### 设计文件清单

- [通用领域 context](CONTEXT.md)与[学习领域 context](packages/learning/CONTEXT.md)记录已确认的含义。
- [ADR](docs/adr/)解释具体实现选择及代价；其中旧学习组织方向的适用范围按项目澄清修正。
- [开发指南](docs/development/README.md)组织当前模块、命令、持久格式与验证入口。
- [学习闭环与研究问题](docs/research/learning-loop.md)组织当前研究；[MA 参考](docs/research/math-academy.md)保留一手资料入口与核验范围。
- [任务总览 #5](https://github.com/Utopia-V/repa/issues/5)组织跨任务工作，前端内部任务由相应负责人维护。

### 设计记录与实现验证

设计目标、当前实现和实验结果分别解释。测试可以证明保存、协议与生命周期行为符合要求，学习效果需要相应的真实证据。此前方法试用的输入和结果保留在[历史记录](docs/research/learning-task-selection.md)，它们不作为继续采用散文调度或 FSRS 占位方案的依据。

## 仓库结构与 workspace

仓库使用 npm workspaces，并由根目录的单一 `package-lock.json` 固定依赖。根 `package.json` 只负责编排各包命令，不承载后端运行时代码。

```text
repa/
├── apps/
│   ├── web/              # 完整 Web 前端、Vite 与 Browser Router
│   └── desktop/          # 完整桌面前端、Electron main/preload 与 renderer
├── packages/
│   ├── repa/             # 后端、CLI、公开客户端与协议
│   ├── learning/         # 学习领域状态、教学方法与官方产品装配
│   ├── materials/        # 本地材料读取能力
│   ├── organization/     # 长期内容整理方法
│   ├── planning/         # 规划方法与时间约束检查
│   └── review/           # 复习记录、FSRS 调度与参数优化
├── package.json          # workspace 与统一命令
└── package-lock.json     # 全仓唯一锁文件
```

后端包保持 `repa` 包名以及 `repa/client`、`repa/protocol` 公共入口。`@repa/web` 与 `@repa/desktop` 分别持有自己的业务界面和宿主进程接入；宿主把 `@repa/learning` 的 `repa-learning serve` CLI 作为进程边界，renderer 不导入后端主入口，也不重新实现 WebSocket、重连或状态投影。Web 使用 `createBrowserRouter`，Desktop renderer 使用 `createMemoryRouter`。根目录的 `check`、`test` 和 `build` 按 workspace 顺序统一编排。

## 参与开发

日常开发以 `dev` 为统一基线，普通 PR 指向 `dev`；`master` 接收经过阶段验收的版本。分支整合与阶段交付见[整合规范](docs/development/integration.md)。

前端视觉与交互遵循[设计系统规范](docs/design-system.md)，组件职责与接入方式见[设计系统实现说明](docs/design-system-implementation.md)。

从[开发指南](docs/development/README.md#参与开发)开始：其中说明根目录安装、Web／Desktop／后端开发命令、代码入口与交付前验证。可领取任务及其依赖关系由[产品主议题 #5](https://github.com/Utopia-V/repa/issues/5) 统一维护。

## 运行现有 TUI

使用根目录 `package.json` 声明的 Node.js 与 npm 版本，依赖由 `package-lock.json` 固定。当前 npm 12.0.2 支持 Node.js 22.22.2 起的 22.x、24.15.0 起的 24.x 或 26 及更高版本。

```sh
npm ci
npm run check
npm test
npm run build
```

### 开发图形前端

直接启动其中一个前端：

```sh
npm run dev:web
# 或
npm run dev:desktop
```

两个入口都会通过现有 CLI 自动启动各自的本机后端，并通过 `RepaClient` 完成协议初始化。初始化期间显示启动状态，失败时显示原因与重试入口；连接建立后进入应用路由，短暂断线由客户端自动重连，不跳转到连接页面。Desktop 使用应用专属连接文件，Web 开发服务器使用当前开发进程专属连接文件，因此它们不与 TUI 共享默认后端。

Web 由 Vite 提供热更新；开发服务器只监听 `127.0.0.1`，并通过同源、不可缓存的开发端点把连接交给页面，令牌不进入 URL、浏览器存储或生产构建。静态 Web 部署本身不能在访问者电脑上启动进程，后续部署需要单独定义后端与认证边界。Electron 由 electron-vite 分别监听 main、preload 和 renderer；renderer 禁用 Node 集成、启用上下文隔离和进程沙箱，preload 只向受信任主页面暴露读取连接的窄接口，后端启动仍在 main 进程一侧完成。

当前整合版本已在 Linux 验证各 workspace 的类型检查、测试和构建。测试通过本地 WebSocket、HTTP、真实 Pi SDK 和独立 Node 进程检查后端与两端宿主的连接及清理；模型调用使用确定性 faux provider，认证与学习空间使用临时目录。这些结果不覆盖 Electron 图形窗口与 preload 的完整运行、安装包或其他平台，相关交付由 #26 验证。

### 配置模型

在仓库根目录启动配置向导：

```sh
npm run dev:backend -- configure
```

先选择已有连接，或创建一个新连接。接着按服务商支持的方式填写 API key 或完成 OAuth 登录，最后选择模型并设为应用默认值。

登录和模型调用使用 Pi SDK。Repa 为每个连接分别保存地址与认证身份，不同会话可以使用各自的账号。`--agent-dir <目录>` 指定 Pi 资源与默认选项目录，自定义服务和本地无密钥连接见[模型连接与运行配置](docs/development/models-configuration.md)。查看和新建会话不启动 Agent；尚未选择连接或模型时，已受理请求在执行时报告配置错误，本地内容功能可用。

### 启动与接续

将示例路径替换为实际学习空间目录：

```sh
npm start -- /path/to/learning-space
# 构建后也可直接运行
node packages/learning/dist/cli.js /path/to/learning-space
```

官方学习 TUI 自动连接或启动独立的本机后端，打印连接文件的位置。需要无学习默认的通用底座时，使用 `npm run dev:core -- /path/to/space`，或构建后的 `node packages/repa/dist/cli.js`。两种入口分别使用自己的默认连接目录，不会误复用另一产品的后端。同一系统用户的后续普通启动使用该后端，可以同时查看不同空间或会话。默认选择空间中最近活动的会话；`--new-session` 新建一段交流。

| 命令 | 行为 |
| --- | --- |
| `/cancel` | 请求取消当前会话的任务，最终结果在实际停止后更新。 |
| `/queue`、`/queue <输入>` | 查看队列，或提交独立后续任务。 |
| `/cancel-queued <请求ID>`、`/resume` | 取消未开始的请求，或恢复暂停队列。 |
| `/continue <请求ID>` | 在当前历史和文件上接续未完成任务。 |
| `/new` | 新建并查看会话，其他会话的任务继续运行。 |
| `/sessions`、`/use <会话ID>` | 列出会话摘要，或切换查看对象。 |
| `/branch <消息ID>` | 从已保存的消息建立新会话，保留原会话及其运行；未配对的工具调用不能作为分支终点。 |
| `/status <请求ID>` | 查询原请求的受理与执行状态。 |
| `/exit` | 关闭当前前端；最后一个前端离开后，后端完成已提交且可执行的任务再退出，有待回答交互时继续运行并等待重连答复。 |
| `/quit` | 完整退出后端，停止任务并保留已有历史及执行结果。 |

生成期间按 `Ctrl+C` 请求取消，空闲时按 `Ctrl+C` 关闭当前前端。扩展需要回答时，TUI 显示问题并接收回答；确认题使用 `yes` 或 `no`，选择题可以输入选项编号，`/dismiss` 取消该交互。所有前端离开后，待回答的交互仍由后端保留；重新连接可以继续。

会话 JSONL 保存在 `<space>/.repa/sessions/`。空间身份与任务记录位于 `.repa/runtime/`，内容身份、操作恢复记录与不可变资源位于 `.repa/content/`，空间和会话提示覆盖位于 `.repa/settings.json`。公开的 `space.backup/restore/copy` 协调这些数据与已声明插件数据，具体接入见[空间快照](docs/development/spaces.md)。内容和资源责任分别见[内容、保存与恢复](docs/development/content.md)与[资源持有与清理](docs/development/resources.md)。

运行日志采用独立的 `repa.run` 格式，当前磁盘格式版本为 `1`，记录请求事实与可选终态；运行进度由后端状态持有。旧版无版本记录继续按原格式读取，新记录使用当前格式追加，已有有效记录保持原样。遇到不支持的格式版本或完整的损坏记录时，停止恢复并保留原文件；只有尚未完成的末尾追加可以在完整记录校验后清除。

运行锁由 `proper-lockfile` 管理并在正常退出时释放；强制终止后，旧锁需要经过约十秒的失效期才能重新取得。恢复后的未完成任务标记为 `interrupted`，供核对结果，不自动重新执行。

排查运行问题时，可以按请求编号查询 stderr 中的结构化诊断记录。默认级别为 `info`，`REPA_LOG_LEVEL=debug` 增加调用与阶段信息，`off` 关闭诊断；宿主管理的日志文件按 10 MiB 片段保留。时间点、隐私范围和文件策略见[诊断日志](docs/development/diagnostics.md)。

### 独立后端与其他前端

可以显式启动后端，再让多个前端通过连接文件接入：

```sh
npm start -- serve --connection-file /path/to/repa-connection.json
npm start -- /path/to/learning-space --connect /path/to/repa-connection.json
```

独立启动的后端默认保持运行；加入 `--exit-when-detached` 后，最后一个前端离开时等待已启动任务及其交互完成，再收尾退出。端口默认由系统分配，`--port` 可以指定端口。监听地址为本机 `127.0.0.1`，连接文件包含地址与访问令牌，按仅当前用户可读写的权限创建。默认启动的连接文件和诊断日志位于系统运行时目录；它们不进入学习空间。

### Package 与 Extension 信任

后端默认不执行未受信任的 Pi Package、Extension 或 Repa backend；官方学习入口启用产品自带能力，通用入口不预装学习包。应用侧 `plugins.trusted` 可以授权明确的包来源，`plugins.disabled` 控制相应能力；空间文件不能自行授予信任。通过 `--trust-extensions` 可以显式启用 Pi 全局资源和空间中的项目资源：

```sh
npm start -- /path/to/learning-space --trust-extensions
# 或为独立后端启用
npm start -- serve --connection-file /path/to/repa-connection.json --trust-extensions
```

整体扩展信任由启动参数决定，具体包的信任保存在应用配置中。改变启动参数需要重启后端，也可以用另一连接文件启动独立后端。包安装、更新与移除使用后台请求，改包后需要按结果重启进程；部分失败也可能已经修改文件。入口与操作见[插件说明](docs/development/plugins.md)。

启用的插件代码以宿主进程权限运行。命令服务的沙箱只约束经该服务启动的命令，Ubuntu 独立启动还可能需要专用 AppArmor 配置，见[执行说明](docs/development/execution.md)。

当前提供 `read`、`edit`、`write`、`apply_patch` 内容工具，前端和 Agent 共用保存与恢复逻辑；读取也支持已启用 Skill 的自有资源。`bash` 已通过 Pi SDK 接入命令执行与授权；受限模式的安装条件见[执行说明](docs/development/execution.md)。兼容的扩展工具、prompt 与 Skill 可以使用；扩展的选择、确认、输入和编辑器交互通过后端转为待回答问题。依赖 Pi 专用 TUI 组件的扩展需要前端适配。

### 公开应用接口

[协议 schema](packages/repa/src/protocol.ts) 同时持有方法参数、返回值、消息和订阅数据结构，TypeScript 类型从同一来源推导，后端与客户端均执行校验。协议版本为 `1`；连接时通过 `initialize` 提交令牌和支持的版本。公开调用采用 JSON-RPC 2.0，经 `/rpc` WebSocket 传输，Repa 操作使用带 `id` 的请求。

应用协议版本与磁盘格式版本分别管理。当前 v1 尚未发布，按已接受契约演进并同步 schema 与客户端；发布后再按公开兼容性约定管理版本。前端联调按共同选定的提交及其 schema 开展，具体组件宿主约定仍按 ADR 0004 接入。

| 方法 | 责任 |
| --- | --- |
| `space.open`、`space.list` | 打开本地空间并取得稳定身份，或列出后端已打开的空间。 |
| `space.browse`、`space.create`、`space.recent` | 浏览本机目录、在配置的父目录中建立新空间，以及查询跨重启保留的最近记录；见[空间进入](docs/development/space-entry.md)。 |
| `session.create`、`session.list`、`session.get`、`session.history`、`session.branch`、`session.close` | 创建、列举摘要、读取历史、建立分支和释放运行实例；查看历史不启动 Agent。 |
| `session.submit`、`session.continue`、`request.get` | 提交结构化输入、补充当前运行、排队与失败接续，查询输入的实际归属。 |
| `run.get`、`run.cancel` | 按运行标识查询状态和请求取消。 |
| `queue.list`、`queue.cancel`、`queue.resume` | 查询队列，取消尚未开始的项，明确恢复暂停的处理。 |
| `request.cancel` | 取消独立后台处理，等待实际收尾。 |
| `content.*`、`operation.*` | 读取和保存文件，维护身份与组成，查询、撤回及核对恢复结果；具体方法见[内容接口](docs/development/content.md)。 |
| `content.relations` | 查询 Markdown 引用与明确组成，取得来源修订、目标位置和可用状态；见[内容关系查询](docs/development/content-relations.md)。 |
| `capability.describe`、`capability.invoke` | 取得契约与入口问题，调用明确作用域和实现；按声明直接查询或持久受理，Agent 工具复用相同处理。 |
| `display.open/get/close/readResource/invoke` | 打开固定版本的展示，读取实例资源，并发起宿主绑定的保存或会话提交动作。 |
| `package.list`、`package.install/update/remove` | 静态包目录与 Pi 包管理，管理操作使用后台请求并报告实际进程重启要求。 |
| `execution.run`、`execution.inspect` | 提交有持久请求身份的命令，查询当前执行策略和活跃命令；使用已有请求查询、交互与取消入口。 |
| `settings.get`、`settings.set`、`settings.reset` | 读取已登记命名空间的定义、覆盖与来源，按项保存或恢复继承，包括插件启用和实现选择。 |
| `interaction.reply` | 携带 `responseId` 回答交互，取得持久确认；重传返回原回执，竞争答复返回已处理结果。 |
| `state.get`、`subscription.start`、`subscription.stop` | 按应用、空间或会话范围读取快照和订阅变化。 |
| `client.detach`、`shutdown` | 离开后端，或请求完成现有任务后退出、取消任务后退出。 |

学习语境通过 `@repa/learning/client` 的 `callLearning` 调用 `repa.context.*` 能力，复用通用 `capability.invoke`，不再是核心 RPC。领域客户端用法见[学习包](packages/learning/README.md)。

`session.submit` 使用调用方生成的 `requestId`，与一次执行的 `runId` 和 JSON-RPC 应答标识分别表达。重复提交返回既有记录；输入是否进入历史、属于哪个运行以及运行是否完成可分别查询。取消与失败暂停后续队列，重开空间后明确恢复。调用和持久语义见[输入、请求与运行](docs/development/requests.md)。

订阅先提供快照，再提供变化；客户端核对批次前游标，缺口时重新取得快照。连接丢失或应答超时的操作不会自动重发。会话列表只有摘要，`session.get` 和会话订阅提供最近消息，更早历史通过 `session.history` 分页读取。

[无 UI 客户端](packages/repa/src/client.ts)使用标准 WebSocket、Fetch 和 Web Crypto，可供 Node 程序和浏览器前端使用。构建后的包提供独立的 `repa/client` 与 `repa/protocol` 入口；浏览器通过构建工具引入客户端，无须包含后端或 Pi。

```typescript
import { readFile } from "node:fs/promises";
import { RepaClient } from "repa/client";

const connection = JSON.parse(
  await readFile("/path/to/repa-connection.json", "utf8"),
);
const client = await RepaClient.connect(connection);
const space = await client.call("space.open", { path: "/path/to/learning-space" });
const session = await client.call("session.create", { spaceId: space.id });
const watch = await client.watch(
  { spaceId: space.id, sessionId: session.sessionId },
  (snapshot) => console.log(snapshot.sessions[0]?.runs.at(-1)),
);

const requestId = crypto.randomUUID();
const receipt = await client.call("session.submit", {
  target: { spaceId: space.id, sessionId: session.sessionId },
  requestId,
  input: { parts: [{ kind: "text", text: "解释虚拟内存" }] },
  dispatch: { kind: "start" },
});
console.log(receipt); // 受理结果；最终执行状态由订阅或 run.get 取得。

// 界面关闭时调用。已受理任务由后端继续管理。
await watch.stop();
await client.close();
```

消息保留文本、思考、工具调用、资源与扩展数据结构。流式消息通过 `replaces` 与保存后的历史消息身份衔接。消息媒体与内容资源统一使用 `{ spaceId, id, mediaType }`，从 HTTP `/spaces/<spaceId>/resources/<id>` 获取，schema 从 `/protocol.json` 获取，均使用 `Authorization: Bearer <token>`。客户端的 `resource(ResourceRef)`、`uploadResource` 和 `readText` 处理认证与完整内容读取；上传返回带有效期的准备结果，长期使用通过文档关系或 `resource.hold` 保留。重连自动复用 `initialize` 返回的宿主键，显式关闭宿主会释放其临时持有。生成页面通过[展示桥接](docs/development/display.md)读取绑定资源和调用有限动作；生产渲染器按 ADR 0005 接入实际隔离。

GitHub Issue [#5](https://github.com/Utopia-V/repa/issues/5) 是产品主议题，当前设计语义与工程取舍见上面的项目文档。[#6](https://github.com/Utopia-V/repa/issues/6) 记录学习语境与通用工具接入，[#7](https://github.com/Utopia-V/repa/issues/7)、[#8](https://github.com/Utopia-V/repa/issues/8)、[#9](https://github.com/Utopia-V/repa/issues/9) 分别保留可视化、规划与知识整理的扩展想法；[#4](https://github.com/Utopia-V/repa/issues/4) 描述已有对话实现，早期规格 [#3](https://github.com/Utopia-V/repa/issues/3) 已退役。
