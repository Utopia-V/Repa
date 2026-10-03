# 官方学习组合

官方学习组合已经接入后端默认配置。它把学习语境、教学方法和所需工具一起提供给新用户，图形界面和完整学习体验的进度见未完成项。

## 设计思路

第一次使用 Repa 时，你应当能直接开始学习，而不必先研究怎样组合插件。默认组合为 Agent 提供材料读取、讲解、出题和反馈方法，再按学习需要使用规划、复习和整理能力。你可以使用这些默认方法，也可以替换或关闭其中的部分。

这些能力也有不同的实现需要。教学与整理主要提供方法，适合使用 Pi Skill；时间检查是确定性计算；复习还需要保存事件和算法状态。因此，默认组合负责把它们接在一起，各包仍按自己的需要使用工具、数据库和生命周期接口。

学习过程中，你的实际表现应当影响后续帮助。默认提示与教学方法要求 Agent 区分生成的题目、实际作答和未来安排，并通过各自的内容或复习接口保存。组合负责把这些能力接起来，不另建一份学习状态数据库。

## 默认提供什么

应用直接附带学习语境、教学方法、材料处理、规划、复习与整理。干净配置无需先安装或信任这些包；未配置模型时，文件读写、材料提取、时间检查和复习数据服务可以通过公开客户端使用。使用 Agent 才需要选择模型连接。

| 注册标识 | 来源 | 责任 |
| --- | --- | --- |
| `repa-learning` | 主包的学习模块 | 学习语境、默认基础提示，以及整个官方学习组合的启用开关 |
| `repa-teaching` | `@repa/learning` | `learn-with-feedback` 方法，结合目标、材料与实际作答开展讲解和反馈 |
| `repa-materials` | `@repa/materials` | 本地与 URL 材料的表示和来源、Wikipedia 百科搜索；详细范围见[材料说明](search-materials.md) |
| `repa-planning` | `@repa/planning` | `plan-learning` 方法、可靠时钟、时间与容量检查 |
| `repa-review` | `@repa/review` | 实际反馈、更正、FSRS 调度、参数与 SQLite 数据 |
| `repa-organization` | `@repa/organization` | `organize-learning` 方法，复用共同内容操作维护文档与语境 |

基础提示说明长期学习中需要保留的信息和各模块用途。Pi 提供 Skill 目录与位置，Agent 按任务选择并读取具体方法，再决定采用讲解、示范、完整帮助或独立练习，并根据实际表现调整后续帮助。

## 装配责任与构建顺序

[`learning/composition.ts`](../../packages/repa/src/learning/composition.ts) 持有官方包名单及组合启用规则，从主包的实际分发依赖解析各包 `package.json` 的位置。它把已安装目录交给通用 `BundledPluginRegistration`；[`PluginRuntime`](../../packages/repa/src/plugins/runtime.ts) 按公开 manifest 加载后台与独立快照，[资源发现](../../packages/repa/src/plugins/resources.ts) 使用 Pi 0.87.1 的内存设置和 `DefaultPackageManager.resolve(skip)` 取得资源。官方业务没有进入通用包解析器。

能力包使用 `repa/plugin`、`repa/protocol` 等公开入口，主包运行时依赖默认能力包。若主包静态导入这些包的类型，干净目录下双方会互相等待对方的 `dist`。当前通过 manifest 动态入口接入：先构建主包，再构建能力包，最后构建前端；后台工厂仍按原接口检查，缺失发布入口会报告不可用，不转去加载源码。

仓库根目录的 `npm run build:backend` 持有后端构建顺序。根目录检查、测试、启动，以及 Web／Desktop 的开发准备都使用这个入口；纯 Skill 包不需要编译。直接运行单个 workspace 的测试前，先在根目录构建后端。`packages/repa` 的 `build:release` 生成主包与沙箱。Linux 桌面包由 `npm run package:linux --workspace=@repa/desktop` 统一构建前端、后端和原生组件，见[应用交付](distribution.md)。

`package.list` 和 `capability.describe` 将随应用提供的包标为 `scope: "bundled"`，并返回其 `registrationId`。官方信任绑定这个实际位置与作用域，不按包名自动信任用户或空间里的代码。发现与预览不修改个人／项目 Pi 设置，也不安装缺失包。可编程宿主通过 `ApplicationOptions.bundledPackages` 添加同类已安装目录，已有函数工厂仍可通过 `ApplicationOptions.plugins` 登记。

## 关闭与替换

沿用 `plugins.disabled` 设置：加入表中的单项标识关闭该项，加入 `repa-learning` 关闭整个官方组合。修改使用 `settings.get` 返回的该项 revision 作为 `settings.set` 的 base。设置按完整值覆盖，空间列表替换应用列表；恢复继承使用 `settings.reset`，不是写入空列表。

启停共用既有生命周期：取消能力工作、等待收尾、关闭会话宿主及插件运行资源，再按新设置装配。规划包的后台和 Skill 同时关闭，纯教学／整理包只关闭资源。关闭学习组合后，通用内容操作、搜索和其他已启用能力继续工作。用户明确覆盖的提示仍属于用户配置。

替换能力时，关闭原官方注册项，为新包选择唯一来源、授予本机信任并登记不同插件标识；公共契约有多个实现时，用 `plugins.implementations` 明确选择。默认包和用户包同名时应使用 `kind: "source"` 与完整 `source + scope`，按名称选择会报告歧义。相同注册标识不作隐式覆盖；同名 Skill 也不能靠扫描顺序实现替换。

文档、会话、学习语境绑定与复习记录继续属于空间。复习包在禁用后仍提供安装级快照入口，复制或备份时由它读取自己的格式，不需要重新启用后台。第三方替换实现接续原数据需要明确支持其格式与数据归属；单纯切换调用实现不会迁移数据库。

## 未完成项与待验证项

| 项目 | 当前状态与影响 | 后续工作 |
| --- | --- | --- |
| 官方界面的完整学习流程 | 后端默认包与公开接口已接通；材料打开、选区提问、共享草稿、交互产物、可视化及界面错误恢复尚未联合验收 | 由 [#7](https://github.com/Utopia-V/repa/issues/7)、[#10](https://github.com/Utopia-V/repa/issues/10) 和 [#23](https://github.com/Utopia-V/repa/issues/23) 接入后，按 #25 完成连续流程 |
| 多会话、多视图的连续使用 | 模块回归已有相应接口验证，尚未从实际界面验证完整学习过程 | 在同一候选版本中联调前后端，检查切换、断线、恢复和人工修改 |
| 真实模型学习试用 | 集成回归使用预设 provider，教学判断与实际体验尚未验证 | 取得模型调用授权后，使用真实目标、材料和反馈试用 |
| 升级与其他发行环境 | Linux x64 安装、普通用户运行和卸载已验证；跨版本升级、其他平台与正式分发材料尚待完成 | 见[应用交付](distribution.md#未完成项与待验证项)，由 [#26](https://github.com/Utopia-V/repa/issues/26) 接续 |

## 验证入口

阅读代码可从装配函数进入，随后按问题查看[插件接入](plugins.md)、[语境](learning.md)、[共同保存](content.md)与各能力说明。教学方法正文位于 [`learn-with-feedback`](../../packages/learning/skills/learn-with-feedback/SKILL.md)，默认提示位于 [`default-prompt.ts`](../../packages/repa/src/learning/default-prompt.ts)。这些内容可直接评价和替换。

[`learning-composition.test.ts`](../../packages/repa/test/learning-composition.test.ts) 用真实服务、公开客户端、Pi SDK 和本地确定性 provider 验证：

- 干净配置下发现默认包并使用本地规划、复习；发现本身不创建复习数据库或改写 Pi 设置。
- 从真实 Skill 目录和材料读取开始，保存文档与学习语境；创建复习题后，收到实际作答才保存反馈。
- 关闭组合后复制空间、重启并重新启用，文档、语境引用和复习记录继续可用。
- 单项关闭与整组关闭使用同一装配结果；同名替换的静态预览与实际运行遵循相同来源选择。

各能力自身的取消、错误恢复、多空间与外部编辑验证见对应开发说明。组合回归用于判断这些入口能否共同工作，真实模型是否会采用恰当方法、正确理解反馈和形成良好学习体验，需要维护者试用。

已在 Linux、Node 24.19.0、Pi 0.87.1 上通过全 workspace 类型检查、测试和构建，并从四个后端包均无 `dist` 的状态完成根目录冷构建。独立安装检查将主包与五个官方能力各自打成 tgz，在仓库外的临时 npm prefix 离线安装后，从安装目录的 CLI 启动真实服务，核对五个 bundled 包、三个 Skill、公共规划时钟与复习保存。Linux 桌面候选另经过实际安装，使用普通用户会话验证默认能力、专用沙箱权限、材料 worker、SQLite 和数据重开；图形页面由维护者确认。安装与尚待完成的交付范围见[应用交付](distribution.md)。
