# 学习作答与可更正判断

`@repa/learning` 保存一次作答的原始事实、针对它的候选判断，以及明确采用哪份判断的历史。客户端和 Agent 使用同一份领域实现；学生状态、知识传播与任务选择仍由后续学习算法承担。

## 设计思路

参考题解改正后，你可能需要重新评价同一次回答。如果直接覆盖原评分，就很难再解释学生当时回答了什么、看过哪份帮助，以及评价为什么改变。因此，作答原件与判断分开保存；产生新判断也不自动替换当前正在使用的判断。

一次作答使用一份内容文档组织这些关系。原事实和每份判断保存为不可变资源，文档只维护资源位置、候选列表与采用历史。这样，更正只需更新一个小的关系集合，内容模块已有的版本检查、资源登记和恢复就能共同承担保存。候选数量增加时，这份文档也会增长；当前按作答分别组织，尚不建立跨作答索引或批量评分队列。

这里的“采用”表示后续消费者明确选择了哪份评价，并不等于学习者已经掌握。比如，“回答与指定参考式等价”只评价这一命题；参考式本身可能有错，也不一定检验了题目要求的推导步骤。具体问题及接入依据见[学习内容与作答证据](../research/learning-evidence.md)。

## 实现细节

### 公共入口与模型工具

客户端使用 `@repa/learning/client` 的 `callLearning`。方法通过通用 `capability.invoke` 调用对应的 `repa.*` 能力，版本为 `1`，官方实现标识为 `official`。

| 方法 | 输入与结果 | Agent 工具 |
| --- | --- | --- |
| `attempt.record` | `spaceId/operationId/fact`；建立作答记录并返回 `ContentChangeResult` | `record_learning_attempt` |
| `attempt.get` | `spaceId/ref`；返回原事实、`factId`、候选、采用历史、`current`、正文 `base` 及资源 | `get_learning_attempt` |
| `attempt.judgment.save` | `spaceId/operationId/ref/base/judgment`，可选 `adopt`；默认仅保存候选 | `save_learning_judgment` |
| `attempt.judgment.select` | `spaceId/operationId/ref/base/judgmentId/reason`；采用已有候选，`judgmentId: null` 撤销当前采用 | `select_learning_judgment` |

工具适配器生成操作标识，并把 `contentId` 补成当前空间的内容引用。模型从实际工具文本取得 `factId`、正文 `base` 和候选 ID；保存失败的文本提供操作标识，可通过 `content_operation` 核对实际状态。公共客户端保留完整输入和 `operationId`，断线重传时沿用它们。

这些能力使用 `inline` 调用。读取也会交付固定资源，因此声明输出资源，由请求或会话接手相应历史持有。成功保存后，文档自己的资源登记承担长期保存，删除原会话或清理操作历史不会单独清掉仍被文档引用的证据。

### 原始事实与来源

`fact` 保存以下信息：

| 字段 | 含义 |
| --- | --- |
| `actor` | 回答产生者的声明：`learner`、`assistant`、`synthetic` 或 `unknown`，可有原样标签 |
| `response` | 原文本，或指向原回答字节的资源；空文本同样可以记录 |
| `materials` | 至少一份固定题面或材料快照；`selector` 区分该版本中的对象，`source` 保存历史来源说明 |
| `presentation` | 可选的原呈现记录，例如固定的 `DisplayResult` |
| `initialConditions/assistance` | 明确的 `unknown`，或保留原文与证据来源的 `reported` |
| `occurredAt/provenance` | 可选的发生时间报告与来源说明；不是服务端独立观察的证明 |

服务端另外保存真实调用的 `recordedBy` 和录入时刻 `recordedAt`。它们不在公共事实输入中，回答产生者也不由录入渠道推断。Agent 可以录入学习者在对话中的回答，合成设施同样可以通过真实客户端录入标记为 `synthetic` 的样本。

没有帮助记录时使用 `unknown`；明确报告“未使用帮助”时，使用 `reported` 保留这项陈述。两者不能互换。保存页面上报的提示事件，也只确认该入口提交了这些数据；后端不会把它改称独立观察到的实际显示。

资源通过明确字段登记，不递归扫描任意 JSON。每份快照可以用可选 `resources` 声明附属字节，例如在 `presentation` 中同时登记原 `DisplayResult`、HTML 与页面资源。旧记录省略该字段时保持原样。题面与提示继续按其实际角色列入材料快照或报告来源。只保存一个以后可能失效的请求 ID，不足以保留原依据。

### 文本作答组件的展示接入

官方学习包提供 `repa.attempt.record-display/1` 处理能力。可信宿主在 `display.open.processResult` 中绑定它，并使用 `ExerciseSubmissionSchema` 约束页面提交。该能力没有 Agent 工具入口；它检查真实 `InvocationContext.source` 为 display，并与服务器构造结果的来源一致，普通客户端不能靠提交带有 display 标签的 JSON 冒充展示调用。

宿主提供的初始化格式是 `repa.learning-response/1`：

- `actor` 固定回答产生者的声明，页面不能从提交值中替换它。
- `materials` 使用 `resourceId`、可选 `selector/source` 指定题面或提示。每个 ID 都须在本次实际 artifact 的资源中，不能借此引用其他空间内容。
- `data` 保留组件自有初始化参数，例如题目与选定提示；底座不为这些参数解释教学含义。

页面提交包含原样的字符串 `response`、`unknown` 或 `reported` 的 `assistance`，以及可选 `data`。后者可以保留页面报告的动作序列，但不会自动转成统一事件分类或实际观察结论。空回答同样保留；这些格式只承担文本作答，不是课程或知识图谱 schema。

处理时，能力先固定完整的服务器 `DisplayResult`，再通过既有 `LearningAttempts.record` 建立作答。原表示作为 `presentation`，HTML 和全部附属字节使用快照 `resources` 长期登记；初始化条件和帮助报告指向原表示中的准确位置。保存资源时先由处理请求持有，成功后再由作答文档长期持有。这个动作不评分、不采用判断，也不启动模型。

公开格式从浏览器安全的 `@repa/learning/schema` 导入。服务器映射由 [exercise.ts](../../packages/learning/src/exercise.ts) 持有，动作绑定、真实来源、受理与关闭则由[展示模块](display.md#交给绑定能力处理)负责。具体组件仍需根据自己的恢复语义解释保存参数，不能从通用展示接口推断整个动态页面状态。

### 候选判断与采用

`judgment.factId` 指向本记录的固定事实资源。`method` 声明程序、模型或人工方法及具体名称、版本，确实未知的版本为 `null`；可通过 `execution` 保留实际执行证据。方法名称是一项来源声明，不会因为写入名称就证明执行过该程序或模型。

`basis` 固定本次评价所用的参考答案或标准。每条 `conclusions` 都明确 `criterion`，并以 `met`、`not-met` 或 `undetermined` 表达该要求是否成立，再保留 `explanation`。这些值不映射为 FSRS 评级、掌握概率或学习收益。原始输出可另存为 `report`，结构化结论不覆盖它。

`supersedes` 只引用同一记录中已经存在的判断，并说明修正原因。默认保存候选不会改变 `current`。要同时保存并采用，明确传入 `adopt: { reason }`；要稍后选择已有候选，则单独调用 `attempt.judgment.select`。判断调用失败时，已有事实和候选仍然存在，执行失败不会变成“回答错误”的领域结论。

每次采用追加 `from/to/reason` 与真实录入信息，当前选择从最后一条采用记录导出。撤销到 `null`、或再次明确采用同一个候选，也保留新的选择记录。领域入口不删除旧候选，不编辑原事实。

修改使用 `attempt.get` 返回的正文 `base`。同一旧版本上的两个更正竞争时，只有一个能提交；失败的“保存并采用”不会悄悄变成“只保存候选”。候选单独保存也会改变正文版本，因此其他待提交的采用需要重新读取。这是当前单一聚合的并发范围，没有另设隐藏的选择版本或自动重基准。

### 持久格式与副本

新记录位于 `learning/attempts/<确定性内容标识>.json`，身份由共同内容模块登记。文件位置不是业务身份，移动后仍通过 `ContentRef` 访问。

- 文档格式为 `repa.learning-attempt`，版本为 `1`，持有事实资源、候选列表和采用历史。
- 原事实资源格式为 `repa.learning-attempt-fact`，判断资源格式为 `repa.learning-judgment`，版本均为 `1`。
- 持久资源位置只包含 hash 与媒体类型，读取时按当前记录所属空间构成 `ResourceRef`。
- 候选 ID 和替代关系局部于这份记录，原始 `recordedBy` 与来源说明保留历史含义。

因此，`space.copy` 可以保留原事实和判断字节，资源归属切换到副本；`content.copy` 为记录文档建立新身份，而内部候选 ID 不必换号。副本描述的是同一次历史作答的另一份工作副本，不是学生又作答了一次；后续采用和更正独立保存，不修改原件。复制后新操作使用新 `operationId`。

读取时校验索引、固定事实、候选的事实归属、替代次序、采用链和完整资源登记。格式损坏、缺失证据或失配关系明确失败，不自动修补成另一段历史。通用内容工具仍可编辑文档，因此这里提供领域入口内的不覆盖与读取校验，不是防篡改存储。

当前读取和更新准备都会核验所引用资源的字节。读取既有记录时，每个 hash 只核验一次，材料 Buffer 用后释放；保存新增输入时另行核验其资源。I/O 仍随本记录的证据总量增长；小的索引不意味着整项读取成本固定，较大记录的读取与保存延迟需要随实际使用核对。

### 去重与恢复

领域方法基于当前记录生成文件补丁，但业务重传不能每次重新生成时间和正文，再把它们当作同一输入。`ContentStore.applyDerivedPatch` 因而先按完整业务原意查询已有 journal 回执，只有首次执行才在原内容队列中准备本地补丁。录入时间与来源留在首次形成的资源中；重传成功操作直接返回旧回执。

准备回调使用专用只读范围，返回补丁及需要保存的资源字节。核心在同一队列内写入资源、检查正文及结构版本，再沿既有 journal 提交。资源回收无法插入资源写入和长期登记之间。原始模型调用、网络请求或大规模转换应在进入这一短准备之前完成。

公共请求的 `requestId` 仍负责传输层受理；业务 `operationId` 负责内容提交的去重。内容已经提交而请求结果尚未落盘时，即使旧请求在重启后显示中断，也可用新请求、原业务标识和相同输入核对原提交。操作历史已清理时，已有墓碑返回 `history_pruned`，不会重新执行旧业务修改。

## 未完成项与待验证项

本模块保存、解释和更正作答证据。学生状态、知识关系传播、后续任务选择以及它们对学习效果的影响仍由 [#38](https://github.com/Utopia-V/repa/issues/38) 接续；现有 FSRS 原型不会自动消费这里的判断。

文本作答组件已经通过版本化格式直接接入领域记录；其他作答形式、具体组件的恢复行为，以及官方学习界面的录入与更正交互仍待接入。通用展示不会推断缺失的页面行为，宿主和组件按上述边界提供实际条件。

## 验证入口

在仓库根目录执行：

```sh
npm run build:backend
npm run check --workspace=@repa/learning
npm test --workspace=@repa/learning
```

[attempts.test.ts](../../packages/learning/test/attempts.test.ts) 使用真实内容存储检查事实保留、候选与采用、更正冲突、重开、清理和内容副本。[attempt-capabilities.test.ts](../../packages/learning/test/attempt-capabilities.test.ts) 通过真实公开客户端、本地 Pi provider 和空间副本核对接口接入。[exercise.test.ts](../../packages/learning/test/exercise.test.ts) 核对真实展示来源、固定初始化条件、原提交与附属资源、失败边界和旧快照兼容。底层业务原意去重与恢复由 [content-derived-patch.test.ts](../../packages/repa/test/content-derived-patch.test.ts) 覆盖。

这些验证检查领域保存和接续语义；本地 provider 只驱动确定的调用，不用于评价模型判断能力或真实学习收益。
