# 命令执行与授权

Repa 为 Agent、公开客户端和后端能力提供同一个命令执行入口。当前实现支持 Linux，默认限制命令能够访问的文件和网络；需要扩大范围时，通过应用侧授权。

## 设计思路

学习中，你可能会让 Agent 编译一段代码、运行实验，或者用本机工具处理文件。Pi 已经有 `bash` 工具，它会持续返回命令输出，输出过长时只展示末尾，并保留完整日志。这里复用 Pi 的实现，补充了关于执行权限和进程管理的内容。

这些行为由 Repa 后端统一处理。你让 Agent 执行命令时，Pi 的 `bash` 会调用后端的执行入口；如果你在自己的前端或插件中接入执行功能，也使用这一入口。后端记录命令所属的请求，根据当前权限启动进程，并在取消时等待它真正结束。你关闭界面后，也可以在重新连接时查询原请求。

你选择受限执行时，Repa 会把当前授权转换成沙箱的权限配置，再通过固定版本 Codex 的 Linux helper 和 bubblewrap 限制命令的文件与网络访问。这两个程序随 Repa 一起分发，你不用另外安装 Codex 应用。工具行为复用 Pi，系统隔离复用 Codex 的实现；相应地，项目需要维护原生构建和少量上游适配，安装时也要核对系统是否允许这套沙箱运行。

## 实现细节

### 模块分工

Agent 工具使用 Pi 0.87.1 的 `createBashToolDefinition` 和 `createBashTool`。Repa 通过 `BashOperations.exec` 提供实际进程，保留 SDK 的输出展示、完整日志和非零退出语义。

| 模块 | 责任 |
| --- | --- |
| [execution/service.ts](../../packages/repa/src/execution/service.ts) | 请求归属、有效权限、授权交互和输出资源 |
| [execution/process.ts](../../packages/repa/src/execution/process.ts) | 启动进程、管道与描述符归属、取消、超时和退出 |
| [execution/sandbox.ts](../../packages/repa/src/execution/sandbox.ts) | 将批准的范围转换成 helper 的权限配置，准备执行环境 |
| [agent/tool-results.ts](../../packages/repa/src/agent/tool-results.ts) | 保留 Pi 失败工具结果中的结构化详情 |

命令修改文件后，内容模块按外部编辑重新观察。它没有经过内容保存接口，因此不会产生一项可按 FileJournal 撤回的内容操作。

可信 Node 插件本身运行在宿主进程中。只有通过执行服务启动的命令受这里的沙箱约束；插件自己的 Node 代码不在该范围内。生成页面通过[展示桥接](display.md)使用实例绑定的动作，主连接令牌留在可信宿主。

### 有效权限

执行权限由应用配置中的 `execution` 管理，包含默认策略 `default` 和各空间的 `spaces`。你可以通过 `settings.get/set/reset` 查看或修改这些设置，再用 `execution.inspect` 查看当前空间实际使用的策略、受保护路径和活跃命令。权限设置保存在应用侧，空间带来的文件不能自行开启 Full Access。

默认策略是：

```json
{"mode":"restricted","readPaths":[],"writePaths":[],"network":false}
```

在此策略下，命令可以读写当前空间的内容和本次临时目录，读取上游 `minimal` 配置提供的系统运行文件。明确关联的外部材料只开放原件读取；需要其他位置时，通过 `readPaths`、`writePaths` 指定，执行前解析为实际路径。

受限命令不能读取或修改空间的 `.repa`、应用配置和 Agent 配置目录。即使获准读写较大的父目录，这些保护也保留。上游还隐式保护 `.git`、`.agents` 和 `.codex`，但它们在 Repa 空间中属于用户内容，所以适配层为实际存在的目录补充写入规则。Git worktree 指向空间外的 gitdir 时，仍需单独授权。

受限模式重新建立 PATH、HOME、TMPDIR 和语言设置，不继承宿主凭据、代理与 shell 启动配置。HOME 和 TMPDIR 指向本次临时目录，个人工具链按需取得路径读取授权。

你选择 Full Access 后，命令使用本机的 HOME，以及启动 Repa 后端时的工具环境。PATH、代理和工具凭据通过 Pi 准备好的执行环境传入，Repa 不再把系统目录排到用户工具之前，也不为这条命令创建临时 HOME。Bash 以 `-lc` 启动，所以你的登录启动配置可以补充或调整环境；进程启动目录仍由当前学习空间确定。

这沿用固定参考版本 Codex 的环境继承和默认 login 行为。Repa 保持 Pi `bash` 工具的 Bash 语法，尚未接入 Codex 的 shell 快照缓存；具体取舍和源码依据见 [ADR 0005](../adr/0005-execute-display-content-with-host-permissions.md#full-access-的执行环境)。请求归属、输出保存和取消收尾与受限模式使用同一套实现。

#### 为单次命令扩大权限

某条命令需要更大权限时，Agent 可以在 `command`、`timeout` 之外提供 `access: { policy, reason }`。后端会在启动前把命令、工作目录和所需策略交给你确认，确认项标记为 `lifetime: "once"`，通过当前请求的交互入口等待答复。

你批准后，授权只对这条命令生效。拒绝、取消或尚未回答时，命令不会启动。这里的授权由执行服务处理，普通插件自行提出的确认问题不授予执行权限。对于已经执行过的命令，后来取得的批准也不会让它自动重跑。

应用先保存新策略，再检查活跃命令是否仍在允许范围内。需要收回权限时，停止相应命令，设置调用等实际结束后才返回；已经发生的文件修改保留。若新策略引用的路径已失效，也会停止不再获准的旧执行，并报告设置已保存、哪些路径需要修正。

#### 未授权路径与临时影子文件

上游 `minimal` 配置从临时文件系统开始挂载所需目录。为挂载路径建立的祖先目录，可能只是沙箱里的临时目录。

例如，空间是 `/tmp/example/space`，命令写入未获授权的 `/tmp/example/result.txt` 时，可能在沙箱中创建同名临时文件并返回成功，宿主的同名文件保持原样。需要把结果持久写到空间外时，应先授权那个位置。判断结果应结合实际执行环境，不能只凭退出码确认宿主文件已保存。

### 输出与生命周期

执行器为 stdout/stderr 使用真实管道，兼容受限环境中普通 Node 程序的 `console.log` 和 `console.error`；两个输出流全部读取后，才报告进程终态。`execution` 状态和 `execution_output` 事件提供请求来源、执行标识、stdout/stderr 标签、PID、退出码和终止信号。重连快照保留活跃命令的合并输出尾部，完整结果保存在父后台请求或 Pi 工具历史中。

输出超过 Pi 的展示限额后，SDK 将完整日志写入临时文件。Repa 等文件关闭，再流式导入内容 blob 并删除临时日志。模型和客户端取得的是标准资源，模型可以用 `read` 读取 `repa:resource/<id>`，而不是依赖宿主 `/tmp` 路径。取消和非零退出也保留已经产生的输出。

当前临时日志位置和创建权限仍由 Pi 选择，使用宿主 umask。日志没有挂载到默认受限命令环境，公开接口也不返回它的宿主路径。升级 Pi 时需要核对 `BashOperations.exec` 的取消和退出约定，以及失败、取消时取得 `fullOutputPath` 和文件关闭的时序。

工具详情使用标准 `Representation`，会话保存结果时接手资源，分支建立自己的保留关系。新执行结果只声明完整输出日志资源；旧执行记录中的可选 `ExecutionView.resources` 保留读取与复制映射，继续保护已经保存的资源归属。当前通过 Pi 的 `tool_result` 扩展补回失败结果的结构化详情；若 SDK 原生保留这些详情，这层适配可以收缩。空间复制会映射标准结果中的资源归属，历史命令和工作目录保留当时的记录。

当你取消受限命令，Repa 就会向 bubblewrap 的监控进程发送 TERM。监控进程终止沙箱内的 PID 1，并等待其余进程退出，再报告命令结果。Repa 随后等待输出关闭、清理临时目录，最后报告取消完成；超时也使用这条收尾路径。

Full Access 使用独立进程组，先发送 TERM，必要时升级到 KILL，并确认同组进程结束。普通主命令退出时也会收尾仍留在组内的后台任务。两条命令各有自己的执行归属，取消其中一条不会停止另一条。主动脱离进程组的 daemon 应交给相应的服务管理器。

#### 父进程退出的上游适配

固定版本 bubblewrap 在文件系统初始化后才设置 `--die-with-parent` 的父死亡信号。父进程若在此前退出，可能留下 namespace 或启动用户命令。Repa 在 bubblewrap 0.11.2 上保存父 pidfd，提前设置绑定，在 credential 变化后恢复，并在 exec 前再次核对父进程。

运行期间的取消还需要保留真正的等待者。原实现直接结束外层监控进程，内层 PID namespace 随父死亡信号异步退出；这时外层已经关闭，命令却可能仍在收尾。当前补丁让监控进程接收普通终止信号，作为 subreaper 回收内层后代，等它们退出后才结束。因此，受限路径不再用应用层的进程组扫描或定时强杀结束监控进程。

helper 在启动正式命令之前，还会通过一个临时 bubblewrap 进程探测挂载支持。取消若发生在这一步，探测进程也会经过上述收尾，但它可能以普通退出码结束。因此，helper 在回收探测进程后还要保留自己收到的终止信号，并据此结束本次执行，避免把取消当成普通探测结果后又启动用户命令。

父进程崩溃等不可捕捉的退出仍由 pidfd、父死亡信号和内核处理。升级时核对这两条路径，上游完整覆盖后即可收缩补丁。固定摘要构建还要求 helper 使用相邻的捆绑 bubblewrap，来源与构建方式见[沙箱构建说明](../../packages/repa/resources/sandbox/README.md#父生命周期保证与相邻副本选择)。

关闭会话会取消其活跃 Agent 运行。前端断开后，已受理的独立命令按后台请求规则处理；后端退出使用已有的 drain/cancel 语义。相同请求重传返回原记录，重启后未完成记录标为 `interrupted`，不自动再执行。

### 构建与独立启动

来源固定为 [Codex `3d2ee51c`](https://github.com/openai/codex/tree/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/linux-sandbox)，该源码 workspace 版本为 0.153.4。Repa 构建独立 helper 并捆绑 bubblewrap，运行时无需安装 Codex 应用。派生构建的锁文件、补丁与许可材料见[沙箱构建目录](../../packages/repa/resources/sandbox/README.md)。

在仓库根目录执行：

```sh
npm run build:release --workspace=repa
```

产物位于 `packages/repa/resources/sandbox/linux-x64/`，不进入 Git。`npm pack --workspace=repa` 会纳入 `dist`、helper、bubblewrap，以及来源、许可、构建锁、补丁和脚本。普通源码构建不下载 Rust 工具链或编译沙箱；缺少 helper 或匹配的相邻 bubblewrap 时，受限执行返回不可用。

切换源码后，已有的原生副本可能仍使用旧补丁。构建回归会比较 `build.json` 与当前 `source.json`，并核对两个产物的摘要；来源变化时按上面的构建入口重建，继续复用下载与 Cargo 缓存。二进制文件存在只说明有一个副本，不能证明它对应当前执行代码要求的生命周期修复。

当前实际构建和运行的环境是 Linux x64、Ubuntu 24.04.5、glibc 2.39。执行器暂不支持 Windows 和 macOS；其他 Linux 发行版及架构尚未验证。

Ubuntu 的用户命名空间限制可能要求为最终安装位置配置专用 AppArmor profile。在已构建的后端包目录中，可以生成配置：

```sh
node scripts/sandbox-profile.mjs > repa-linux-sandbox.apparmor
# 核对生成的 helper 绝对路径，再由安装者加载。
sudo install -m 0644 repa-linux-sandbox.apparmor /etc/apparmor.d/repa-linux-sandbox
sudo apparmor_parser -r /etc/apparmor.d/repa-linux-sandbox
```

脚本接受 `--helper /absolute/path/codex-linux-sandbox` 和 `--name profile-name`，只输出配置，实际加载由安装者完成。此配置只针对选定 helper，安装位置改变后需要重新生成并验证。Linux 桌面包使用分发专属名称，并由安装／卸载脚本管理两份应用规则，具体路径与验证见[应用交付](distribution.md#安装位置与系统权限)。

## 未完成项与待验证项

| 项目 | 当前状态与影响 | 后续工作 |
| --- | --- | --- |
| 官方界面的执行与授权操作 | 后端接口可用，界面尚未接入权限选择、有效范围、授权详情和命令输出 | 由 [#10](https://github.com/Utopia-V/repa/issues/10) 接入并验证实际窗口的交互与关闭流程 |
| 生成展示的实际宿主 | 后端实例与有限保存／提交动作已接通，官方页面隔离与动作界面仍待接入 | 见[展示说明](display.md#未完成项与待验证项)，由 [#23](https://github.com/Utopia-V/repa/issues/23) 与 #10 联调 |
| 升级与正式分发 | Ubuntu 24.04 x64 已通过实际安装、专用 profile、普通用户运行和卸载验证；跨版本升级、许可与源码分发材料仍待整理 | 见[应用交付](distribution.md#未完成项与待验证项)，由 [#26](https://github.com/Utopia-V/repa/issues/26) 接续 |
| 平台范围 | 当前只支持 Linux，验证集中在 Ubuntu x64 | 其他 Linux 环境按发行目标补验；Windows/macOS 需要相应执行实现，不能直接沿用当前支持声明 |

## 验证入口

在 `packages/repa` 目录运行：

```sh
node --import tsx --import ./test/environment.ts --test test/execution-process.test.ts test/execution-api.test.ts test/blob-import.test.ts test/agent-tools.test.ts test/execution-format.test.ts
```

底层测试使用 helper、实际 C 程序、文件和 localhost 服务。公开接口测试通过后端、客户端与 Pi SDK，使用本地 faux provider 发起工具调用，验证授权、输出、取消、权限收回、重传、重启、分支和复制。

历史结果兼容测试覆盖旧执行结果中额外资源的读取和空间复制映射。启动期取消另用同步屏障固定挂载探测阶段，核对取消后正式命令不再启动。

独立 helper 曾在专用 AppArmor profile 下从普通用户服务验证文件、网络、授权、取消、输出和副本恢复。随后又实际安装 Linux 桌面候选，核对 `/opt/Repa` 下 helper 使用分发专属 profile，并完成受限文件操作、数据重开和卸载清理。运行环境与安装步骤见[应用交付](distribution.md)。
