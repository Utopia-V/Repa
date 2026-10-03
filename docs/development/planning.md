# 学习规划方法与时间检查

`@repa/planning` 提供规划方法、当前时间和时间约束检查。Agent 拟定安排，工具核对日期、可用时间与工作量，最后通过内容工具把计划保存为文档。

## 设计思路

做计划时，你先要判断学什么、投入多少时间、遇到困难后怎样调整。这些判断依赖目标和实际学习情况，可以与 Agent 一起完成。安排逐渐明确后，日期、时长和冲突就可以交给工具计算。

这里把规划方法写成 Pi Skill，把时间检查做成后端能力。Agent 先拟定候选，再把时间窗口、目标工作量和安排交给工具。如果工具发现某个期限前的容量不足，你和 Agent 就可以据此讨论：缩减范围、延后期限，还是增加时间。

计划本身就是你能继续使用和修改的文档。你可以补充说明，也可以直接改动安排；下次调整时，Agent 会先读取当前文档，再考虑怎样修改。规划包因此不维护第二份计划数据库，文档版式也可以按你的需要选择。

## 方法与工具的分工

[plan-learning](../../packages/planning/skills/plan-learning/SKILL.md) 要求先读取已有计划和人工调整，再根据当前目标组织工作。工作量是估计，可以随实际作答或复习反馈修正；安排表达的是未来要做什么，不作为已经完成的记录。

官方默认以 `repa-planning` 装配，包的 `pi.skills` 与 `repa.backend` 使用同一启用选择；单独安装沿用[安装和信任入口](plugins.md)。可信包进入真实 Pi 的 Skill catalog，正文由已有 `read` 工具按需读取；后台工具与公共客户端调用同一实现。禁用配置中的该插件同时移除方法和工具，已有计划文档不受影响。静态提示预览可以查看 Skill 来源，不运行规划方法。

当前两个契约均支持 `space` 和 `application` 作用域，公开调用为 inline：

| 契约 | Agent 工具 | 责任 |
| --- | --- | --- |
| `repa.planning.clock/1` | `planning_clock` | 返回实际当前时刻、指定时区的本地日期时间和采用的时区；未指定时采用机器时区 |
| `repa.planning.check/1` | `check_plan` | 检查一次明确的候选安排，返回标准化时间、总量、各目标未分配量和具体问题 |

理解“今天”“下周”之前，需要先知道当前时间。Repa 的环境提示目前只提供工作目录，所以规划包提供 `planning_clock`。它返回时钟事实，具体的自然语言日期含义由用户与 Agent 确定，已经明确的时区也由调用方保留。

## 检查输入与时间语义

纯协议由 `@repa/planning/protocol` 导出，定义见 [schema.ts](../../packages/planning/src/schema.ts)。输入只描述本次检查范围：

| 字段 | 含义 |
| --- | --- |
| `timeZone` | 统一解释局部日期时间的时区 |
| `availability` | 该范围内可供安排的 `{ start, end }` 窗口 |
| `goals` | 用 `id` 关联所需工作量 `minutes`，可另给 `deadline` |
| `sessions` | 用 `id/goalId/start/end` 表达候选中的具体安排 |

`start/end/deadline` 使用明确的 ISO 日期时间。局部钟点按 `timeZone` 解释，`Z` 表示绝对时刻，数字 offset 必须与指定时区相符。日期-only 不能确定期限的具体时刻；例如“周五前完成”先由用户与 Agent 明确含义，再提交对应时间。

日期、时区和夏令时由 `@js-temporal/polyfill@0.5.1` 处理，使用 [Temporal.ZonedDateTime](https://tc39.es/proposal-temporal/docs/zoneddatetime.html) 的明确消歧规则。不存在或重复且未消歧的本地钟点返回 `invalid_plan_time` 并指明字段，重复小时可用相符的 offset 选择。包显式导入 polyfill，不修改全局 `Date` 或 `Temporal`，也不依赖宿主额外开启运行时标志。

区间采用 `[start, end)`，相接的两个安排不冲突；时长按实际经过时间计算。夏令时跳变时，墙上钟点相差三小时可能只经过两小时。内部区间使用 Temporal 纳秒，工作量转换到相同精度后汇总与比较，最终才输出分钟，避免秒级视频时长的浮点累加制造虚假缺口。

## 结果与可调整范围

输出区间标准化为 UTC，另保留 `timeZone` 供显示。重叠或相接的可用窗口先合并，`availableMinutes` 不重复计量。`requiredMinutes` 是输入目标的总工作量，`scheduledMinutes` 是所有候选安排时长的相加值；它包含仍有冲突的安排，不表示有效完成量。每个目标另有 `unallocatedMinutes`。

`issues` 分别表达：

- `session_outside_availability`：某次安排超出可用窗口及其分钟数。
- `session_overlap`：两次安排占用同一时段，给出具体交集。
- `session_after_deadline`：某次安排越过其目标期限。
- `goal_unallocated`：目标仍有工作量未分配。
- `capacity_shortfall`：总体容量或某个期限前的累计容量不足，返回相关目标、所需量、可用量及缺口。

检查某个期限时，会累计在它之前到期的全部目标，比较总需求与可用时间。还需要把容量和具体安排分开看：时间总量足够，也可能把两项工作排在同一时段；一个目标尚未排入日程，也可能仍有时间可用。因此，结果分别返回容量缺口和候选中的安排问题。

检查通过表示候选满足本次输入的时间与工作量约束。工作量估计得是否合适，需要实际学习反馈来判断。

用户减少时间或提前期限后，Agent 重新读取当前文档，核对受影响部分，再按已有优先级提出缩减范围、延后期限或增加时间等具体选择。保存继续使用共同内容入口及当前修改基准，人工修订和未涉及的安排保留。

## 公共调用示例

以下代码使用已连接的 `RepaClient`，不需要模型连接或空间数据库：

```ts
import { Check } from "typebox/value";
import { PlanResultSchema } from "@repa/planning/protocol";

const response = await client.call("capability.invoke", {
  scope: { kind: "application" },
  requestId: crypto.randomUUID(),
  contract: { id: "repa.planning.check", version: "1" },
  input: {
    timeZone: "Asia/Taipei",
    availability: [{ start: "2026-10-05T18:00", end: "2026-10-05T19:00" }],
    goals: [{ id: "tides", minutes: 90, deadline: "2026-10-05T19:00" }],
    sessions: [{ id: "read", goalId: "tides", start: "2026-10-05T18:00", end: "2026-10-05T19:00" }],
  },
});
if (response.kind === "inline" && Check(PlanResultSchema, response.result)) {
  console.log(response.result.issues); // 未安排 30 分钟，给定期限前也缺 30 分钟容量。
}
```

请求受理、重传与结果由[共享能力](capabilities.md)处理。规划包只计算本次输入，计划的保存使用内容接口。

## 未完成项与待验证项

| 项目 | 当前状态与影响 | 后续工作 |
| --- | --- | --- |
| 官方界面的规划操作 | 方法和公共工具已加入默认组合，图形界面尚未接入 | 由 [#10](https://github.com/Utopia-V/repa/issues/10) 使用同一契约联调 |
| 实际模型的规划质量 | 已验证工具调用、保存和人工修改接续；工作量判断、优先级及调整建议尚需真实使用评价 | 由 [#25](https://github.com/Utopia-V/repa/issues/25) 在获授权的学习试用中验证 |

## 验证

在仓库根目录执行：

```sh
npm run build:backend
npm run check --workspace=@repa/planning
npm test --workspace=@repa/planning
```

[check.test.ts](../../packages/planning/test/check.test.ts) 使用 Temporal 和明确日期，验证单个及多个目标、时间减少、期限变化、累计容量、冲突和夏令时。

[api.test.ts](../../packages/planning/test/api.test.ts) 通过编译包、Repa、Pi 和本地预设 provider，读取方法、检查并修正安排、保存计划，再经过人工修改和重开继续调整。测试核对人工内容的原始文字，也验证禁用后方法和工具同时移除。它验证的是这些步骤能否接通，真实模型的判断按上表另行评价。
