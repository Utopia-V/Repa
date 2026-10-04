# Linux 桌面应用构建与安装

当前提供 Linux x64 的 `.deb` 构建入口。安装包包含 Electron 前端、本机后端、五个默认能力包和独立沙箱组件。Ubuntu 24.04 x64 已完成实际安装、普通用户启动、内容与复习记录重开，以及关闭和卸载验证。

## 设计思路

开发时，前端可以从 workspace 找到后端和能力包；安装后，这些目录需要完整地随应用交付。因此，打包先把后端与默认能力制作成 npm 包，再在独立目录中安装生产依赖。后端从实际安装位置加载能力，开发目录不参与运行。

Electron 已经带有 Node 运行时。桌面主进程使用自己的可执行文件，通过 `ELECTRON_RUN_AS_NODE=1` 启动原有 `repa serve`，于是前端和后端共用同一份运行时。当前 Electron 44.3.0 带有 Node 24.20.0，包内已验证 `node:sqlite` 和材料解析 worker。

安装包由 electron-builder 26.15.3 生成。当前保留物理文件布局，使 helper、相邻 bubblewrap 和 worker 可以直接按实际路径启动。代价是包内文件较多；后续若改用 ASAR，需要同时处理原生可执行文件和 worker 的装载路径，并补验这些入口。

## 从源码构建

在仓库根目录安装依赖后运行：

```sh
npm ci
npm run package:linux --workspace=@repa/desktop
```

构建入口为 [package-linux.mjs](../../apps/desktop/scripts/package-linux.mjs)。它先调用既有 `build:sandbox`，再构建后端和 Desktop，因此首次打包也会生成固定源码版本的原生组件。工具链与依赖准备见[沙箱构建说明](../../packages/repa/resources/sandbox/README.md)。构建使用 Cargo 与下载缓存，完成后只对发行 helper 副本去除调试段；缓存中的调试副本保留。

后端与五个默认包通过 `npm pack` 进入临时安装目录。生产依赖解析以仓库根锁文件为起点，由 npm 将 workspace 引用替换为本次本地包并生成安装锁，再通过 `npm ci --omit=dev` 建立生产目录。最终应用 manifest 记录正常版本号，本地归档路径只用于构建。

中间目录和产物位于 `.scratch/desktop-delivery/`。每次构建会重新生成这个目录，其中 `dist/` 包含 `.deb` 和 `linux-unpacked/`；这里的文件是构建产物，不加入 Git。Electron 使用本机已安装的对应版本副本，构建脚本不会另带第二个 Node。

构建最后自动运行安装布局检查。也可以对一份现有包单独执行：

```sh
npm run verify:linux --workspace=@repa/desktop -- \
  .scratch/desktop-delivery/dist/Repa-0.1.0-amd64.deb
```

[verify-linux-package.mjs](../../apps/desktop/scripts/verify-linux-package.mjs) 将包解到临时目录，从其中的 Electron、CLI 和客户端启动检查，验证默认能力、SQLite、HTML 与 URL 材料、资源保存、展示桥接、worker 和沙箱入口。它还报告运行进程实际使用的 AppArmor profile，便于区分构建环境与普通用户安装环境。

## 安装位置与系统权限

使用系统包管理器安装 `.deb` 时，需要管理员确认。应用安装在 `/opt/Repa`，同时登记 `repa` 命令和桌面入口。包管理器按依赖安装 ripgrep、Poppler 及所需系统库；这些程序分别用于文本搜索和 PDF 提取。

Ubuntu 24.04 的用户命名空间限制需要按实际可执行文件配置。Electron 主程序沿用 electron-builder 的 AppArmor 安装模板，Repa helper 使用现有 [sandbox-profile.mjs](../../packages/repa/scripts/sandbox-profile.mjs) 生成规则：

| 用途 | 配置文件 | 附着的程序 |
| --- | --- | --- |
| Electron 主程序 | `/etc/apparmor.d/repa` | `/opt/Repa/repa` |
| 受限命令 helper | `/etc/apparmor.d/repa-desktop-linux-sandbox` | `/opt/Repa/resources/app/node_modules/repa/resources/sandbox/linux-x64/codex-linux-sandbox` |

helper 的分发规则使用独立名称，避免覆盖开发目录中的 `repa-linux-sandbox` 规则。安装脚本按系统支持情况解析并加载本包规则，卸载时移除；全局 AppArmor 和 sysctl 设置保持不变。实际命令的文件和网络范围由 [执行服务](execution.md) 转换成沙箱策略。

普通用户配置与空间数据写到应用数据目录和你选择的学习空间，不写入 `/opt/Repa`。默认能力随包可用，Agent 调用仍需先配置模型连接。

## 启动、退出与数据接续

你打开桌面应用后，主页面通过隔离 preload 请求后端连接。主进程读取应用专属的连接文件，复用仍活动的后端，或启动包内 CLI；后端发布就绪信息后，renderer 才建立公开客户端连接。具体进程入口见 [main/index.ts](../../apps/desktop/src/main/index.ts) 与 [repa-process.ts](../../apps/desktop/src/main/repa-process.ts)。

窗口关闭后，连接按已有宿主生命周期释放。后端以 `--exit-when-detached` 启动，最后一个客户端离开后按已有请求规则结束工作，再清理连接文件。空间锁由后端持有，另一进程不能同时取得同一空间的写入权。

再次启动时，后端从原应用配置和空间数据恢复。内容、请求与插件数据库分别由所属模块解释版本；已经保存的学习记录和文档不依赖某一次 Electron 进程。手工升级前应先退出应用并等待后端收尾，当前尚未提供应用内升级协调。跨版本升级与回退的验证范围列在下表。

## 已完成的验证

已在 Ubuntu 24.04 x64 上实际安装候选包，以普通用户服务启动包内 Electron。后端进入 `repa` AppArmor profile，受限命令进入 `repa-desktop-linux-sandbox` profile。检查覆盖：

- 五个默认能力包和 23 项空间能力可以发现，路径均位于实际安装目录。
- 受限命令能在当前空间保存结果，对空间旁的测试文件读取被拒绝。
- HTML 材料经包内 worker 提取，复习接口保存真实 SQLite 记录。
- 后端关闭重开后，空间身份、文档、请求结果和复习记录保持。
- 维护者确认图形页面正常；关闭窗口后，应用与后端退出，连接文件移除。
- 卸载后，程序、命令链接、桌面入口、两份 AppArmor 文件和内核 profile 均已移除。

构建阶段的解包检查与这次普通安装验证分别保留：前者可以重复运行，后者核对系统安装脚本、真实应用路径和用户会话权限。完整学习交互由官方界面联调覆盖，入口见[官方学习组合](official-learning.md#未完成项与待验证项)。

## 未完成项与待验证项

| 项目 | 当前状态与影响 | 后续归属 |
| --- | --- | --- |
| 发行版本升级 | 历史构建之间的数据接续、旧插件数据库及失败恢复已验证，见[空间说明](spaces.md#验证入口)；两个发行安装包之间的替换尚未验证 | 在需要保留用户数据的发行升级中，由 [#26](https://github.com/Utopia-V/repa/issues/26) 验证实际安装过程；数据迁移由各格式所属模块负责 |
| 其他平台 | 当前入口仅构建 Linux x64；Windows 和 macOS 尚无相应安装产物与平台验证 | #26 的对应平台交付 |
| 正式分发材料 | 构建附带依赖清单和可取得的许可文本；项目自身许可证、部分依赖缺失的许可原文及原生源码提供方式仍待整理 | 维护者与 #26；当前尚未公开 Release 或签名发布 |
| 产品界面与连续学习 | 当前安装的是仓库现有前端，完整学习工作台、展示宿主和设置页面按各自任务推进 | [#10](https://github.com/Utopia-V/repa/issues/10)、[#23](https://github.com/Utopia-V/repa/issues/23)、[#25](https://github.com/Utopia-V/repa/issues/25) |
