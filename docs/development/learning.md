# 官方学习语境

学习语境保存当前学习需要长期保留的背景，例如目标、已知困难，以及相关文档的组织方式。`@repa/learning` 负责选择和展开这些内容，再通过底座的插件背景接口把视图交给 Agent 使用。通用 Repa 应用不默认安装学习语境。

## 设计思路

你换一个会话后，往往还在推进同一个学习目标。如果目标和已经遇到的困难只留在旧对话里，下一次就得重新交代，或先从历史中找出来。官方学习产品因此把学习语境关联到空间中的文档，你和 Agent 可以随学习进展修改它，新会话也能使用这些背景。

你会修改文档，已经发生的交流却需要保留当时的依据。启用自动注入后，每次开始新运行，Repa 都会读取当前学习语境，得到包含正文、来源和修订的视图。视图变化时保存新的完整快照，未变化时复用已有快照。以后你恢复旧会话，也会根据当前空间准备背景，同时保留过去使用过的快照。

怎样选择文档、分组和展开，是学习语境自己的规则，由官方学习能力负责。内容模块保存文件并处理恢复，Pi 处理会话历史与模型运行。当你要调整语境的组织方式，就在学习能力中修改这些规则；关闭学习组合后，内容读写和普通 Agent 会话也能使用。

当前使用完整视图快照，而不是另行维护摘要。它能保留实际提供的背景，但较大的语境也会占用更多上下文。token 统计和压缩复用 Pi，何时复用快照、压缩后怎样补回背景，见 [ADR 0002](../adr/0002-progressively-load-learning-context.md)。

## 实现细节

### 当前模块与接口

| 位置 | 责任 |
| --- | --- |
| [context.ts](../../packages/learning/src/context.ts) | `LearningContext(content).get/set/preview`，读取和修改绑定，生成学习语境视图 |
| [schema.ts](../../packages/learning/src/schema.ts) | 定义绑定、组成成员、分组和视图的接口 |
| [plugin.ts](../../packages/learning/src/plugin.ts) | 把同一份实现接到公开能力和 Agent 工具 |
| [content-format.ts](../../packages/learning/src/content-format.ts) | 解释旧 catalog 的 `context` 字段，映射组成文档中的引用 |
| [background.ts](../../packages/learning/src/background.ts) | 生成和识别学习语境快照，通过通用背景接口交给 Host |
| [default-prompt.ts](../../packages/learning/src/default-prompt.ts) | 提供默认学习提示，具体教学方法由 Skill 补充 |
| [contributions.ts](../../packages/learning/src/contributions.ts) | `learningPluginRegistration` 提供能力、安装级格式和背景贡献 |
| [client.ts](../../packages/learning/src/client.ts) | `callLearning` 通过通用能力调用提供类型化客户端入口 |
| [content/store.ts](../../packages/repa/src/content/store.ts) | 提供共同读取边界和元数据保存入口 |

客户端从 `@repa/learning/client` 导入 `callLearning`，以 `context.get/set/preview` 选择领域方法。helper 校验参数，通过通用 `capability.invoke` 调用版本为 `1` 的 `repa.context.*` 能力，再校验领域结果；`@repa/learning/protocol` 提供相应 schema 与类型。核心协议不登记学习专用 RPC。

实际调用按 `plugins.implementations` 选择实现；只有一个启用实现时直接使用该实现。官方注册提供 `official`，替代实现须满足同一份领域接口，选择方式见[能力宿主](capabilities.md#定义与实现选择)。

模型通过 `get_learning_context` 取得当前绑定和它的 `revision`。修改时，把这个修订作为 `set_learning_context` 的 `base`，提交本空间中的 `{ kind, contentId }`；传入 `null` 表示清空绑定。工具接入层补上当前空间和新的操作标识，客户端 helper 则填写完整参数，保留 `spaceId`、`operationId`、`base` 与原绑定形状。

`learning_context` 工具读取展开后的视图。这里需要区分两种修订：绑定修订用于修改选择，视图修订描述展开后的正文与来源。修改绑定应使用 `get_learning_context` 返回的基准，不能使用视图修订。保存失败时，工具错误中会提供操作标识，可以通过 `content_operation` 查询实际状态。

### 展开与预览

`preview` 在一次内容队列操作中读取绑定、组成文档和全部展开成员。通过 Repa 发起的后续保存要等这次读取结束，因此视图不会由保存前后的两组成员拼接而成。内部使用同一次观察入口读取，避免逐个调用公共读取方法而重新排队。

这个边界只协调经过 Repa 的操作。外部编辑器仍可直接修改文件，预览记录本次实际读到的字节和修订。

视图按组成清单的顺序展开明确选择的成员，并保留分组。展开项包含当前正文；引用项提供标题、内容引用和说明，供 Agent 按需读取。普通文档链接不自动递归展开。

清空绑定会得到明确的空视图。文件缺失、编码错误或组成格式错误则返回准备失败，保留原请求供后续处理；这些情况与用户主动清空语境不同。

### 关闭、启用与替换

关闭 `prompts.learningContext` 后，运行输入不再自动加入语境，并从模型工作视图中排除可识别的旧自动快照。历史记录保留，绑定查询、修改和独立预览都可使用。

把 `repa-learning` 加入 `plugins.disabled` 会关闭整个官方学习组合，包括官方语境实现、自动背景、默认教学提示、材料、规划、复习和整理。没有另行启用的替代实现时，调用学习语境能力返回 `capability_not_found`；其他插件提供的已选中实现仍可通过同一客户端 helper 调用。已经保存的文档和绑定保留，移除禁用设置并重开相应实例后，可以接续使用原数据。用户显式覆盖的基础提示不会随组合关闭而删除。

解释旧数据所需的格式支持，与学习运行服务分开安装。宿主安装 `learningPluginRegistration` 时，其 `formats` 贡献把 `learningContentFormat` 交给底座；即使关闭学习服务，普通保存、备份和复制也能识别已有的语境数据。纯内容空间不安装学习注册，未知的旧字段仍按原数据保留。

这份格式贡献兼容既有 catalog，不改变原存储位置。普通插件把业务实体保存在自己的数据存储中，通过内容引用关联文档，通过快照接口参加空间备份；不向共同 catalog 添加任意业务字段。

### 保存、历史与复制

绑定保存在 `.repa/content/catalog.json` 的 v1 `context` 字段中，沿用学习语境迁入领域包之前的位置和格式；本次迁移不新建数据库或重写已有 catalog。未安装对应格式时，内容保存也会保留已有字段；安装后由格式实现检查字段含义，内容模块检查身份和保存范围。

`LearningContext.set` 将 `{ method: "context", ...params }` 交给共同保存器，保留旧操作的去重输入。因此，版本检查、操作结果查询、撤回和中断恢复都使用已有内容操作，不另建一套保存记录。

复制空间时，除了当前绑定，还要处理历史 catalog 中曾经使用过的组成文档。复制逻辑会映射当前文件、历史 blob，以及操作结果中的 before/after 和正文修订。否则，即使当前文件已经指向副本，撤回一次旧操作仍可能恢复源空间的引用。这也是格式接入需要参与共同复制过程的原因。

学习语境快照保存在 Pi Session JSONL 中，沿用 `repa.learning-context` 消息类型、正文模板和 details。领域包的 `background.ts` 负责生成和识别这种消息。运行准备时，Application 通过选定的 `repa.context.preview` 实现取得视图，并提供本次 Agent 的来源、取消信号和服务；它读取的设置包含当前会话覆盖。

[agent/background.ts](../../packages/repa/src/agent/background.ts) 处理通用背景快照的判重、关闭、分支和压缩后补回。Pi 的计量与模型调用使用同一份工作视图。Host 取得准备好的背景，不再解释学习语境的组成文件。

### 静态提示预览

`prompts.preview` 可以直接展示已知的官方学习视图，以及当前选中的官方查询、绑定和视图工具。替换某项实现后，预览不会假定它与官方实现具有相同内容。

例如，替换语境视图时，预览把 `repa.context.preview:<implementationId>` 标为动态来源，等实际运行再调用该能力。静态预览不执行替代插件的工厂或处理函数。具体范围见[Agent 说明](agent-runtime.md#配置与实际来源)。

教学方法和默认包如何接入，见[官方学习组合](official-learning.md)。界面接入的未完成项由[共享能力说明](capabilities.md#未完成项与待验证项)统一记录。

## 未完成项与待验证项

本模块提供文档背景、内容接续及其恢复语义。学生状态计算、知识关系传播和后续任务选择仍待学习领域研究与实现，见[官方学习组合](official-learning.md#未完成项与待验证项)。长期使用中的语境大小和压缩频率需要实际使用数据。

## 验证入口

在仓库根目录运行 `npm run build:backend`、`npm run check` 和 `npm test`。

- [content.test.ts](../../packages/repa/test/content.test.ts)：绑定、展开、引用和分组，以及 v1 数据的重开、撤回和复制。也覆盖关闭学习服务后的普通保存，以及复制后历史操作的引用映射。
- [agent-context.test.ts](../../packages/repa/test/agent-context.test.ts) 和 [pi-context-integration.test.ts](../../packages/repa/test/pi-context-integration.test.ts)：通过 Pi 和本地 faux provider 验证快照判重、运行内背景、来源关闭及压缩后补回。
- [capability-api.test.ts](../../packages/repa/test/capability-api.test.ts)：通过公开客户端验证学习能力的禁用、重新启用和替换，以及会话配置和静态预览。

这些验证在 Linux 上使用临时文件和真实 Pi SDK，覆盖接入、保存和恢复。教学帮助与后续闭环的效果需要真实学习者的后续表现。
