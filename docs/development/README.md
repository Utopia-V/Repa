# 开发指南

本目录提供仓库开发、代码定位与整合入口。当前底座由 `@repa/base` 与 `@repa/space-history` 组成，接口、持久格式和生命周期分别由[底座说明](../../packages/base/README.md)与[空间历史说明](../../packages/space-history/README.md)维护。

项目目标与方向澄清见 [AGENTS.md](../../AGENTS.md)。[CONTEXT.md](../../CONTEXT.md)、[ADR](../adr/) 和研究材料保留概念及历史取舍；其中旧后端的接口和实现描述按当前代码核对。

## 参与开发

从当前 `dev` 分支开始，在对应 Issue 中确认任务范围；普通 PR 指向 `dev`。分支整合与阶段交付遵循[整合规范](integration.md)。使用根 `package.json` 声明的 Node.js 与 npm 版本，并准备系统 Git，然后在仓库根目录运行 `npm ci`。

| 操作 | 根目录命令 |
| --- | --- |
| 构建后端及空间历史 | `npm run build:backend` |
| 启动本机服务 | `npm run dev:backend -- --home /absolute/path/repa-home` |
| Web 开发 | `npm run dev:web` |
| Desktop 开发 | `npm run dev:desktop` |
| 全仓类型检查、测试与构建 | `npm run check`、`npm test`、`npm run build` |

根 `start` 和 `dev:backend` 都运行底座的 `serve`。`@repa/base` 的 `prebuild` 先构建空间历史，因而根 `build:backend` 只需构建底座。检查、测试与前端开发准备复用这个入口。需要指定端口或加载本机可信插件时，继续传入底座 CLI 的选项，具体见[使用说明](../../packages/base/README.md#使用)。

Web 和 Desktop 分别由 Vite 与 Electron Node 宿主启动后端。`@repa/base/process` 提供进程生命周期，宿主取得连接后通过开发 HTTP 端点或隔离 preload 交给 renderer；宿主关闭时等待后端收尾。连接断开后重新读取历史与插件状态，再判断原操作的结果，客户端不会自动重放请求。

前端实现遵循 [Web 协作规则](../../apps/web/AGENTS.md)、[设计系统](../design-system.md)与[设计系统实现](../design-system-implementation.md)。前端工作由相应负责人推进。

## 工程边界

根目录持有 workspace 命令与单一锁文件，各包声明自己的依赖。浏览器只使用 `@repa/base/client` 和 `@repa/base/protocol`，Node 宿主通过 `@repa/base/process` 管理后端；插件通过 `@repa/base/plugin` 引用类型。Pi 的实现依赖留在底座的 `src/agent/` 内。

每个服务持有一个活动空间。Agent 运行和独立插件文件写入经过空间历史队列，插件状态与变化游标由插件维护。影子 Git 撤销空间文件，不回滚插件数据、会话与设置；数据保护范围和外部写入限制见[空间历史说明](../../packages/space-history/README.md#保存与撤销的取舍)。

## 从哪里开始

| 需要修改的行为 | 当前入口 |
| --- | --- |
| 客户端连接、调用与通知 | [client.ts](../../packages/base/src/client.ts) |
| 公开方法、输入输出与事件 | [protocol.ts](../../packages/base/src/protocol.ts)、[协议服务](../../packages/base/src/protocol/server.ts) |
| 独立服务启动 | [cli.ts](../../packages/base/src/cli.ts) |
| 空间锁、监听、文件与历史协调 | [空间宿主](../../packages/base/src/space/space.ts) |
| Agent 会话、提示和 view | [Agent 运行时](../../packages/base/src/agent/runtime.ts)、[提示](../../packages/base/src/agent/prompts.ts)、[view](../../packages/base/src/agent/views.ts) |
| 插件接口与宿主 | [plugin.ts](../../packages/base/src/plugin.ts)、[插件宿主](../../packages/base/src/plugins/host.ts)、[示例插件](../../packages/base/examples/notes-plugin.ts) |
| 空间文件历史与变更流 | [空间历史包](../../packages/space-history/README.md) |
| Web 宿主与页面 | [Vite 配置](../../apps/web/vite.config.ts)、[Web 源码](../../apps/web/src/) |
| Desktop 宿主与页面 | [主进程](../../apps/desktop/src/main/index.ts)、[preload](../../apps/desktop/src/preload/)、[renderer](../../apps/desktop/src/renderer/) |

## 运行与验证

交付前在仓库根目录运行：

```sh
npm run check
npm test
npm run build
```

只验证底座或历史包时，使用所属说明中的[底座验证入口](../../packages/base/README.md#验证入口与交付统计)与[空间历史验证入口](../../packages/space-history/README.md#验证与计时)。普通测试使用临时目录、真实 Git、WebSocket、SDK 与脚本化模型提供方，真实模型核实使用单独入口并遵循已授权的资源范围。

宿主进程、协议或关闭机制变化后，需要在组合后的版本验证前端与真实后端的连接和退出。Electron 图形窗口、安装包与其他平台按实际交付范围另行验证，开发构建的结果不扩展为发行支持。
