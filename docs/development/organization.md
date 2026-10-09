# 长期内容整理与语境维护

`@repa/organization` 通过 Pi Skill 提供长期内容整理的方法。用户与 Agent 决定内容怎样拆分、合并和补充，内容工具完成保存。方法包可以替换或关闭，已经保存的文档不受影响。

## 设计思路

笔记越来越长时，你可能想把其中一部分拆成独立文档。这里需要先看哪些内容适合放在一起，原来的引用指向整篇笔记，还是准备拆出的那一部分。这些含义要结合正文和当前学习来判断。

整理方法由 Skill 提供，指导 Agent 先读内容、确认关系，再提出具体修改。确定要怎样整理后，就可以通过共同内容模块，把正文、新文档的身份、已确认的引用和组成关系放在同一项操作中保存。

如果你想改变整理方法，可以修改 Skill。保存中断或需要撤回时，则使用已有的内容操作。方法和保存各有明确入口，整理包只需提供前者，不必再维护一套业务数据库和恢复记录。

## 实现细节

### 为什么没有独立整理服务

`ContentStore` 已经能够在一次保存中准备文件和内容清单，由 `FileJournal` 记录准备、提交与恢复。这里扩展已有保存入口，让新身份和明确的组成变化也能参加同一次操作。

因此当前实现由两部分组成：

- [organize-learning](../../packages/organization/skills/organize-learning/SKILL.md)说明何时补充、拆分、合并、移动，以及哪些信息进入当前学习语境。
- 共同 `applyPatch` 增加明确的登记与组成选项，普通内容工具补足模型可见的元信息和操作查询；学习能力提供原绑定接口的窄工具输入。

包只声明 `pi.skills`，没有空的 backend 工厂、业务数据库或快照 participant。它沿用 Pi 包资源选择与 Repa 信任配置；不加载该 Skill 不会卸掉基础内容操作。官方默认注册项 `repa-organization` 可通过 `plugins.disabled` 关闭；单独安装的版本可移除包选择或使用 Pi 包级 Skill 过滤，完整接入见[插件装配](plugins.md)与[默认组合](official-learning.md)。

### 一次确定的结构修改

`content.applyPatch` 与 `apply_patch` 共用 [ContentPatchInputSchema](../../packages/repa/src/content/schema.ts)。公共客户端填写顶层 `spaceId/operationId`；模型工具使用当前空间，并由适配层生成 `operationId`。嵌套的 `target/ref` 沿用读取或查询结果中的完整引用。

| 可选输入 | 含义 |
| --- | --- |
| `bases` | 为本次实际修改的文件提供所观察的正文基准，规则见[正文与结构的同次保存](content.md#同次保存正文与结构) |
| `registrations` | 给空间内现有文件、补丁新文件或其目录登记身份；可给新对象初始 `members/resources` |
| `registrations[].id` | 明确的新内容标识，便于同一补丁写入稳定引用；省略时由保存入口生成 |
| `compositions` | 用 `{ ref, base, members, resources }` 更新已有内容的普通组成 |

例如将 `notes.md` 的“潮流”部分拆到 `currents.md`，可以在一项操作中：

1. 修改主体正文并保留原身份。
2. 新增 `currents.md`，登记新的文档身份。
3. 修改已确认指向该部分的链接，保留仍指向主体的链接。
4. 修改已绑定 `context.json` 的成员说明或引用。
5. 按实际需要更新一般多文件内容的组成。

新登记检查计划后的文件影像，不要求先单独写出文件再登记。全部新身份建立后才解释初始组成，允许同次保存中的明确引用。已有组成的 `base` 检查操作开始时的结构，避免自身在同一补丁中的移动造成版本冲突；已经删除的对象不能同时修改组成。

所有效果进入同一次 `FileJournal.commit`，复用原有重传、恢复、撤回与资源保留。这里提供统一提交与可恢复的多文件保存，外部文件系统读者仍可能看到中间状态。旧 patch-only 请求与旧 RPC 透传的 `spaceId` 保持原去重形状，可选字段不补空数组。完整规则见[内容保存](content.md#同次保存正文与结构)。

### 模型可见的查询与结果

Pi 把工具的 `content` 交给模型，`details` 用于日志和界面。模型要继续修改文档，就需要在工具正文中读到内容身份、修改基准和操作状态，因此这些信息也进入可见的文本结果。

当前工具分工为：

| 工具 | 模型实际取得或提交的内容 |
| --- | --- |
| `read` | Pi 正文／图像结果，以及另附的 `Repa content snapshot` 文本；后者提供 `target/bodyRevision`，可直接用于补丁正文基准 |
| `edit/write` | 局部修改与按观察基准保存，继续复用 Pi 的适用参数和展示 |
| `content_info` | 指定路径或稳定引用的身份、结构版本、组成与可用状态；不读取正文 |
| `apply_patch` | 明确的正文差异、可选正文基准与结构变化；操作标识由适配层生成 |
| `content_operation` | 按结果中的标识查询实际状态，或通过 `undo` 建立新的逆向保存 |
| `get_learning_context` | 当前绑定及其修改基准 |
| `set_learning_context` | 使用该基准选择本空间的文档／组成根，或清空绑定 |
| `learning_context` | 展开后的当前视图与实际来源 |

内容保存结果及保存期间的错误在文本中提供 `operationId`。模型据此查询实际记录；早期验证尚未进入持久准备时可能查询到 `unknown`，已准备或提交的操作则返回其实际状态。撤回复用共同内容入口，能够区分的后续文字和关系继续保留，冲突留给当前现场处理。

共享能力可通过 `tool.input` 映射窄工具参数，原公共契约和处理函数不变。学习绑定与复习修改均使用此接入，模型不负责生成程序操作标识。绑定保存的 Agent 失败路径也提供操作标识，公共 RPC 错误与既有去重输入保持原样。

### 学习清单与普通组成

一般多文件内容的 `members/resources` 属于内容清单。学习语境的有序 `items` 则是被绑定 JSON 文档的正文，由学习能力解释展开、引用和分组。编辑已有学习清单可以和拆分文件一起进入补丁，不需要更换根绑定。

选择新的语境根时，先从 `get_learning_context` 取得绑定 revision，再调用 `set_learning_context`。已经生成并保存的新文档可以先独立存在，选择它作为当前背景是另一项明确操作；视图 revision 不用来替代绑定修改基准。下一次独立运行按当前绑定与正文准备背景，同一运行继续沿用入口快照。

整理时保留内容身份和来源。引用含义不清楚的部分需要逐项判断，人工校订也有自己的修改基准。当前目标、实际反馈和长期资料怎样组织，由整理方法结合本次工作决定。

## 未完成项与待验证项

| 项目 | 当前状态与影响 | 后续工作 |
| --- | --- | --- |
| 浏览与编辑界面的接入 | 内容操作和 Agent 方法已接通，真实界面中的拆分、引用跳转及共享编辑状态尚待联调 | 由 [#7](https://github.com/Utopia-V/repa/issues/7) 与 [#10](https://github.com/Utopia-V/repa/issues/10) 接入 |
| 实际模型的整理判断 | 集成样本覆盖拆分、补充和语境切换；合并取舍、移动后的引用含义及歧义处理仍需实际评价 | 随 [#39](https://github.com/Utopia-V/repa/issues/39) 的工作表示和 [#40](https://github.com/Utopia-V/repa/issues/40) 的方法改造评价具体判断；[#25](https://github.com/Utopia-V/repa/issues/25) 核对公共接口与组合接续 |

## 验证入口

仓库根目录执行：

```sh
npm run build:backend
npm run check --workspace=@repa/organization
npm test --workspace=@repa/organization
```

[content-reorganization.test.ts](../../packages/repa/test/content-reorganization.test.ts) 使用文件和实际保存入口，验证拆分、登记、组成、重传、重开、基准冲突、移动、删除、撤回，以及保存失败后的 journal 恢复。

[organization.test.ts](../../packages/organization/test/organization.test.ts)通过编译包、真实 Repa／Pi 和实际客户端验证两段路径：

- NOAA 原始材料及不同笔记组织方式 → 读取 Skill 与正文 → 读取实际元信息 → 一次结构补丁 → 操作查询 → 人工编辑 → 关闭重开 → 局部补充 → 修改当前语境 → 下一运行采用新背景。
- 真实目录写权限不足 → 绑定保存失败 → 模型从错误正文取得操作标识 → 查询到 `rolled_back`，原绑定与正文保持。

人工编辑按原始文字核对，包含换行、数学符号和组合字符。两段路径使用本地预设 provider，检查所需信息确实进入模型输入，并验证工具与保存流程；实际整理判断按上表另行评价。
