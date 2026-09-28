# 开发指南

本目录面向实现后端、客户端和能力适配器的开发者，说明当前代码的责任与调用方式。修改所属模块时同步维护相应说明。产品概念由根目录 [CONTEXT.md](../../CONTEXT.md) 持有，架构取舍由 [ADR](../adr/) 持有，尚待实现的接口建议集中在 [Issue #16](https://github.com/Utopia-V/repa/issues/16)。早期原型的代码结构和测试只说明当时的实现，不能代替已接受的产品设计。

公开方法以当前提交的 [protocol.ts](../../src/protocol.ts) 及其导入的 schema 为准。协议仍为 v1，联调时固定双方使用的源码或构建提交。

本指南描述当前代码的接入与持久格式；需要理解设计原因时，查阅相应 ADR。内容编辑的需求、代价和可重新评估的策略见 [ADR 0003](../adr/0003-share-file-based-content-operations.md#编辑与保存)。Pi 当前锁定为 0.87.1；升级边界与回归入口见 [Agent 接入](agent-runtime.md#sdk-升级与验证)。

模块任务及其依赖关系见[实施入口 #5](https://github.com/Utopia-V/repa/issues/5)。[插件宿主 #20](https://github.com/Utopia-V/repa/issues/20)尚待实现，范围是通用调用与按需生命周期接入；算法、数据库实体和迁移由插件负责，适用的存储辅助库可作为可选依赖共享。数据责任见[ADR 0003](../adr/0003-share-file-based-content-operations.md#能力数据与数据库)。

## 从哪里开始

| 工作 | 入口与责任 |
| --- | --- |
| 接入前端、读取状态或保存内容 | [client.ts](../../src/client.ts)：标准 WebSocket、Fetch、协议校验和状态副本，不依赖 Pi 或后端模块 |
| 增加公开调用 | [protocol.ts](../../src/protocol.ts)、[server.ts](../../src/server.ts)：参数和结果校验、认证、传输；内容契约在 [content/protocol.ts](../../src/content/protocol.ts) |
| 处理应用内的操作顺序与退出 | [application.ts](../../src/application.ts)：空间实例、请求受理、配置固定、订阅与进行中工作；释放空间前等待 Agent 和内容操作收尾 |
| 修改正文、身份、组成或学习语境 | [内容与保存](content.md)：共同的版本检查、文件操作、资源和恢复入口 |
| 管理媒体、版本保留、会话删除和回收 | [资源持有与清理](resources.md)：实际消费者、展示宿主、准备期、重连与历史清理 |
| 备份、恢复或复制整个空间 | [空间快照](spaces.md)：目录发布、格式 owner、插件数据参与与中断结果 |
| 修改模型实际得到的输入、工具或提示来源 | [Agent 接入](agent-runtime.md)：Pi 运行边界、可控来源、实际读取基准及压缩后的工作视图 |
| 修改持久配置 | [configuration/store.ts](../../src/configuration/store.ts)：应用、空间、会话逐项继承；配置定义在相邻 schema 中 |
| 修改会话历史或运行记录 | [pi-sessions.ts](../../src/pi-sessions.ts) 适配 Pi 会话树；[runtime-store.ts](../../src/runtime-store.ts) 与 [run-journal.ts](../../src/run-journal.ts) 持有空间锁和请求事实 |

`src/storage/` 只提供原子替换、串行队列、受管理目录和不可变字节存储。内容身份、恢复判定、配置继承和 Agent 行为留在各自模块，不能从通用文件辅助函数推导产品语义。

## 当前接通的调用路径

```mermaid
flowchart LR
    Client[RepaClient] --> Server[认证与协议校验]
    Server --> App[RepaApplication]
    App --> Content[ContentStore]
    App --> Config[ConfigStore]
    App --> Host[PiConversationHost]
    Host --> Tools[Pi 工具适配器]
    Tools --> Content
    Host --> Context[学习语境工作视图]
    Context --> Content
    Content --> Journal[FileJournal 与 BlobStore]
    Host --> Pi[Pi AgentSession 与 SessionManager]
```

内容 API 和模型工具共享实际保存入口。图形前端可以直接使用它建立编辑器与导航；当前 TUI 继续使用公共客户端。图形组件宿主、共享草稿服务、结构化会话输入、steer、持久队列、指定失败任务接续、共享能力注册和命令沙箱仍按设计文档接入，不能把相关草案方法视为已实现接口。

当前 `ContentStore` 仍直接持有学习语境绑定与展开，`PiConversationHost` 直接读取它并装配默认提示。#20 负责解除对学习组织规则的硬依赖，将相应来源接入官方学习能力，继续复用通用内容、快照与 Pi 生命周期。迁接须保留已有绑定、保存/撤回/恢复、来源关闭、压缩回填和默认体验；当前图示描述的是实际实现，尚未完成这项迁接。

## 运行与验证

使用锁文件安装依赖，然后执行：

```sh
npm ci
npm run check
npm test
npm run build
```

测试使用 Node 自带测试器，所有 `test/*.test.ts` 都进入 `npm test`。Pi 集成使用锁定 SDK 的真实会话、工具和压缩流程，模型由本地 faux provider 提供确定性响应，无需模型凭据。

| 需要保护的行为 | 主要验证入口 |
| --- | --- |
| 文件修改、版本冲突、身份移动、重复操作和中断恢复 | [content.test.ts](../../test/content.test.ts)、[content-patch.test.ts](../../test/content-patch.test.ts) |
| 两个客户端共享保存结果、完整资源、空间外材料和退出期间保存 | [content-api.test.ts](../../test/content-api.test.ts) |
| 内容复制、循环组成、多个版本持有和清理后防止重放 | [content-lifecycle.test.ts](../../test/content-lifecycle.test.ts) |
| 空间复制、恢复、外部变化和 SQLite 快照参与 | [space-lifecycle.test.ts](../../test/space-lifecycle.test.ts) |
| 模型工具经共同内容入口读写、部分读取、取消与外部修改 | [agent-tools.test.ts](../../test/agent-tools.test.ts) |
| 已观察文件的变化提示、差异基准与按需读取 | [file-changes.test.ts](../../test/file-changes.test.ts) |
| 实际模型输入、来源关闭、空提示、重复注入和压缩 | [agent-context.test.ts](../../test/agent-context.test.ts)、[pi-context-integration.test.ts](../../test/pi-context-integration.test.ts) |
| 配置与外部文件授权的持久化、并发写入 | [configuration.test.ts](../../test/configuration.test.ts)、[content-access.test.ts](../../test/content-access.test.ts) |
| 后端、客户端、TUI、恢复与真实子进程生命周期 | [application.test.ts](../../test/application.test.ts)、[run-journal.test.ts](../../test/run-journal.test.ts) |

当前运行证据来自 Linux。文件系统通知用于让界面重新查询，不能证明观察到了外部程序的每一次中间写入。平台隔离、安装体积、性能和真实学习效果需要对应环境的验证。
