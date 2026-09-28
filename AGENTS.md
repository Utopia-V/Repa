## 项目约束

- 项目自有文档使用简体中文。代码标识符、命令、协议字段、标签以及上游项目、包和接口的专有名称保持原文；必要时在首次出现处给出中文说明。第三方原始文档保持原貌。
- Issue 与需要跨任务继续消费的规格记录在 `Utopia-V/repa` 的 GitHub Issues 中，使用已认证的 `gh` CLI 操作。
- 本仓库只有一个领域 context。已接受且会改变未来解释的领域概念、关系和不变量进入根目录 `CONTEXT.md`；难以逆转、缺少上下文会令人意外且确有取舍的决定才进入 `docs/adr/`。两者都按真实内容惰性创建。
- 当前实现的模块责任、接入方式、持久格式与验证入口由 `docs/development/README.md` 组织，修改所属模块时同步维护对应说明。早期原型形成于设计文档之前，代码结构与测试不作为产品需求或兼容性基线；按已接受的领域语义和接口约定判断保留、替换与复用。
- 设计接口或新增机制前，先核对当前锁定版本的 Pi SDK、已有依赖与仓库实现，优先复用现成实现及其扩展入口。区分产品责任与实现来源：Repa 承担某项行为，不代表要重写相应的通用机制，尤其注意输入投递、工具循环、token 统计、压缩、会话历史、认证、独立模型调用和包管理。具体接入位置见[Agent 开发说明](docs/development/agent-runtime.md#sdk-能力与接入范围)。任务说明区分现成能力接入与产品差异，完整交付的依赖不自动阻塞可独立接通的部分。新增实现应对应实际能力缺口，由合适的模块持有；复用与否按实际行为和生命周期判断。
- 基座按实际需要提供通用调用、权限、运行、内容与生命周期机制；业务实体、算法、数据库 schema 和迁移由所属能力负责。插件只接入实际使用的服务，可复用的存储辅助能力按需要作为可选依赖共享。学习语境的组织规则和默认教学提示由官方学习能力提供，迁接时保留已有学习语义与开箱可用的默认组合；具体边界见 ADR 0001—0004。
- 复用须保留 [CONTEXT.md](CONTEXT.md) 与相关 ADR 中已接受的产品语义，尤其是持续维护的学习语境、目标与实际学习反馈对后续帮助的影响、长期内容与多种学习产物的连续使用，以及开箱可用的官方学习体验。现成实现存在缺口时，在相应边界补足、扩展或替换，不能为了减少代码而削弱这些行为。选择 prompt、Skill、工具或代码实现时，以能否完整承担所需行为为准；采用通用机制不免除 Repa 对学习体验的设计、整合与验证责任。
- 通用 Agent 的交互与运行行为按具体问题优先参考 Codex 的[公开应用协议](https://learn.chatgpt.com/docs/app-server)、[权限与安全](https://learn.chatgpt.com/docs/agent-approvals-security)、[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)，以及对应源码和相邻测试。Pi 的现成行为不满足 Repa 约定时，优先核对 Codex 如何处理同类问题，再在原责任边界补足、扩展或替换；核验具体入口、模式与限制，以 Repa 产品语义决定采用范围。影响设计的取舍及所依据版本记录在相应 ADR 中。

## 项目具体规范

分支整合、集中合并和阶段交付前读取[整合规范](docs/development/integration.md)，按合并范围核对组合行为、验证与交接；日常开发以 `dev` 为基线。

编写、修改或审阅相应内容前，读取对应的项目 Skill；只加载本次涉及的类别，已读取当前版本时不重复加载。它们持有本仓库的具体写法，设计、实施与验证的方法论继续由相应方法 Skill 提供。

| 内容 | 规范入口 |
| --- | --- |
| 项目文档与公开技术说明 | [repa-docs-style](.agents/skills/repa-docs-style/SKILL.md) |
| 测试代码与夹具 | [repa-test-style](.agents/skills/repa-test-style/SKILL.md) |
| 代码格式、类型与接口实现 | [repa-code-style](.agents/skills/repa-code-style/SKILL.md) |

前端近端规范补充相应 workspace 的框架、组件与设计系统要求，后端专用规则不扩展到前端。路径、命令和配置随所属实现一起维护；调整具体规范时更新上述入口，不在其他文件复制第二份规则。

## 目录规范

- 前端设计规范见 [docs/design-system.md](docs/design-system.md)，实现说明见 [docs/design-system-implementation.md](docs/design-system-implementation.md)。

- Web 前端开发同时遵循 [apps/web/AGENTS.md](apps/web/AGENTS.md)。
