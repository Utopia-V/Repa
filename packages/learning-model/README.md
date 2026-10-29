# 学生模型与任务选择器

## 概述

`@repa/learning-model` 提供 HSRS 学生状态更新与任务候选选择，是不读写文件、不读取时钟的 TypeScript 纯计算库。

## 怎么用

作答是否能成为一次学习或复习证据，由学习插件判断；计算库只把已经确认的结果更新为学生状态，再依据显式传入的图、时间和配置选择候选。因此，插件可以在同一次结果记录中保存返回状态，重开时直接恢复，而不重复执行计算。

库保留 encompassing 信用传播以便研究，当前产品接入则通过学习包的 `updateStudent`、`chooseTasks` 传入空 encompassing 图，关闭正负隐式传播，保留直接复习。更新粒度由教学层决定。

## 状态更新与候选

### 状态与更新次序

`applyRepetition(graph, student, repetition, config)` 返回新状态，不修改输入。`repetition.day` 是统一时间基准上的连续天数，由调用方传入。每个主题保存 `repNum`、`memory`、`speed`、`lastRepetitionDay` 和 `interval`；没有条目表示尚未学完。初学通过才创建状态，失败和遗忘不删除已有学习经历。

更新沿用来源版本中的两式：

```text
repNum' = max(0, repNum + speed × decay^failed × rawDelta)
memory' = max(0, memory + rawDelta) × 0.5^(days / interval)
```

memory 更新先加信用，再把整体按更新前的 interval 衰减。查询 `memoryAt` 只读投影，不改锚点；`memory` 可以大于 1，是调度量，不是答对概率。

来源研究以 Justin Skycak 的 [HSRS / FIRe 文章](https://www.justinmath.com/individualized-spaced-repetition-in-hierarchical-knowledge-structures/)为机制依据，原分支记录核对日期为 2026-10-10。文章未公开的参数、函数形状和时间协议属于 Repa 假设，集中在 `ASSUMPTIONS` 与 `DEFAULT_MODEL_CONFIG`：初始 speed 为 1，到期阈值为 0.5，理想间隔为 `min(365, 2^max(0, repNum - 1))` 天；提前折扣、逾期退回、speed 调整与路径汇合也保留原默认值。

### 候选与配置

`selectTasks(graph, student, day, limit, includeNew, config)` 最多返回 limit 项。它预演每项通过后的到期变化，贪心处理尚未覆盖的到期项；同覆盖量先选更逾期的直接复习，再选新主题，最后保持输入图顺序。返回的 reason 相对于调用时状态，选项不构成已经执行的批次。

输入应当通过导出的 TypeBox schema；调用方还负责主题引用、DAG、数值有限性、配置与时间顺序等跨字段条件。`ModelConfig` 从 schema 推导，调用时传入完整配置，默认配置保持原 v0 结果。

## 验证入口

在仓库根目录运行：

```sh
npm run check --workspace=@repa/learning-model
npm test --workspace=@repa/learning-model
npm run build --workspace=@repa/learning-model
```

`test/model.test.ts`、`test/selector.test.ts` 和 `test/config.test.ts` 覆盖默认数值、旧间隔衰减顺序、分图、直接／隐式信用、路径汇合和选择器回归。

## 对模型的影响

无：本包只接收显式参数并返回学生状态或任务候选，不向模型注入提示、工具或上下文。

## 已知限制与暂缓

- 真实作答上的参数校准、memory 到概率的换算和 FIRe 启用属于后续研究。合成比较代码只作为默认配置回归夹具，实验运行入口与研究结果在来源研究分支。
