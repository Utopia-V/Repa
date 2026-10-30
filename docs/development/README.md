# 开发指南

本目录提供仓库开发、代码定位与整合入口。当前底座由 `@repa/base` 与 `@repa/space-history` 组成，接口、持久格式和生命周期分别由[底座说明](../../packages/base/README.md)与[空间历史说明](../../packages/space-history/README.md)维护。

项目目标与方向澄清见 [AGENTS.md](../../AGENTS.md)，设计决定及理由见[设计记录](../../.agents/notes/README.md)。研究材料保留当时的问题、证据与结论；接口和实现描述按当前代码核对。

## 参与开发

从当前 `dev` 分支开始，在对应 Issue 中确认任务范围；普通 PR 指向 `dev`。分支整合与阶段交付遵循[整合规范](integration.md)。使用根 `package.json` 声明的 Node.js 与 npm 版本，并准备系统 Git，然后在仓库根目录运行 `npm ci`。

| 操作 | 根目录命令 |
| --- | --- |
| 增量构建全部库包及配套产物 | `npm run build:packages` |
| 构建后端及空间历史 | `npm run build:backend` |
| 启动本机服务 | `npm run dev:backend -- --home /absolute/path/repa-home` |
| Web 开发 | `npm run dev:web` |
| Desktop 开发 | `npm run dev:desktop` |
| 全仓类型检查、测试与构建 | `npm run check`、`npm test`、`npm run build` |

根 `start` 和 `dev:backend` 都运行底座的 `serve`，由底座的 `prestart` 准备构建产物。需要指定端口或加载本机可信插件时，继续传入底座 CLI 的选项，具体见[使用说明](../../packages/base/README.md#怎么用)。

### 增量构建

根目录的 [`tsconfig.build.json`](../../tsconfig.build.json) 汇集库包工程，各工程通过 project references 声明依赖。`build:packages` 先运行 `tsc -b`，再复制底座示例的 `repa-plugin.json`、用 esbuild 生成学习插件的 `protocol.browser.js`。TypeScript 负责按依赖顺序编译并跳过最新工程；编译状态随产物保存在各包的 `dist/` 下，删除整个 `dist/` 就能重新构建该包。

根 `check` 和 `test` 先统一运行 `build:packages`，然后以 `--ignore-scripts` 运行各 workspace 的检查或测试，避免再次触发各包的准备脚本。根 `build` 在库包准备完成后调用各前端的 `build:app`，分别执行 Vite 和 electron-vite。示例清单复制与 esbuild 步骤每次准备时都会执行，以保证非 TypeScript 产物也与源码一致。

单独运行包的 `build`、`check`、`test` 时，包内入口也会通过 `tsc -b` 更新自身及引用的依赖；课程命令只准备 Node 工程。Web 和 Desktop 的构建、检查、测试、开发入口统一调用根 `build:packages`，因此从根目录运行 `npm run dev:web` 或直接进入 workspace 启动都能更新库包。`build:app` 和 `build:assets` 是组合构建内部使用的步骤，日常开发使用表中的入口或包的 `build`。

同一 worktree 中会写入构建产物的命令应串行运行；需要同时修改源码并运行多套任务时，使用独立 worktree。

Web 和 Desktop 分别由 Vite 与 Electron Node 宿主启动后端。`@repa/base/process` 提供进程生命周期，宿主取得连接后通过开发 HTTP 端点或隔离 preload 交给 renderer；宿主关闭时等待后端收尾。连接断开后重新读取历史与插件状态，再判断原操作的结果，客户端不会自动重放请求。

Web 在连接时声明前端服务 `python.run`，用 [`@repa/python-runner`](../../packages/python-runner/README.md) 在 Worker 里以 Pyodide 运行学习者的代码；输入输出见 `@repa/python-runner/protocol`。声明了这项服务就表示能运行 Python，后端不另外探测；开始服务时就在后台预热一个 Worker，每次执行用一个全新的 Worker，用完销毁，后台预热下一个。Vite 开发服务器在 `/__repa/pyodide/` 提供 Pyodide 文件和 wheel，并给 Worker 脚本加 CSP 响应头；wheel 先用 `npm run course:runtime` 准备，与课程核对共用一个目录。Worker 启动时确认 CSP 生效，没有就拒绝运行，所以别的宿主提供 Web 时也要给 Worker 脚本加同样的响应头。

Desktop 同样声明 `python.run`。生产时 renderer 从自定义协议 `repa://app/` 加载，而不是 `file://`，因为 `file://` 没有响应头，Worker 的 CSP 设不上；协议由[主进程](../../apps/desktop/src/main/app-protocol.ts)处理，给 `workers/` 下的脚本加 CSP，并在 `/__repa/pyodide/` 提供 Pyodide 文件和 wheel。开发时这些由 electron-vite 的开发服务器提供，两边的放行规则共用 [python-runtime.ts](../../apps/desktop/src/main/python-runtime.ts)。Linux 安装包把 Pyodide 文件和 wheel 复制到应用目录的 `pyodide/`，打包前要先运行 `npm run course:runtime`。

前端实现遵循 [Web 协作规则](../../apps/web/AGENTS.md)、[设计系统](../design-system.md)与[设计系统实现](../design-system-implementation.md)。前端工作由相应负责人推进。

## CI

[GitHub Actions 工作流](../../.github/workflows/ci.yml)在推送到 `dev`、指向 `dev` 的 PR 和手动触发时运行。两个任务都使用 Node 24 和 npm 12.0.2，从 `npm ci` 开始准备依赖，并运行 `npm run course:runtime` 准备或核对 Pyodide 离线包；离线包按版本缓存在 `packages/python-runner/.cache/pyodide/<版本>/`。

- `linux` 在 `ubuntu-24.04` 上安装 `libseccomp2` 和系统 `python3`，然后运行根目录的 `npm test`，统一构建并测试全部 workspace。任务失败会使 CI 失败。
- `windows` 在 `windows-latest` 上按默认设置检出，保留 Windows 的 CRLF 换行情形；构建库包后，分别测试空间历史、底座、Python 运行器和学习插件，前一个包的测试失败时后面的照常运行。该任务与 `linux` 一样，失败即视为 CI 不通过；团队没有 Windows 本机验证环境，Windows 上的兼容性问题由它发现。

`REPA_TEST_REQUIRE_ENV=1` 让缺少 Pyodide 离线包、Landlock、libseccomp 或系统 Python 等环境的测试按原跳过原因失败。Linux 任务设置它，以保证沙箱测试实际运行；Windows 不设置，Linux 沙箱测试在那里按环境原因跳过。平台或权限语义差异造成的其他跳过保持原样。

在具备 Landlock ABI 4 以上（Linux 6.7 以上）的 Linux 上，使用 Node 24 和 npm 12.0.2，在仓库根目录复现 Linux 任务：

```sh
sudo apt-get update
sudo apt-get install -y libseccomp2 python3
npm ci
npm run course:runtime
REPA_TEST_REQUIRE_ENV=1 npm test
```

## 工程边界

根目录持有 workspace 命令与单一锁文件，各包声明自己的依赖。浏览器只使用 `@repa/base/client` 和 `@repa/base/protocol`，Node 宿主通过 `@repa/base/process` 管理后端；插件通过 `@repa/base/plugin` 引用类型。Pi 的实现依赖留在底座的 `src/agent/` 内。

应用配置使用系统配置目录，支持 `REPA_HOME` 和显式 `home` 覆盖；空间格式版本 1 的覆盖范围和空间 Skill 位置见[底座格式与配置](../../packages/base/README.md#应用配置目录)。目录浏览只把具有有效格式标记的目录识别为空间。测试和试运行必须显式使用临时 `home`／`REPA_HOME` 及临时空间，隔离个人数据。

每个服务持有一个活动空间。Agent 运行和独立插件文件写入经过空间历史队列，插件状态、数据版本与变化游标由插件维护。一个插件打开失败时只停用这个插件及无法成立的依赖方，原因通过 `space.open/create` 的 `disabledPlugins` 和 `plugin.disabled` 提供；前端显示由 Aqua 接续。影子 Git 撤销空间文件，不回滚插件数据、会话与设置；插件数据与会话由[空间备份](../../packages/base/README.md#备份与恢复)保护，数据保护范围和外部写入限制见[空间历史说明](../../packages/space-history/README.md#保存与撤销的取舍)。

## 从哪里开始

| 需要修改的行为 | 当前入口 |
| --- | --- |
| 客户端连接、调用与通知 | [client.ts](../../packages/base/src/client.ts) |
| 公开方法、输入输出与事件 | [protocol.ts](../../packages/base/src/protocol.ts)、[协议服务](../../packages/base/src/protocol/server.ts) |
| 独立服务启动 | [cli.ts](../../packages/base/src/cli.ts) |
| 空间锁、监听、文件与历史协调 | [空间宿主](../../packages/base/src/space/space.ts) |
| Agent 会话、提示和视图 | [Agent 运行时](../../packages/base/src/agent/runtime.ts)、[提示](../../packages/base/src/agent/prompts.ts)、[视图](../../packages/base/src/agent/views.ts) |
| 插件接口与宿主 | [plugin.ts](../../packages/base/src/plugin.ts)、[插件宿主](../../packages/base/src/plugins/host.ts)、[示例插件](../../packages/base/examples/notes-plugin.ts) |
| 空间文件历史与变更流 | [空间历史包](../../packages/space-history/README.md) |
| 空间备份与恢复：定期检查、复制、轮换与两种恢复 | [备份说明](../../packages/base/README.md#备份与恢复)、[定期检查](../../packages/base/src/backup/schedule.ts)、[复制与轮换](../../packages/base/src/backup/store.ts)、[恢复](../../packages/base/src/backup/restore.ts) |
| 课程文件格式、课程检查与课程内容 | [学习包说明](../../packages/learning/README.md)、[写课说明](../../packages/learning/courses/README.md) |
| 在 Pyodide 里运行 Python：页面 Worker、Linux 沙箱与离线包 | [Python 运行器说明](../../packages/python-runner/README.md) |
| 辅导、即时回顾与受限开始 | [辅导说明](learning-tutor.md)、[Agent 与工具](../../packages/learning/src/tutor.ts)、[给模型的文字](../../packages/learning/src/tutor-text.ts) |
| 上课、复习、菜单与判分 | [教学流程说明](learning-flow.md)、[转换入口](../../packages/learning/src/flow.ts) |
| 测验、换题重考、XP、日目标与完课估算 | [测验与进度说明](learning-quiz-xp.md)、[奖励计算](../../packages/learning/src/progress.ts) |
| 学习流程的数值、学生模型常数与尚待查证的假设 | [流程数值](../../packages/learning/src/parameters.ts)、[学生模型常数](../../packages/learning-model/src/model.ts)、[假设清单](../../packages/learning/README.md#尚待查证的假设) |
| 学习记录（只记事实）、重放、补判与恢复命令 | [学习记录说明](learning-records.md)、[插件入口](../../packages/learning/src/plugin.ts) |
| 学习任务画面、提交恢复与 Python 服务契约 | [学习前端契约](learning-protocol.md)、[公开 schema](../../packages/learning/src/protocol.ts)、[python.run 的 schema](../../packages/python-runner/src/protocol.ts) |
| Web 宿主与页面 | [Vite 配置](../../apps/web/vite.config.ts)、[Web 源码](../../apps/web/src/) |
| Desktop 宿主与页面 | [主进程](../../apps/desktop/src/main/index.ts)、[preload](../../apps/desktop/src/preload/)、[renderer](../../apps/desktop/src/renderer/) |

## 运行与验证

交付前在仓库根目录运行：

```sh
npm run check
npm test
npm run build
```

只验证底座或历史包时，使用所属说明中的[底座验证入口](../../packages/base/README.md#运行检查)与[空间历史验证入口](../../packages/space-history/README.md#验证入口)。普通测试使用临时目录、真实 Git、WebSocket、SDK 与脚本化模型提供方，真实模型核实使用单独入口并遵循已授权的资源范围。

宿主进程、协议或关闭机制变化后，需要在组合后的版本验证前端与真实后端的连接和退出。Electron 图形窗口、安装包与其他平台按实际交付范围另行验证，开发构建的结果不扩展为发行支持。
