# 学习记录与恢复

学习插件把交付、原答和采用的判分保存在空间的 `.repa/plugins/learning/records.jsonl` 中。重新打开空间时，它从日志恢复当前任务和学生状态；查询不会启动判分。当前已提供持久入口、课程来源加载和直接复习模型接入，[教学流程](learning-flow.md)在同一入口上完成上课、复习与申诉。

## 设计思路

提交时断开连接，并不能说明答案是否收下。因此，我们先保存接受记录，再调用判分服务。接受、身份去重和状态校验经过同一条串行入口；等待判分时释放入口，界面仍能查询，其他提交也能被接受。同一个 submission id 的同载荷重交返回已有状态，换载荷则报冲突。

判分返回后，还需要保存结果才能推进任务。`grade` 将采用的结构化判分、来源、规则版本和转换后的任务、学生投影合成一条记录，写入并同步成功后才更新内存。因此，结果已落盘的提交可以直接恢复，原答已落盘但结果尚未落盘的提交则需要显式继续。任务转换函数由教学层提供，重放只取回保存的结果，不调用这个函数，也不重发奖励。

课程以后可能修改，进行中的题目却必须保持原样。因此，交付先保存包含私有定义的快照，再保存引用它的公开交付。快照摘要复用底座的 `contentVersion`，相同内容只保存一次。已交付的题序、题面和快照引用不能被后续任务保存替换。空间历史只维护课程覆盖文件，学习日志独立保存，所以撤回文件改动不会撤回原答。

## 实现细节

### 插件与教学接入

包根目录的 `repa-plugin.json` 声明 `learning`、代码及底座兼容版本和构建入口 `dist/plugin.js`，可以交给底座现有的插件加载器。`createLearningPlugin({ sources, connect })` 默认读取随包的 Python 课程，打开时一次加载全部 48 个 topic。底座传入的 `host.space.dataDir` 已是本插件的数据目录。

插件自行在其中管理 `format.json`（当前为 `{ "version": 1 }`）。目录为空时写入版本 1 的标记；非空目录缺少标记时，按无法识别的数据停用学习插件，提示删除 `.repa/plugins/learning/` 后重新打开空间。开发阶段的旧数据直接丢弃，不补标记。旧底座留下的 `plugin-versions/learning.json` 不再读取或更新。版本检查复用[底座辅助函数](../../packages/base/README.md#构建清单与数据版本)，标记损坏、版本过新或记录损坏时只停用学习插件。

日志信封读取时忽略不认识的可选字段，写入仍严格校验；快照内容参与摘要和身份核对，新增会改变这部分语义的字段需要按数据格式变更处理。

`connect(records, course, host)` 在日志恢复后装配教学处理器，可以调用已有的模型、前端服务和事件入口，并返回 `methods` 与可选的 `close`。返回的方法覆盖本层的同名方法。默认接入教学流程，提供初始菜单、任务推进、正式判分、恢复和申诉。自定义 `connect` 仍可以替换这份装配；查询方法继续由记录入口提供。日目标、XP 与 ETA 见[测验与进度说明](learning-quiz-xp.md)，时区取后端本地时区。

| 持久入口 | 行为 |
| --- | --- |
| `LearningRecords.open(file)` | 严格重放完整记录；尚未完成的提交投影为 `interrupted/restart`，判分阶段投影为 `recovery` |
| `saveSnapshot(snapshot)` | 验证身份与内容版本，按摘要去重，同步保存后返回摘要 |
| `checkpoint(expectedRevision, build)` | 串行检查版本，把当前投影和服务端 now 传给纯转换函数，保存任务、菜单与决策来源 |
| `submit(input)` | 结构检查、交付身份与截止检查、同 id 去重、同步保存唯一原答；返回契约中的 receipt |
| `grade(id, judge, advance)` | 合并同一提交的在途处理；在队列外判分，再在队列内把结果与纯转换后的投影一起保存 |
| `appeal(input)` | 串行登记目标判分版本与原因；同一目标在途申诉合并，已变化的版本拒绝 |
| `viewed(input)` | 直接记录，或在串行回调内检查当前投影后记录展示讲解、打开卡片、取回 KP 及事前／事后帮助，保留版本引用和原任务位置 |
| `current()`、`submission(id)`、`snapshot(digest)`、`records` | 返回可独立使用的副本；`records` 保留原始记录，不把恢复显示覆盖回原始证据 |
| `close()` | 等待在途判分和排队保存完成 |

教学层先用现有 `publicItem` 白名单投影并换号，再调用 `createSnapshot` 补齐 topic、KP 与题目版本。快照保存完整课程清单、所属 topic（含私有题目定义和数据）、图、运行时、最终公开 Item 和不透明 id 对照。`Projection.deliveries` 按 delivery id 指向快照摘要；公开 `LearningState` 中不含这份对照或私有定义。反馈何时释放，由教学层构造的公开投影决定：`advance` 可以暂时不带公开反馈，后续 `checkpoint` 再释放同一份已采用判分。私有采用判分始终留在 `graded` 记录中。

### 日志与时间

每一行都有 `v: 1`、连续的 `seq` 和服务端毫秒时间 `at`。空间内的公开 revision 跟随日志序号。各记录的 schema 位于 `records-schema.ts`：

| type | 保存内容 |
| --- | --- |
| `snapshot` | 内容摘要和交付快照 |
| `checkpoint` | 公开状态、学生投影、交付引用，以及候选顺序、选择、策略版本、决策 now、seed 和小型分数 |
| `accepted` | 唯一原答、接受时间、开始与提交时间及偏移、事前帮助引用、事前 HSRS 状态、计算 now 与配置版本／值 |
| `graded` | 原 submission id、采用的判分与规则版本、可追溯的来源，以及推进后的完整投影 |
| `appeal` | 原 submission id、目标 gradeRevision 和原因；重启后可显式恢复 |
| `regraded` | 同一原答的新采用判分、完整 submission 与重算后的当前投影；历史任务和旧结果保留 |
| `viewed` | task、可选 delivery、行为与版本化内容引用；后续帮助沿这些记录关联原答 |

生产入口使用服务端 `Date.now`；纯计算与转换函数显式接收 now，决策还保存显式 seed。开始时刻取交付首次写入的时间，提交时刻取接受时的服务端时间。接受记录中的事前状态是模型原始锚点状态，与计算 now 一起保留，之后可以重算当时的 memory。事后帮助以发生时追加的查看记录为准。

保存先在候选内存投影中验证，再追加 JSONL、同步文件和目录，最后发布内存投影。任一步写入失败都使请求失败，并停止当前实例继续追加；重新打开后以实际日志为准。底座持有空间锁，持久入口只在该宿主生命周期内使用，不额外建立第二套锁或运行时。

### 课程来源与模型

`loadCourseSources` 接收有序来源列表：先列唯一的 `{ kind: "bundled", directory }`，再列 `{ kind: "overlay", file }`。覆盖文件通过 `host.files` 读取，使用 JSON 形状 `{ courseId, basedOn, topic }`；`basedOn` 必须等于上游课程版本，`topic` 按当前 schema 完整替换同 id topic。使用 `host.files.write` 保存覆盖文件就会进入空间历史。来源重复、未知 topic 或版本不符都会报错，读取随包课程不会修改其文件。

`@repa/learning-model` 的来源是 `learning-model-research` 分支完成盲图与难度评估时的研究版本。本次迁入运行库、三份直接回归、它们依赖的合成比较夹具和构建配置，实验运行入口仍留在研究分支。库的默认数值与更新次序保持不变：旧 memory 先加信用，再整体按旧 interval 衰减；未公开的数值和时间协议属于 Repa 假设。

插件通过 `updateStudent` 和 `chooseTasks` 接入库，两者都把 encompassing 图置空，所以正负隐式传播均关闭，直接复习保留。时间按 Unix 毫秒除以 86,400,000 转为连续天数，更新拒绝早于已有锚点的时间。`memory` 是调度量，不是答对概率；更新粒度、独立作答资格和正式菜单由 c2 持有。

### 残缺尾部恢复

打开日志时只读取以换行结束的完整记录。末尾存在无换行片段时，完整前缀仍可查询，但继续追加会报 `learning_log_blocked`。完整行的 JSON、schema、序号、快照或业务引用损坏都会停止重放，恢复命令也不会越过坏行。

先关闭空间，再在仓库根目录运行：

```sh
npm exec --workspace=@repa/learning -- repa-course recover-log /absolute/space /absolute/recovered.jsonl
```

命令通过现有空间锁确认空间已关闭，验证完整前缀，再独占创建目标文件，按原始字节写出前缀并同步。原日志保持原样，目标文件已存在也会拒绝。核对新文件后，在空间保持关闭时，将原日志改名保留，再把新文件移到 `.repa/plugins/learning/records.jsonl`，即可正常打开并显式恢复待判提交。中部或完整行损坏需要维护者调查，不自动截断。

## 未完成项与待验证项

- 教学转换、菜单、独立资格、判分与申诉见[教学流程](learning-flow.md)；[辅导与查看行为](learning-tutor.md)共用串行入口，测验与 XP 任务复用同一结果提交边界。
- e 的前端契约仍待 Aqua 审定。本次沿当前 schema 实现，没有发现需要修改公开字段的阻断；后续小改动需同步本层的投影 schema 与读取方法。
- 日目标设置、XP 差额与日汇总已接入；当前时区取后端本地时区。申诉已经通过新增记录保留旧判分、原答和历史任务。磁盘满、同步失败等专项注入按共同约定留待实际存储风险出现时补充。

## 验证入口

在仓库根目录运行：

```sh
npm run check --workspace=@repa/learning-model
npm test --workspace=@repa/learning-model
npm run build --workspace=@repa/learning-model
npm run check --workspace=@repa/learning
(cd packages/learning && node --import tsx --test --test-concurrency=1 test/*.test.ts)
npm run build --workspace=@repa/learning
```

[`learning-records.test.ts`](../../packages/learning/test/learning-records.test.ts) 使用真实临时文件、保留目录的真实空间宿主和三个子进程，分别在接受后、判分返回但结果未保存、结果保存后 SIGKILL，再重开核对原答、显式恢复、判分调用次数与推进次数。另覆盖同 id 去重、写入失败、残缺尾部 CLI 恢复、完整坏行、来源版本冲突、历史撤回与关闭重开。测试全部无头运行，模型边界只使用本地替身。

2026-10-20 在 Ubuntu 24.04、Node.js 22.22.2、npm 12.0.2 下验证：学习包 97 项测试、模型包 28 项测试全部通过，无跳过；两个包的 check、build 和公开协议浏览器构建通过。记录专项包含 13 项测试。构建后的插件清单已通过真实加载器和空间宿主验证；模型库产物暂时移出时，课程 CLI 的 48 个 topic、962 道题结构检查仍通过。
