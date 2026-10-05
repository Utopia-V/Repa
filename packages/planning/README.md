# 学习规划

`@repa/planning` 提供 `plan-learning` Pi Skill、`planning_clock` 时钟工具和 `check_plan` 时间约束工具。Agent 根据目标、材料和反馈分配时间预算；已有实际可用时段时，再用工具核对日期、容量与冲突。计划通过内容工具保存为文档。

日期与时区计算使用 `@js-temporal/polyfill@0.5.1`。包只检查本次候选，不维护另一份日程数据库；用户直接编辑计划后，下次规划读取当前文档。

官方默认以 `repa-planning` 加载。关闭该项会同时移除方法和工具，已经保存的计划保留。单独安装的版本按宿主的信任与启用设置接入。接口、示例和当前未完成项见[规划开发说明](../../docs/development/planning.md)。

在仓库根目录运行：

```sh
npm run build:backend
npm run check --workspace=@repa/planning
npm test --workspace=@repa/planning
```
