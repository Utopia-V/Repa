import type { BackendPlugin, CapabilityDefinition } from "repa/plugin";
import { checkPlan, planClock } from "./check.js";
import { PlanInputSchema, PlanResultSchema, PlanClockInputSchema, PlanClockResultSchema } from "./schema.js";
export * from "./schema.js";

export default function planning(): BackendPlugin {
  const check: CapabilityDefinition<typeof PlanInputSchema, typeof PlanResultSchema> = {
    contract: { id: "repa.planning.check", version: "1" }, implementationId: "temporal",
    inputSchema: PlanInputSchema, outputSchema: PlanResultSchema,
    scopes: ["application", "space"], execution: "inline",
    tool: {
      name: "check_plan",
      description: "检查明确日期、时区、可用时间、目标工作量与拟定安排，返回实际分钟、冲突和不足。它检查给定约束，不替学习者决定目标，也不保存或改写计划。",
    },
    invoke(input, context) {
      context.signal.throwIfAborted();
      return checkPlan(input);
    },
  };
  const clock: CapabilityDefinition<typeof PlanClockInputSchema, typeof PlanClockResultSchema> = {
    contract: { id: "repa.planning.clock", version: "1" }, implementationId: "temporal",
    inputSchema: PlanClockInputSchema, outputSchema: PlanClockResultSchema,
    scopes: ["application", "space"], execution: "inline",
    tool: { name: "planning_clock", description: "读取实际当前时刻、指定时区的本地日期时间及采用的时区；省略时区时使用机器时区。用于解释明天、本周等相对日期。" },
    invoke(input, context) {
      context.signal.throwIfAborted();
      return planClock(input);
    },
  };
  return { capabilities: [check, clock] };
}
