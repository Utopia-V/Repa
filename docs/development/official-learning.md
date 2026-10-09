# 官方学习组合

官方学习组合由 `@repa/learning` 产品入口装配。它把学习语境、教学方法和所需工具一起提供给新用户，图形界面与学习闭环程序的进度见未完成项。

## 设计思路

第一次使用 Repa 时，你应当能直接开始学习，而不必先研究怎样组合插件。默认组合为 Agent 提供材料读取、讲解、出题和反馈方法，再按学习需要使用规划、复习和整理能力。你可以使用这些默认方法，也可以替换或关闭其中的部分。

这些能力也有不同的实现需要。教学与整理主要提供方法，适合使用 Pi Skill；时间检查是确定性计算；复习还需要保存事件和算法状态。因此，默认组合负责把它们接在一起，各包仍按自己的需要使用工具、数据库和生命周期接口。

局部教学需要知道你实际尝试了什么、在哪一步需要帮助。默认提示与教学方法据此调整解释或提示，并把学习者的作答与助手产物区分开。有接续价值的原文与材料引用可以保存，但这些普通文档不是学生状态计算或学习任务调度的替代物。当前组合提供教学辅助，学习闭环仍需要领域程序承担状态更新和后续选择。

## 实现细节

### 默认提供什么

通过 `repa-learning` CLI、`startLearningServer` 或 `createLearningApplication` 启动时，产品附带学习语境、教学方法、材料处理、规划、复习与整理。通用 `RepaApplication` 和 `startRepaServer` 只提供底座，学习组合按宿主选择安装。干净配置无需先安装或信任这些包；未配置模型时，文件读写、材料提取、时间检查和复习数据服务可以通过公开客户端使用。使用 Agent 才需要选择模型连接。

| 注册标识 | 来源 | 责任 |
| --- | --- | --- |
| `repa-learning` | `@repa/learning` 的轻量注册 | 学习语境、默认基础提示，以及整个官方学习组合的启用开关 |
| `repa-teaching` | `@repa/learning` | `learn-with-feedback` 开展当前讲解和实际反馈 |
| `repa-materials` | `@repa/materials` | 本地与 URL 材料的表示和来源、Wikipedia 百科搜索；详细范围见[材料说明](search-materials.md) |
| `repa-planning` | `@repa/planning` | `plan-learning` 方法、可靠时钟、时间与容量检查 |
| `repa-review` | `@repa/review` | 实际反馈、更正、FSRS 调度、参数与 SQLite 数据 |
| `repa-organization` | `@repa/organization` | `organize-learning` 方法，复用共同内容操作维护文档与语境 |

基础提示说明长期学习中需要保留的信息和各模块用途。Pi 提供 Skill 目录与位置，Agent 按任务选择并读取具体方法，再决定采用讲解、示范、完整帮助或独立练习，并根据实际表现调整后续帮助。

### 教学辅助与内容接续

遇到一个代码问题时，你可以先取得完整解释，也可以选择提示或独立尝试。`learn-with-feedback` 使用已有材料和你提交的代码、推导或回答，找出决定结果的步骤，再说明依据与修正方法。独立完成、提示后完成和共同完成提供不同的证据；助手生成的参考答案与产物按助手工作成果保存。

需要在以后继续使用的原始尝试、提示、解释和材料引用，可以通过内容工具保存到空间的普通文档中。已有笔记直接参与这套操作，局部修改保留人工原文。学习语境可以绑定已有文档或引用组成，让下一次会话取得相关背景；详细材料和记录仍按引用读取。关闭教学方法或整个组合以后，这些内容继续属于空间。

这些入口已经能支撑讲解、反馈和内容接续。沿知识关系更新学生状态、传播作答证据、据此选择新学习与巩固任务的闭环程序入口仍待研究实现。当前独立 FSRS 复习能力按自身项目与反馈接口运行，普通对话或综合任务的表现不自动折成项目评分。规划方法处理用户已选择工作的时间预算与日历约束，不承担学习闭环的任务选择。

Pi 目录发现只加载方法的描述与位置。Agent 选用 `learn-with-feedback` 或整理方法后，再通过 `read` 取得正文；方法文件位于已启用 Skill 的目录内，复用现有只读资源权限。

### 装配责任与构建顺序

[`product.ts`](../../packages/learning/src/product.ts) 提供 `learningApplicationOptions`、`createLearningApplication` 和 `startLearningServer`。它安装本包的 `learningPluginRegistration`，再由 [`composition.ts`](../../packages/learning/src/composition.ts) 持有五个官方包的名单及组合启用规则，从产品的实际分发依赖解析各包 `package.json` 的位置。产品把已安装目录交给通用 `BundledPluginRegistration`；[`PluginRuntime`](../../packages/repa/src/plugins/runtime.ts) 按公开 manifest 加载后台与独立快照，[资源发现](../../packages/repa/src/plugins/resources.ts) 使用 Pi 0.87.1 的内存设置和 `DefaultPackageManager.resolve(skip)` 取得资源。官方业务没有进入通用包解析器。

领域与能力包使用 `repa`、`repa/plugin`、`repa/protocol` 等公开入口。通用主包的生产依赖不指向学习产品；学习产品依赖四个兄弟能力包，自身通过 `pi.skills` 提供教学方法，后台语境能力由轻量注册安装，不在自身 manifest 重复登记。构建时先生成底座的公开入口，再构建能力包和学习产品，最后构建前端。能力包的 manifest 后台工厂仍按原接口检查，缺失发布入口会报告不可用，不转去加载源码。

仓库根目录的 `npm run build:backend` 持有后端构建顺序。根目录检查、测试、启动，以及 Web／Desktop 的开发准备都使用这个入口；纯 Skill 包不需要编译。直接运行单个 workspace 的测试前，先在根目录构建后端。`packages/repa` 的 `build:release` 生成主包与沙箱。Linux 桌面包由 `npm run package:linux --workspace=@repa/desktop` 统一构建前端、后端和原生组件，见[应用交付](distribution.md)。

`package.list` 和 `capability.describe` 将随应用提供的包标为 `scope: "bundled"`，并返回其 `registrationId`。官方信任绑定这个实际位置与作用域，不按包名自动信任用户或空间里的代码。发现与预览不修改个人／项目 Pi 设置，也不安装缺失包。`learningApplicationOptions(options)` 追加官方注册和包，同时保留宿主自定义项；宿主提供的 `promptDefaults` 覆盖产品默认，明确的空字符串与空列表也保留。已保存的用户设置由底座的作用域解析处理。可编程宿主通过 `ApplicationOptions.bundledPackages` 添加同类已安装目录，已有函数工厂仍可通过 `ApplicationOptions.plugins` 登记。

### 关闭与替换

沿用 `plugins.disabled` 设置：加入表中的单项标识关闭该项，加入 `repa-learning` 关闭整个官方组合。修改使用 `settings.get` 返回的该项 revision 作为 `settings.set` 的 base。设置按完整值覆盖，空间列表替换应用列表；恢复继承使用 `settings.reset`，不是写入空列表。

启停共用既有生命周期：取消能力工作、等待收尾、关闭会话宿主及插件运行资源，再按新设置装配。规划包的后台和 Skill 同时关闭，教学与整理注册项关闭相应 Skill 资源。关闭学习组合后，通用内容操作、搜索和其他已启用能力继续工作。用户明确覆盖的提示仍属于用户配置。

替换能力时，关闭原官方注册项，为新包选择唯一来源、授予本机信任并登记不同插件标识；公共契约有多个实现时，用 `plugins.implementations` 明确选择。默认包和用户包同名时应使用 `kind: "source"` 与完整 `source + scope`，按名称选择会报告歧义。相同注册标识不作隐式覆盖；同名 Skill 也不能靠扫描顺序实现替换。

文档、会话、学习语境绑定与复习记录继续属于空间。复习包在禁用后仍提供安装级快照入口，复制或备份时由它读取自己的格式，不需要重新启用后台。第三方替换实现接续原数据需要明确支持其格式与数据归属；单纯切换调用实现不会迁移数据库。

## 未完成项与待验证项

| 项目 | 当前状态与影响 | 后续工作 |
| --- | --- | --- |
| 官方界面接入 | 后端默认包与公开接口已接通；材料打开、选区提问、共享草稿、交互产物、可视化及界面错误恢复尚未联合验收 | 由 [#7](https://github.com/Utopia-V/repa/issues/7)、[#10](https://github.com/Utopia-V/repa/issues/10) 和 [#23](https://github.com/Utopia-V/repa/issues/23) 接入，已就绪部分由 [#25](https://github.com/Utopia-V/repa/issues/25) 联调 |
| 多会话、多视图的状态协作 | 模块回归已有相应接口验证，实际界面的共同状态仍待接通 | 在同一候选版本中核对切换、断线、恢复和人工修改，问题回到所属模块 |
| 学习闭环程序与效果评价 | 当前提供教学辅助、内容接续及独立复习工具；学生状态计算、知识关系传播与学习任务选择仍待研究实现 | [#38](https://github.com/Utopia-V/repa/issues/38) 接续算法研究，再依据结论实现领域程序；教学试用保留局部反馈与后续表现的实际证据 |
| 升级与其他发行环境 | Linux x64 安装、普通用户运行和卸载已验证，历史构建间的数据接续与恢复也已验证；发行安装包之间的替换、其他平台与正式分发材料尚待完成 | 见[应用交付](distribution.md#未完成项与待验证项)，由 [#26](https://github.com/Utopia-V/repa/issues/26) 接续 |

## 验证入口

阅读代码可从装配函数进入，随后按问题查看[插件接入](plugins.md)、[语境](learning.md)、[共同保存](content.md)与各能力说明。方法正文位于 [`learn-with-feedback`](../../packages/learning/skills/learn-with-feedback/SKILL.md)，默认提示位于 [`default-prompt.ts`](../../packages/learning/src/default-prompt.ts)。这些内容可直接评价和替换。

[`learning-composition.test.ts`](../../packages/repa/test/learning-composition.test.ts) 用真实服务、公开客户端、Pi SDK 和本地确定性 provider 验证：

- 干净配置下发现默认包并使用本地规划、复习；发现本身不创建复习数据库或改写 Pi 设置。
- 从真实 Skill 目录和材料读取开始，保存文档与学习语境；独立复习项按用户明确提交的自评保存反馈。
- 关闭组合后复制空间、重启并重新启用，文档、语境引用和复习记录继续可用。
- 单项关闭与整组关闭使用同一装配结果；同名替换的静态预览与实际运行遵循相同来源选择。
- 教学与整理方法通过真实 `read` 按需读取；关闭 FSRS 后，局部编辑保留人工原文，新会话仍能读取原始尝试、帮助条件及材料引用；关闭教学方法也保留已存内容。

各能力自身的取消、错误恢复、多空间与外部编辑验证见对应开发说明。组合回归用于判断这些入口能否共同工作。当前局部反馈的帮助效果与未来闭环的学习效果，需要各自取得真实学习者的后续表现。

2026-10-10 的产品拆分验证分别在两个仓库外目录中进行离线生产安装，使用 Linux、Node 24.19.0、npm 12.0.2 和 Pi 0.87.1。只安装 `repa` 的目录无法解析学习包，实际 CLI 提供 4 项通用能力；官方学习目录发现 5 个 bundled 包和 24 项能力，实际 CLI 可以保存并预览学习语境。两者都通过本地 HTTP provider 验证了结构化模型调用的成功值、格式失败原回复和用量；学习版本另经公开复习接口验证，修改题目和答案后，反馈仍保留录入时的项目依据与帮助原文。发布文件不再含隐式程序桥。

### 历史验证记录

2026-10-05 的方法候选通过全 workspace 检查、测试与构建，主包共 367 项测试通过，组合测试覆盖四个方法。方法试用另由 Astra 子 Agent 经本地桥接驱动真实 Pi 工具循环，按固定材料与输入运行，切换会话时使用全新模型上下文。结果与后续问题见[持续学习研究](../research/learning-task-selection.md#首轮试用及修订)。

2026-10-05 的独立安装检查在 Linux、Node 24.19.0、Pi 0.87.1 上，将主包与五个官方能力各自打成 tgz，再于仓库外离线安装。从安装目录的 CLI 启动服务后，五个 bundled 包、24 项能力、四个 Skill 与两份新方法参考均可使用。检查还通过公开接口修改已有复习项，并由真实 Pi SDK 执行 Bash 中的 Node 程序，经安装后的 `repa/program` 查询能力和调用规划时钟。SDK 和能力包均从安装目录解析。

此前的组合还从四个后端包均无 `dist` 的状态完成根目录冷构建。Linux 桌面候选另经过实际安装，使用普通用户会话验证默认能力、专用沙箱权限、材料 worker、SQLite 和数据重开；图形页面由维护者确认。安装与尚待完成的交付范围见[应用交付](distribution.md)。
