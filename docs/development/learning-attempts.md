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
| `attempt.display` | `spaceId/ref`；从支持恢复的作答返回可打开的 `source`，不建立新实例或作答 | 无，供可信展示宿主使用 |
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

宿主提供的初始化格式是 `repa.learning-response`，版本 `1` 和 `2` 都包含：

- `actor` 固定回答产生者的声明，页面不能从提交值中替换它。
- `materials` 使用 `resourceId`、可选 `selector/source` 指定题面或提示。每个 ID 都须在本次实际 artifact 的资源中，不能借此引用其他空间内容。
- `data` 保留组件自有初始化参数，例如题目与选定提示；底座不为这些参数解释教学含义。

页面提交包含原样的字符串 `response`、`unknown` 或 `reported` 的 `assistance`，以及可选 `data`。后者可以保留页面报告的动作序列，但不会自动转成统一事件分类或实际观察结论。空回答同样保留；这些格式只承担文本作答，不是课程或知识图谱 schema。

处理时，能力先固定完整的服务器 `DisplayResult`，再通过既有 `LearningAttempts.record` 建立作答。原表示作为 `presentation`，HTML 和全部附属字节使用快照 `resources` 长期登记；初始化条件和帮助报告指向原表示中的准确位置。保存资源时先由处理请求持有，成功后再由作答文档长期持有。这个动作不评分、不采用判断，也不启动模型。

公开格式从浏览器安全的 `@repa/learning/schema` 导入。服务器映射由 [exercise.ts](../../packages/learning/src/exercise.ts) 持有，动作绑定、真实来源、受理与关闭则由[展示模块](display.md#交给绑定能力处理)负责。具体组件仍需根据自己的恢复语义解释保存参数，不能从通用展示接口推断整个动态页面状态。

### 恢复原题与先前回答

需要继续作答时，宿主调用 `attempt.display`，再把返回的 `source` 交给 `display.open`。恢复入口读取固定事实与原表示，核对回答、帮助、材料定位和初始化条件；它不按当前题库补造原题，也不读取候选判断来改写题面。当前仅支持完整的文本组件事实映射，包括固定的初始条件说明及准确的表示内来源位置。人工导入可以保留不同的录入来源，但不能替换这些条件；其他事实仍可通过 `attempt.get` 查看。新实例及其动作由当前宿主重新建立，旧实例的身份与授权不会恢复。

交互恢复要求原组件使用 `repa.learning-response/2`。这个版本约定组件消费可选 `previous`：

- `fact` 和 `presentation` 只包含直接前件的资源 hash 与媒体类型，由当前空间解释。
- `submission` 是前件固定表示中的原提交，包含旧回答、旧帮助报告和组件自己的保存参数。
- fresh 初始化可以省略 `previous`；恢复后再次恢复只替换为新的直接前件，不把整份旧初始化参数嵌套进去。

组件据此回填回答并呈现先前帮助，同时区分本次操作。版本声明是宿主与组件的协议承诺，不是后端已经验证任意 HTML 行为的证书。后端保存的是提供给组件的条件；实际组件是否消费这些条件，需要在浏览器中核对。版本 `1` 继续支持保存，但不承诺交互恢复，`attempt.display` 对它返回 `unsupported_format`；宿主仍可通过 `attempt.get` 展示原事实。

恢复使用原 HTML、原材料定位和原 `data`。继续提交时，学习能力还会核对 `previous` 与它引用的事实、表示一致，且完整依据属于当前实例获准资源。当前 `assistance` 只描述本次报告；先前帮助与预填回答作为初始条件继续保留，不能据新报告为空或未知，就把这次提交解释成独立首答。新作答从空的判断集合开始，旧作答及其采用历史保持原貌。

```ts
const { source } = await callLearning(client, "attempt.display", { spaceId, ref });
const instance = await client.call("display.open", {
  spaceId, instanceId: crypto.randomUUID(), source,
  processResult: {
    selection: { contract: { id: "repa.attempt.record-display", version: "1" } },
    inputSchema: { ...ExerciseSubmissionSchema },
  },
});
```

读取恢复参数不会登记新作答；只有新实例实际提交才形成新事实。恢复输出通过原能力请求交付资源，展示实例再建立自己的 hold。前件事实、原表示及明确的依赖进入新 artifact，成功提交后由新作答长期持有。因此，删除前件文档和清理它的历史，不会单独清掉新记录仍需解释的条件。闭包清单会随连续恢复增长，字节按 hash 复用；当前接受这一成本，不另建历史关系数据库。

### 候选判断与采用

`judgment.factId` 指向本记录的固定事实资源。`method` 声明程序、模型或人工方法及具体名称、版本，确实未知的版本为 `null`；可通过 `execution` 保留实际执行证据。方法名称是一项来源声明，不会因为写入名称就证明执行过该程序或模型。

`basis` 固定本次评价所用的参考答案或标准。每条 `conclusions` 都明确 `criterion`，并以 `met`、`not-met` 或 `undetermined` 表达该要求是否成立，再保留 `explanation`。这些值不映射为 FSRS 评级、掌握概率或学习收益。原始输出可另存为 `report`，结构化结论不覆盖它。

`supersedes` 只引用同一记录中已经存在的判断，并说明修正原因。默认保存候选不会改变 `current`。要同时保存并采用，明确传入 `adopt: { reason }`；要稍后选择已有候选，则单独调用 `attempt.judgment.select`。判断调用失败时，已有事实和候选仍然存在，执行失败不会变成“回答错误”的领域结论。

每次采用追加 `from/to/reason` 与真实录入信息，当前选择从最后一条采用记录导出。撤销到 `null`、或再次明确采用同一个候选，也保留新的选择记录。领域入口不删除旧候选，不编辑原事实。

修改使用 `attempt.get` 返回的正文 `base`。同一旧版本上的两个更正竞争时，只有一个能提交；失败的“保存并采用”不会悄悄变成“只保存候选”。候选单独保存也会改变正文版本，因此其他待提交的采用需要重新读取。这是当前单一聚合的并发范围，没有另设隐藏的选择版本或自动重基准。

### 在后续帮助中使用判断

开始一次依赖既有判断的帮助时，先调用 `attempt.get`，再按返回的 `current` 从 `judgments` 中取得所选判断。`current: null` 表示当前没有采用项；候选的保存次序和 `supersedes` 都不替代这份选择。读取结果是当时的快照，另一个入口更正或撤回采用后，需要新的读取才能取得当前状态。

原材料和判断的 `basis` 保留资源 ID 与定位。Agent 可以通过 `read` 的 `repa:resource/<资源 ID>` 读取同一空间中的固定文本／JSON，公共客户端则用 `client.resource` 读取相应资源。当前同名文件或历史来源说明不会替换这些字节；二进制资源的取得也不等于已经完成图像或 PDF 的语义解释。

把作答文档绑定为学习语境时，背景展开的是索引正文，不会自动展开其事实和判断资源。索引更新后，下一次会话 `send` 准备背景时会读取新版本，无需重新绑定；该次 `send` 的内部工具轮沿用入口快照，会话仍保留先前背景和工具读取的历史。`get_learning_attempt` 负责把当前索引解释成事实、全部候选和明确的当前选择，[官方教学方法](../../packages/learning/skills/learn-with-feedback/SKILL.md)据此读取和核对所用依据。采用说明当前选择，不保证参考依据正确，也不把受助回答变成独立表现。

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

文本作答组件已经通过版本化格式直接接入领域记录，并提供版本 `2` 的固定条件恢复入口。其他作答形式、官方组件与学习界面的录入、恢复及更正交互仍待接入。通用展示不会推断缺失的页面行为，宿主和组件按上述边界提供实际条件。

## 验证入口

在仓库根目录执行：

```sh
npm run build:backend
npm run check --workspace=@repa/learning
npm test --workspace=@repa/learning
```

[attempts.test.ts](../../packages/learning/test/attempts.test.ts) 使用真实内容存储检查事实保留、候选与采用、更正冲突、重开、清理和内容副本。[attempt-capabilities.test.ts](../../packages/learning/test/attempt-capabilities.test.ts) 通过真实公开客户端、本地 Pi provider 和空间副本核对接口接入。[exercise.test.ts](../../packages/learning/test/exercise.test.ts) 核对真实展示来源、固定初始化条件、原提交与附属资源、失败边界和旧快照兼容。底层业务原意去重与恢复由 [content-derived-patch.test.ts](../../packages/repa/test/content-derived-patch.test.ts) 覆盖。

[learning-judgment-consumption.test.ts](../../packages/repa/test/learning-judgment-consumption.test.ts) 从官方产品的真实 Skill 目录读取教学方法，经过学习背景、领域工具和 `repa:resource` 读取固定依据。它覆盖未采用更正候选、明确采用后仍有更新候选、撤回、新会话和后端重开；原事实与帮助保持不变，关闭独立复习后这条读取链仍可用。

这些验证检查领域保存和接续语义；本地 provider 只驱动确定的调用，不用于评价模型判断能力或真实学习收益。

[exercise-restore.test.ts](../../packages/learning/test/exercise-restore.test.ts) 通过真实公开接口检查只读恢复、直接前件、继续提交、版本与一致性拒绝、资源回收及副本解释。通用展示的结果重开仍按原规则使用 `input`，学习恢复入口不改变这项行为。
