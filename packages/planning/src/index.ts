import type { BackendPlugin, CapabilityDefinition } from "repa/plugin";
import { checkPlan, planClock } from "./check.js";
import { PlanInputSchema, PlanResultSchema, PlanClockInputSchema, PlanClockResultSchema } from "./schema.js";
export * from "./schema.js";

export default function planning(): BackendPlugin {
  const check: CapabilityDefinition<typeof PlanInputSchema, typeof PlanResultSchema> = {
    contract: { id: "repa.planning.check", version: "1" }, implementationId: "temporal",
    inputSchema: PlanInputSchema, outputSchema: PlanResultSchema,
    scopes: ["application", "space"], execution: "query",
    tool: {
      name: "check_plan",
      description: "检查已有具体起止时刻的可用窗口和候选日程，结合时区、目标工作量与期限，返回实际分钟、冲突和不足。仅有分钟预算时直接比较工作量；本工具用于核对实际时段，不保存或改写计划。",
    },
    invoke(input, context) {
      context.signal.throwIfAborted();
      return checkPlan(input);
    },
  };
  const clock: CapabilityDefinition<typeof PlanClockInputSchema, typeof PlanClockResultSchema> = {
    contract: { id: "repa.planning.clock", version: "1" }, implementationId: "temporal",
    inputSchema: PlanClockInputSchema, outputSchema: PlanClockResultSchema,
    scopes: ["application", "space"], execution: "query",
    tool: { name: "planning_clock", description: "读取实际当前时刻、指定时区的本地日期时间及采用的时区；省略时区时使用机器时区。用于解释明天、本周等相对日期。" },
    invoke(input, context) {
      context.signal.throwIfAborted();
      return planClock(input);
    },
  };
  return { capabilities: [check, clock] };
}
