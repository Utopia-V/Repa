import { Type, type Static } from "typebox";

const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const id = Type.String({ minLength: 1 });
const time = Type.String({ minLength: 1 });
const minutes = Type.Number({ minimum: 0 });
const interval = { start: time, end: time };

export const PlanInputSchema = object({
  timeZone: Type.String({ minLength: 1 }),
  availability: Type.Array(object(interval)),
  goals: Type.Array(object({
    id,
    minutes,
    deadline: Type.Optional(time),
  })),
  sessions: Type.Array(object({ id, goalId: id, ...interval })),
});
export type PlanInput = Static<typeof PlanInputSchema>;

export const PlanIssueSchema = Type.Union([
  object({
    code: Type.Literal("session_outside_availability"),
    sessionId: id,
    outsideMinutes: minutes,
  }),
  object({
    code: Type.Literal("session_overlap"),
    sessionIds: Type.Array(id, { minItems: 2, maxItems: 2 }),
    ...interval,
    minutes,
  }),
  object({
    code: Type.Literal("session_after_deadline"),
    sessionId: id,
    goalId: id,
    deadline: time,
    lateMinutes: minutes,
  }),
  object({
    code: Type.Literal("goal_unallocated"),
    goalId: id,
    minutes,
  }),
  object({
    code: Type.Literal("capacity_shortfall"),
    scope: Type.Literal("total"),
    goalIds: Type.Array(id),
    requiredMinutes: minutes,
    availableMinutes: minutes,
    shortfallMinutes: minutes,
  }),
  object({
    code: Type.Literal("capacity_shortfall"),
    scope: Type.Literal("deadline"),
    deadline: time,
    goalIds: Type.Array(id),
    requiredMinutes: minutes,
    availableMinutes: minutes,
    shortfallMinutes: minutes,
  }),
]);
export type PlanIssue = Static<typeof PlanIssueSchema>;

export const PlanResultSchema = object({
  timeZone: Type.String(),
  availability: Type.Array(object({ ...interval, minutes })),
  sessions: Type.Array(object({ id, goalId: id, ...interval, minutes })),
  availableMinutes: minutes,
  requiredMinutes: minutes,
  scheduledMinutes: minutes,
  goals: Type.Array(object({
    id,
    requiredMinutes: minutes,
    scheduledMinutes: minutes,
    unallocatedMinutes: minutes,
    deadline: Type.Optional(time),
  })),
  issues: Type.Array(PlanIssueSchema),
});
export type PlanResult = Static<typeof PlanResultSchema>;

export const PlanClockInputSchema = object({
  timeZone: Type.Optional(Type.String({ minLength: 1 })),
});
export type PlanClockInput = Static<typeof PlanClockInputSchema>;
export const PlanClockResultSchema = object({
  instant: time,
  localDateTime: time,
  timeZone: Type.String(),
});
export type PlanClockResult = Static<typeof PlanClockResultSchema>;
