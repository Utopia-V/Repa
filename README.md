# Repa

Repa 是一个独立、本地优先的通用 Agent 底座，连接有限的模型上下文与人的长期工作。空间文件与领域状态保存在模型之外，每次运行读取相关视图，再由模型行动与程序计算更新。领域通过插件接入，底座复用 Pi 的通用 Agent 机制。

学习产品的目标是减少学生的学习外心智负担，让已有课程、知识关系和实际作答持续影响后续任务。当前仓库正在重做底座，学习闭环的研究见[学习闭环与研究问题](docs/research/learning-loop.md)。参与项目请先阅读[贡献规范](CONTRIBUTING.md)与[项目目标和方向澄清](AGENTS.md)。

## 当前实现

当前后端由 `@repa/base` 提供，连接空间、Agent 会话、长期状态插件和本机 WebSocket 协议。`@repa/space-history` 保存空间文件的影子 Git 历史，提供变更流与局部撤销。Web 和 Desktop 通过同一客户端连接底座，由各自的 Node 宿主管理后端进程。

| 入口 | 内容 |
| --- | --- |
| [底座说明](packages/base/README.md) | 运行、协议、插件、提示、模型认证与当前限制 |
| [空间历史说明](packages/space-history/README.md) | 文件历史、变更追赶、撤销、排除规则与维护 |
| [开发指南](docs/development/README.md) | workspace、开发命令、代码入口与验证 |
| [设计系统实现](docs/design-system-implementation.md) | 前端组件与设计系统；涉及接口的旧描述按当前客户端核对 |

当前底座每次持有一个活动空间，多个授权连接共享它。会话由 Pi 持久化，空间文件的历史由空间宿主协调；插件负责自己的领域状态和变化游标。学习领域插件与 MA 式学生模型、知识传播和统一任务选择尚待实现。当前仓库提供底座及图形前端骨架，运行入口为本机服务和图形前端。

## 仓库结构

仓库使用 npm workspaces，根目录持有唯一的 `package-lock.json` 和统一命令。

```text
repa/
├── apps/
│   ├── web/              # Web 前端与 Vite 开发宿主
│   └── desktop/          # Electron main/preload 与 renderer
├── packages/
│   ├── base/             # 空间、Agent、插件宿主、CLI 与公开客户端
│   └── space-history/    # 影子 Git 历史、变更流与局部撤销
├── package.json
└── package-lock.json
```

浏览器使用 `@repa/base/client` 与 `@repa/base/protocol`；Node 宿主通过 `@repa/base/process` 启动和关闭服务。插件作者通过 `@repa/base/plugin` 引用接口类型。具体边界与调用示例见[底座说明](packages/base/README.md#结构与责任)。

## 运行与开发

使用根目录 `package.json` 声明的 Node.js 与 npm 版本，并安装系统 Git。在仓库根目录运行：

```sh
npm ci
npm run check
npm test
npm run build
```

启动图形前端：

```sh
npm run dev:web
# 或
npm run dev:desktop
```

前端宿主会构建并启动本机后端，把连接信息交给页面。Web 开发服务器只监听 `127.0.0.1`；Desktop 通过隔离的 preload 向主页面提供连接。宿主关闭时也关闭自己启动的后端。静态 Web 页面不能自行在访问者电脑上启动进程，部署仍需另行确定后端与认证边界。

也可以独立启动本机服务：

```sh
npm start -- --home /path/to/repa-home
# 开发入口使用同一服务命令
npm run dev:backend -- --home /path/to/repa-home
```

这两个根入口都会先构建 `@repa/base`，再运行 `serve`。服务只监听本机地址，stdout 输出包含地址与令牌的私密连接信息。`--home`、`--port`、`--plugin`、模型登录与客户端用法见[底座使用说明](packages/base/README.md#使用)。

日常开发以 `dev` 为基线，任务在各自分支上完成，由维护者审阅合并。验证与阶段交付见[整合规范](docs/development/integration.md)，具体任务由 [GitHub Issues](https://github.com/Utopia-V/repa/issues) 跟踪。

## 设计与研究材料

[CONTEXT.md](CONTEXT.md) 和 [ADR](docs/adr/) 保留概念与历史取舍，其中旧后端的接口和实现描述按当前代码核对。当前目标与方向以 [AGENTS.md](AGENTS.md) 为准，模块使用方法由所属包 README 持有。

学习研究见[学习闭环与研究问题](docs/research/learning-loop.md)和 [MA 参考](docs/research/math-academy.md)。测试检验实现行为；算法对实际作答的解释和预测，以及学习者是否得到更合适的帮助，需要相应数据与使用证据。
