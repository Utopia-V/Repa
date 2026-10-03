# 复习记录与 FSRS 调度

`@repa/review` 是独立后端能力包。它保存复习项、实际反馈、更正与参数版本，使用 `ts-fsrs@5.4.2` 计算当前记忆状态及下次到期时间。Agent 工具和公共客户端调用同一处理函数，业务数据留在所属空间的 SQLite 数据库中。核心只协调调用、来源、通知和空间生命周期。

## 设计思路

当你做完一次复习并提交反馈，插件就会根据这次表现计算下次安排，并一起保存。创建复习项只保存题目等内容，等你实际作答或评价后再记录反馈；题目、实际反馈和未来安排由此分开。Agent 与界面使用同一套操作。

如果你更正之前的评分，或换用新参数，当前估计也会随之变化。插件保留原反馈、追加更正和参数版本，再用有效记录重算当前状态，返回这次重算涉及的范围。这样，你既能查看当时发生的事，也能按新的依据调整后续安排。

调度复用成熟的 FSRS 实现，Repa 不重写遗忘曲线。插件负责把记录、参数和算法结果放在同一 SQLite 事务中保存，并提供查询和修改接口。数据库表、迁移与算法都留在复习包里，基座只提供调用、空间数据位置和生命周期管理。

## 包入口与启用

[包清单](../../packages/review/package.json)声明 `repa.backend` 和独立的 `repa.snapshot`。官方默认以 `repa-review` 装配；另外安装的用户／项目版本仍须按[插件装配](plugins.md)明确授信与启用，不因同名取得官方身份。`@repa/review/protocol` 只导出浏览器可用的 schema 与类型；`@repa/review` 是后端工厂入口。

未启用时不导入算法或创建数据库。启用后可以查询能力声明，第一次实际空间调用才打开 `.repa/plugins/<pluginId>/reviews.sqlite`。数据目录由宿主提供；安装标识决定目录，不要求将插件命名为 `review`。禁用停止相应调用并关闭数据库，数据继续保留。

复习包已经加入官方默认组合。新用户使用库的默认参数即可开始，无需先积累历史或训练参数。界面与实际学习试用的进度见下文未完成项。

## 实际反馈、当前估计与人工安排

| 数据 | 含义与保存方式 |
| --- | --- |
| `ReviewItem` | 提示、可选答案和本空间内容引用；`revision` 是复习项的修改基准，`card` 是可重算的 FSRS 状态 |
| `FeedbackEvent` | 实际发生的复习，保存评分、可选作答、发生与录入时间、来源、当时参数版本及计算结果 |
| `CorrectionEvent` | 指向原反馈的追加更正，说明替换评分／时间或撤销该反馈的原因；原反馈继续保留 |
| `ParameterVersion` | 完整参数、库版本、算法版本与创建时间；新版本不覆盖旧版本 |
| `manualDueAt` | 明确调整的未来安排；有值时作为 `dueAt`，否则采用 `card.due` |

评分沿用 FSRS 的 `1` 再来、`2` 困难、`3` 良好、`4` 容易。反馈必须来自实际作答或明确评价，工具说明不把 Agent 生成答案当成用户完成复习。暂停只影响待复习筛选；人工安排不增加复习次数。下一次真实反馈清除人工安排，采用新计算的推荐时间。

更正按录入顺序解释，最后一次生效；`replace` 可以恢复此前被 `void` 的反馈。有效反馈按发生时间和原事件顺序排列，再交给 ts-fsrs 的 `reschedule` 重算当前估计。回填较早的复习使用同一过程，新事件保存当次计算结果，原有事件的结果保留。

通常只是按时间顺序追加一次反馈，此时直接调用 ts-fsrs 的 `next` 即可，不需要每次读取完整历史。更正或回填时才重算相应记录。算法为重排产生的辅助日志，不计作用户实际发生的复习。

修改参数在同一事务中创建新版本、重算所有项目并提高项目修订，返回 `recomputedItems`；更正及回填返回 `recomputedReviews`。旧反馈、旧参数和手动安排继续保留。重算后客户端重新查询，不能拿重算前的项目修订提交评分。

### 时间与来源

所有时间戳都是 Unix 毫秒。`reviewedAt` 表示实际复习时间，省略时使用服务端录入时间；`recordedAt` 由数据服务生成。日间隔遵循锁定 `ts-fsrs` 的 UTC 日历日差，短期学习步骤沿用库的分钟计算；改变机器时区不重新解释已保存时间。前端可按用户时区显示日期，不把本地午夜换算成另一套调度规则。

`recordedBy` 来自真实公共连接或 Agent 运行，不由工具输入指定。本空间内容引用保存 `contentId`、可选的所见 `revision` 和 `locator`；空间归属来自能力 `scope`。原件后来不可用不删除反馈，保存修订标识也不自动保存原件历史字节。需要长期原件时通过共同内容与资源入口明确保留。

## 公共操作

契约前缀为 `repa.review.`，版本为 `1`。输入与结果的权威定义位于 [schema.ts](../../packages/review/src/schema.ts)，算法字段位于 [fsrs-schema.ts](../../packages/review/src/fsrs-schema.ts)。所有能力都是空间作用域，工具名为 `review_` 加下表名称，并将点替换为下划线。

| 名称 | 行为与结果 |
| --- | --- |
| `create` | 创建项目，返回 `{ item }` |
| `get` | 按 `itemId` 读取当前项目 |
| `list` | 按 `dueAt/id` 排序和分页；默认排除暂停项，`dueBefore` 限定到期时间 |
| `feedback` | 原子保存实际反馈与新状态，返回 `{ item, event }` 及必要的重算范围 |
| `correct` | 追加更正并重算当前状态 |
| `status` | 暂停或恢复项目，不计作反馈 |
| `schedule` | 设置人工到期时间；`dueAt: null` 恢复算法推荐 |
| `history` | 按项目事件 `sequence` 分页读取原反馈与更正 |
| `parameters.get` | 查询当前参数或指定 `version` |
| `parameters.set` | 按参数版本提交 `patch`，原子更新并返回重算项目数 |
| `parameters.optimize` | 后台训练候选权重，返回数据范围与结果，不自动应用 |

列表、项目、历史和参数读取声明为 `query`，每次返回当前数据，不为页面刷新保存处理记录。业务修改使用持久 inline 调用，优化使用后台请求；同一持久 `requestId` 的传输重试不会重新执行。业务修改另有 `operationId`：新的修改生成新标识，重复发送原修改保留原标识和载荷。修改既有项目携带 `base: item.revision`；参数修改携带 `base: parameterVersion.version`。

操作回执、事件与状态在同一 SQLite 事务中提交。同一 `operationId` 和载荷返回原结果，即使项目后来已变化；重用标识但改变操作或载荷返回 `review_operation_conflict`。不同操作基于同一旧修订竞争，先提交者生效，其他返回 `review_conflict`，由调用方读取当前状态后重新判断。业务回执使重新建立公共请求的同一答复仍可判重，没有创建第二套后台任务系统。

模型修改工具通过[参数映射](capabilities.md#公开调用与-agent-工具)隐去 `operationId`，由执行适配生成；`base` 等业务判断所需字段继续交给模型。公共客户端仍保留明确操作标识以处理传输与业务重传。两个入口共用原处理函数和事务，不再让模型生成程序回执标识。

公共调用示例使用已连接的 `RepaClient` 和已打开的 `spaceId`：

```ts
import { Check } from "typebox/value";
import { ReviewMutationResultSchema } from "@repa/review/protocol";

const request = {
  scope: { kind: "space" as const, spaceId },
  requestId: crypto.randomUUID(),
  contract: { id: "repa.review.create", version: "1" },
  input: { operationId: crypto.randomUUID(), prompt: "潮汐与潮流有什么区别？" },
};
const result = await client.call("capability.invoke", request);
if (result.kind === "inline" && Check(ReviewMutationResultSchema, result.result)) {
  const { id, revision } = result.result.item;
  // 后续反馈携带 itemId: id、base: revision 和新的 operationId。
}
```

### 订阅与重连

修改成功后，插件通过窄服务发布 `repa.review.invalidated/1`，数据为 `{}`。核心将真实 `pluginId/scope/source/requestId` 绑定到 `type: "capability"` 的公共变化中。相同空间的空间订阅、会话订阅和全局订阅都能收到，其他空间收不到。

这是重新查询的通知，不是复习事实或当前状态的第二份存储。操作回执重放可以再次通知，客户端重复刷新即可；刷新时调用 `list/get/history/parameters.get`。首次订阅和重连取得新快照后也要查询一次插件状态，不依赖通用 `Snapshot` 包含复习数据库。共同机制见[能力通知](capabilities.md#插件状态通知)。

## 可选参数优化

优化使用可选依赖 `@open-spaced-repetition/binding@0.5.0`。插件在训练开始时取得当前参数和有效反馈的同一数据库快照，只提交项目标识、评分和时间，不发送提示、答案、原材料或来源正文。暂停项的既有真实反馈仍可参与训练。

训练在独立 OS 子进程中运行，原生依赖在子进程内加载。普通调度只依赖 `ts-fsrs`；缺少优化器时，优化请求明确失败，其余复习功能继续可用。独立进程使原生计算的退出、取消与应用关闭归属于现有父请求，不让后台训练占住主服务或逃过取消。公共请求复用 `request.get/cancel`，Agent 工具沿用父运行。

训练结果记录参数基准、库／算法／优化器版本、UTC 日界、实际反馈时间范围、样本数和训练配置。`feedbackCount` 是有效实际反馈数，`trainingItems` 是官方转换器产生的跨日候选样本数，不是上游清洗后的训练量。少于 8 个候选样本时返回 `insufficient_data`，依据是锁定的 [fsrs-rs 6.5.0 下限](https://github.com/open-spaced-repetition/fsrs-rs/blob/v6.5.0/src/training.rs#L319-L335)。上游还会清洗样本；小数据可能只估计初始稳定度，或直接返回默认权重。

`ready` 表示得到适用于当前调度器的候选，`matchesDefaultWeights` 明确标出返回权重是否仍与默认值一致。调用方据此判断是否采用，而不是把数据不足后的默认回退当成个人参数改善。采用时提交 `parameters.set`，使用结果的 `parameterVersion` 作为基准，将 `w` 作为参数补丁；训练期间参数已有更新则返回版本冲突，候选不会悄悄覆盖新设置。

当前训练配置为 5 个 epoch、batch size 512、seed 2023、max sequence length 256、learning rate 0.04、gamma 1，随结果返回；短期学习开关和再学习步骤数量来自同一参数快照。硬截止时间默认 60 秒，可选 1—300 秒，由父进程执行。上游 binding 的 `timeout` 实为进度轮询的毫秒间隔，当前固定 100 毫秒，不用它承担截止时间。

## 持久数据与快照

SQLite `user_version = 1`，启用 WAL、外键和 `synchronous = FULL`。`items` 保存当前状态及到期索引，`events` 保存项目内追加序列，`parameter_versions` 保存完整参数，`operation_receipts` 保存业务判重结果。普通反馈不重扫历史；更正、回填、参数重算与训练快照才读取其所需事实。

持久格式在读写时检查，固定 schema 使用 TypeBox 编译后的检查函数。批量重算会读取大量记录，复用检查函数可以省去逐条重新解释 schema 的工作。当前重算在一个事务中完成，数据规模增大后的时延需要按实际记录量测量。

独立快照入口只加载 `node:sqlite`，以 `VACUUM INTO` 取得一致副本。插件禁用并重启后仍能参与空间备份和独立复制，不打开业务工厂。项目引用使用空间内内容身份，副本直接沿用；历史 `recordedBy` 保留原录入来源，而不是把既有事实改称由副本产生。数据版本不兼容时明确报告，不把数据库作为普通文件盲拷。

## 未完成项与待验证项

| 项目 | 当前状态与影响 | 后续工作 |
| --- | --- | --- |
| 复习界面与实际使用 | 后端创建、反馈、历史和调度可用，官方界面尚未接入 | 由 [#10](https://github.com/Utopia-V/repa/issues/10) 联调，实际学习流程由 [#25](https://github.com/Utopia-V/repa/issues/25) 验证 |
| 可选的替代算法 | 当前提供 FSRS，参数变更可以重算，尚未提供多算法切换入口 | 采用替代算法时，按 [#24](https://github.com/Utopia-V/repa/issues/24) 保留实际记录，明确数据接续和重算范围；多算法入口不作为当前 FSRS 后端的验收前提 |
| 主动提醒与定时执行 | 当前提供到期查询，未注册主动提醒或定时任务 | 需要主动提醒时，按 #24 约定接入单独启用的后台能力 |
| 原生优化器的发行支持 | 已有 Linux x64 验证，其他发行环境的原生依赖尚待核对 | 随 [#26](https://github.com/Utopia-V/repa/issues/26) 的实际发行目标验证；缺少优化器时普通复习可用 |

## 验证入口

在仓库根目录使用受支持 Node 运行：

```sh
npm run build:backend
npm run check --workspace=@repa/review
npm test --workspace=@repa/review
```

[算法测试](../../packages/review/test/fsrs.test.ts)使用真实 `ts-fsrs` 与固定时间；[存储测试](../../packages/review/test/store.test.ts)使用真实 SQLite，验证重传、竞争基准、回填、更正、参数版本、事务回滚、分页、暂停、人工安排与训练快照。[API 测试](../../packages/review/test/api.test.ts)通过编译包和公开客户端验证实际插件安装元信息、按需数据库、来源、通知、Pi 工具调用、关闭重开以及禁用后的空间复制。Agent 回归使用真实 Pi SDK 与本地确定性 provider，学习体验另由整体联调验证。

[优化测试](../../packages/review/test/optimizer.test.ts)在 Linux x64 使用真实 native binding 与子进程，覆盖可调度权重、上游默认回退、UTC 午夜、数据不足，以及计算进度到达后的实际取消退出。公开客户端也走通持久反馈生成候选、关闭重开、读取原后台结果、幂等重传和显式采用参数。上述验证使用已安装的可选组件；没有安装时，原生优化用例跳过，另验证明确不可用与普通调度继续运行。

发行包另在临时隔离目录中解包，仅提供声明的宿主、TypeBox 和 `ts-fsrs` 运行依赖。未安装 binding 时，实际编译包的创建与反馈仍可使用，优化返回 `optimizer_unavailable`，此前状态保持不变。该检查覆盖包内子进程文件与可选依赖边界。
