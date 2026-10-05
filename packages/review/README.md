# 复习记录与调度

`@repa/review` 保存复习项、实际反馈和更正，提供内容修改、到期查询、暂停、人工安排与参数管理。调度使用 `ts-fsrs@5.4.2`，SQLite 负责把一次反馈与对应状态共同保存。你可以修改同一项的题目、答案和来源，同时保留其复习状态；原记录保留，当前估计可以随更正或参数变化重新计算。

本包是当前 FSRS 候选实现。学习任务选择与复习调度的算法研究见 [#38](https://github.com/Utopia-V/repa/issues/38)，后续按实际需要决定沿用、组合或替换的范围。

Agent 和公开客户端使用版本为 `1` 的 `repa.review.*` 契约，浏览器类型与 schema 从 `@repa/review/protocol` 导入。包通过 `repa.backend` 提供后台，通过独立 `repa.snapshot` 在禁用后参与空间备份和复制。

官方默认以 `repa-review` 加载，第一次空间调用才打开数据库。单独安装的版本按宿主的信任与启用配置接入。新用户使用默认参数即可开始，可选的 `@open-spaced-repetition/binding@0.5.0` 在独立子进程中训练候选参数，用户明确采用后才修改调度设置。

字段含义、重传与冲突、算法取舍和当前未完成项见[复习开发说明](../../docs/development/review.md)。默认接入方式见[官方学习组合](../../docs/development/official-learning.md)。

在仓库根目录运行：

```sh
npm run build:backend
npm run check --workspace=@repa/review
npm test --workspace=@repa/review
```
