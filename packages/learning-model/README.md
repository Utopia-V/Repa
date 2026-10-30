# 学生模型与任务选择器

## 概述

`@repa/learning-model` 提供 HSRS 学生状态更新与任务候选选择，是不读写文件、不读取时钟的 TypeScript 纯计算库。

## 怎么用

作答是否能成为一次学习或复习证据，由学习插件判断；计算库只把已经确认的结果更新为学生状态，再依据显式传入的图、时间和配置选择候选。计算只取决于这些输入，所以学习插件只记作答事实，学生状态在重放时由这里的函数重新算出；换一组配置重放同一份事实，就得到那组参数下的状态。

学习插件通过 `updateStudent`、`chooseTasks` 传入课程的先修关系和各 topic 的 encompassing（正权重），通过与失败按权重隐式传播（FIRe）。更新粒度由教学层决定：学习插件按 topic 更新，不按题传递信用。

## 状态更新与候选

### 状态与更新次序

`applyRepetition(graph, student, repetition, config)` 返回新状态，不修改输入。`repetition.day` 是统一时间基准上的连续天数，由调用方传入。每个主题保存 `repNum`、`memory`、`speed`、`lastRepetitionDay` 和 `interval`；没有条目表示尚未学完。初学通过才创建状态，失败和遗忘不删除已有学习经历。

更新沿用来源版本中的两式：

```text
repNum' = max(0, repNum + speed × decay^failed × rawDelta)
memory' = max(0, memory + rawDelta) × 0.5^(days / interval)
```

memory 更新先加信用，再把整体按更新前的 interval 衰减。查询 `memoryAt` 只读投影，不改锚点；`memory` 可以大于 1，是调度量，不是答对概率。

来源研究以 Justin Skycak 的 [HSRS / FIRe 文章](https://www.justinmath.com/individualized-spaced-repetition-in-hierarchical-knowledge-structures/)为机制依据，原分支记录核对日期为 2026-10-10。文章未公开的参数和函数形状属于 Repa 假设，逐项命名在 `DEFAULT_MODEL_CONFIG`，注释写明各自的出处：到期线 `dueMemory`、提前复习的折扣 `fullCreditMemory`、speed 的起点与调整、理想间隔的底数与上限、逾期退回的斜率。多条路径取最大值的合并方式和以更新前的间隔衰减的时间协议也是假设。它们控制什么、什么证据会改变它们，见学习插件的[尚待查证的假设](../learning/README.md#尚待查证的假设)。

### 候选与配置

`selectTasks(graph, student, day, limit, includeNew, config)` 最多返回 limit 项。它预演每项通过后的到期变化，贪心处理尚未覆盖的到期项；同覆盖量先选更逾期的直接复习，再选新主题，最后保持输入图顺序。返回的 reason 相对于调用时状态，选项不构成已经执行的批次。

输入应当通过导出的 TypeBox schema；调用方还负责主题引用、DAG、数值有限性、配置与时间顺序等跨字段条件。`ModelConfig` 从 schema 推导，只含公式里的常数，默认值保持原 v0 结果；调参就是换这组常数，用另一组参数重放同一串复习，可以比较两组参数的预测。研究专用的缩放、指数、capped-sum 路径合并和关闭 speed 更新的开关已删除，研究重新开始时从 git 历史取回。

## 验证入口

在仓库根目录运行：

```sh
npm run check --workspace=@repa/learning-model
npm test --workspace=@repa/learning-model
npm run build --workspace=@repa/learning-model
```

`test/model.test.ts`、`test/selector.test.ts` 和 `test/config.test.ts` 覆盖默认数值、旧间隔衰减顺序、分图、直接／隐式信用、路径汇合、各项参数的作用、换一组参数得出不同的预测和选择器回归。

## 对模型的影响

无：本包只接收显式参数并返回学生状态或任务候选，不向模型注入提示、工具或上下文。

## 已知限制与暂缓

- 真实作答上的参数校准、memory 到概率的换算属于后续研究。FIRe 已在学习插件启用，权重是课程里写的假设。合成比较代码只作为默认配置回归夹具，实验运行入口与研究结果在来源研究分支。
