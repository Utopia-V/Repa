# Linux 沙箱构建

本目录从固定 Codex 源码构建独立 `codex-linux-sandbox`，并捆绑同一归档中的 bubblewrap 0.11.2。Repa 直接使用这些产物，运行时无需安装 Codex 应用。当前构建面向 Ubuntu 24.04 Linux x64。

应用授权怎样转换成执行范围，见[命令执行说明](../../../../docs/development/execution.md)。这里记录原生构建、局部补丁和分发材料，不修改主机的 AppArmor、sysctl 或个人配置。

## 固定来源与构建入口

[source.json](source.json) 保存源码位置、归档与构建锁摘要、工具链、补丁和构建依赖。上游基准为 [Codex `3d2ee51c`](https://github.com/openai/codex/tree/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a)，使用其完整 workspace 和独立二进制入口。源码 workspace 版本为 0.153.4，Rust 工具链为 1.95.0。

在仓库根目录执行：

```sh
node packages/repa/scripts/build-sandbox.mjs
```

脚本需要本机已有 `curl`、`tar`、`git`、`patch`、`rustup`、`cargo`、Clang、Python 3、Ninja、`pkg-config`、`dpkg-deb`、`strip`、`ldd` 和 `lsb_release`。bubblewrap 默认使用 `clang`，可通过 `CC` 指定 C 编译器；当前构建使用 Ubuntu Clang 18.1.3。

缓存默认放在 `$XDG_CACHE_HOME/repa/sandbox`，未设置时使用 `~/.cache/repa/sandbox`。`--cache-dir`、`--output-dir` 和 `--jobs` 可调整位置与并行度。脚本优先复用校验通过的源码归档、固定 Ubuntu 包和 Cargo 缓存，缺少时从固定地址取得。所需 Rust 工具链通过 rustup 安装为 minimal，不切换本机 default。

### 为什么保留派生构建锁

这个上游提交的 workspace 已是 0.153.4，原锁中仍有 149 个本地包记为 0.0.0，直接 `--locked` 构建会失败。因此，[Cargo.lock](Cargo.lock) 只同步这些本地包版本，第三方依赖、checksum、来源和依赖关系保持原样。

构建脚本先校验归档与原锁，应用固定的[局部补丁](parent-lifecycle.patch)，再进入解包后的 `codex-rs` 工作区。它选用 Rust 1.95.0，设置固定 bubblewrap 摘要及 OpenSSL 等局部环境，再以 `--release --locked` 构建 `x86_64-unknown-linux-gnu` 目标。完整命令和环境保存在产物的 `build.json` 中，构建统一使用上面的脚本入口。

锁文件使每次构建使用同一组依赖。升级上游时，需要重新核对本地版本差异；上游修正后即可使用其原锁。

### 本地构建依赖

OpenSSL 使用固定的 Ubuntu `libssl-dev 3.0.13-0ubuntu3.16`，校验后只解包到专用缓存。构建子进程通过 `OPENSSL_INCLUDE_DIR`、`OPENSSL_LIB_DIR` 和 `CPATH` 使用它的头文件，`OPENSSL_STATIC=1` 选择静态库。helper 因而不依赖宿主 OpenSSL 动态库，也无需为此安装系统包或修改全局源。

bubblewrap 使用归档内 `vendor/bubblewrap` 的 Meson 构建入口。Meson 1.3.2 与 `libcap-dev 2.66-5ubuntu2.4` 同样从固定 Ubuntu 包解出，libcap 静态链接。本接入关闭未使用的 SELinux 支持、man、completion 和上游测试构建，Repa 的执行回归单独运行。

每次构建从已校验归档恢复源码并重新配置 Meson，下载与 Cargo 产物缓存保留。归档或补丁校验失败会报告错误，不能用改变摘要的方式继续构建。

## 父生命周期保证与相邻副本选择

固定 helper 为 bubblewrap 设置 `--as-pid-1`、`--new-session`、`--unshare-pid` 和 `--die-with-parent`。原 bubblewrap 在 namespace 的文件系统初始化后才安装父死亡信号；外层进程若在这之前退出，内部 PID 1 可能继续运行，甚至开始用户命令，并让输出管道保持打开。

因此，补丁把父生命周期确认提前到创建 namespace 时，保留原有内核机制：

1. bwrap 在 `clone` 前用 `pidfd_open(self)` 取得真实父进程的句柄，由 namespace child 继承。
2. child 在 `clone` 后立即安装 `PR_SET_PDEATHSIG(SIGKILL)`，再检查 pidfd，覆盖父进程已经退出的情况。新 namespace 中的 `getppid()` 可能为 0，不能代替这份句柄。
3. credential 切换会清除父死亡信号，因此切换后重新绑定，并在 exec 前再次确认父进程仍存在。
4. 外层进程关闭自己的句柄；namespace reaper 保留句柄到结束，直接 exec 的路径通过 `CLOEXEC` 关闭。PID 1 退出后，由内核结束 namespace 中的其余进程。

这条父死亡路径处理监控进程崩溃等情况。普通取消需要等内层收尾之后再报告结果：监控进程会接收 TERM 等终止信号，结束 namespace PID 1，并作为 subreaper 等待遗留后代退出。应用层因而可以等待监控进程结束，不再为受限执行扫描宿主进程组或用定时 KILL 杀掉等待者。

当前要求内核支持所需 pidfd 操作，取得句柄失败时拒绝启动。适配与验证限定在 Repa 使用的非 setuid、新建 user/PID namespace 路径。

另一处适配固定实际使用的 bubblewrap。构建将其摘要写入 `CODEX_BWRAP_SHA256`，helper 只选择相邻的 `codex-resources/bwrap`，再用上游摘要校验检查文件。这样，安装目录中的 helper 和 bubblewrap 使用同一构建组合，缺少文件时也不会改用系统的另一版本。

升级 Codex 或 bubblewrap 时，需要核对父死亡绑定、credential 切换、PID 1 与普通 reaper 的启动和退出，以及相邻资源的选择。上游提供等价行为并通过相同场景验证后，删除相应补丁。权限 profile 的字段、`minimal` 挂载和受保护路径也要与执行适配一起复核。

## 产物与当前验证范围

输出包括：

- `linux-x64/codex-linux-sandbox`。
- `linux-x64/codex-resources/bwrap`。
- 许可文件与 `linux-x64/build.json`。

构建脚本对复制到输出目录的 helper 执行 `strip --strip-debug`，去掉发行时不需要的调试段，保留正常符号表。Cargo 缓存中的未剥离副本用于调试。当前 helper 从约 46 MiB 减为 12 MiB。

`build.json` 记录来源、补丁、Rust/C 编译器、构建与 strip 命令、局部环境、产物摘要和动态依赖。生成产物不进入 Git，具体摘要以对应产物的记录为准。

现有产物在 Ubuntu 24.04.5、glibc 2.39 上构建。helper 动态依赖 `libgcc_s.so.1`、`libm.so.6` 和 `libc.so.6`，最高引用 GLIBC 2.39；bubblewrap 动态依赖 `libc.so.6`，最高引用 GLIBC 2.38。两者都是 x86-64 ELF PIE，尚未覆盖 musl、其他架构或全静态分发。

在 `packages/repa` 目录运行：

```sh
node --import tsx --import ./test/environment.ts --test test/build-sandbox.test.ts test/execution-process.test.ts test/execution-api.test.ts
```

现有回归使用实际构建产物，覆盖 C 编译运行、Git 操作、文件和网络授权、受保护路径、环境、取消、输出及会话关闭。启动期验证通过 bubblewrap 的 `info-fd`/`block-fd` 固定时机，再用 SIGKILL 结束父进程，检查尚未放行的命令没有执行且 namespace 退出。运行期另用真实父子命令验证 TERM 后的监控进程收尾，关闭时确认内部进程已经结束。普通 reaper 与 `--as-pid-1` 路径都有实际进程验证。

一般回归在允许用户命名空间的环境中运行。独立 helper 和 Linux 桌面安装包还分别在普通用户服务中验证，使用各自安装路径的专用 AppArmor profile；安装包验证结束后已卸载程序与规则。改变安装位置时，需重新生成配置并从实际入口验证，步骤见[构建与独立启动](../../../../docs/development/execution.md#构建与独立启动)。

## 分发材料

Codex 的 [LICENSE](licenses/codex-LICENSE) 和 [NOTICE](licenses/codex-NOTICE)、bubblewrap 的 [copyright](licenses/bubblewrap-copyright)、[LGPL](licenses/bubblewrap-LGPL-2)、[GPL](licenses/bubblewrap-GPL-2)，以及 libcap、OpenSSL 的许可材料随产物保留。各依赖使用各自许可，Codex 的许可不替代这些材料。

包内也保存 `source.json`、派生锁、补丁和构建脚本。Linux 安装候选及验证入口见[应用交付](../../../../docs/development/distribution.md)。对应源码归档的公开提供方式和其他发行材料由 [#26](https://github.com/Utopia-V/repa/issues/26) 接续。
