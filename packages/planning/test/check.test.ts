import assert from "node:assert/strict";
import test from "node:test";
import { Compile } from "typebox/compile";
import { RepaFault } from "repa/protocol";
import { checkPlan, planClock } from "../src/check.js";
import { PlanInputSchema, PlanResultSchema, type PlanInput } from "../src/schema.js";

const resultValidator = Compile(PlanResultSchema);

function plan(): PlanInput {
  return {
    timeZone: "Asia/Taipei",
    availability: [{ start: "2026-10-05T09:00", end: "2026-10-05T11:00" }],
    goals: [{ id: "algebra", minutes: 90, deadline: "2026-10-05T11:00" }],
    sessions: [{ id: "study", goalId: "algebra", start: "2026-10-05T09:00", end: "2026-10-05T10:30" }],
  };
}

function assertTimeFault(input: PlanInput, field: string): void {
  assert.throws(() => checkPlan(input), (error: unknown) => {
    assert.ok(error instanceof RepaFault);
    assert.equal(error.code, "invalid_plan_time");
    assert.deepEqual((error.details as { field: string }).field, field);
    return true;
  });
}

test("单目标安排按实际时区标准化，并核对明确工作量", () => {
  const input = plan();
  const before = structuredClone(input);
  assert.equal(Compile(PlanInputSchema).Check(input), true);
  const result = checkPlan(input);
  assert.equal(resultValidator.Check(result), true);
  assert.deepEqual(result, {
    timeZone: "Asia/Taipei",
    availability: [{ start: "2026-10-05T01:00:00Z", end: "2026-10-05T03:00:00Z", minutes: 120 }],
    sessions: [{ id: "study", goalId: "algebra", start: "2026-10-05T01:00:00Z", end: "2026-10-05T02:30:00Z", minutes: 90 }],
    availableMinutes: 120,
    requiredMinutes: 90,
    scheduledMinutes: 90,
    goals: [{ id: "algebra", requiredMinutes: 90, scheduledMinutes: 90, unallocatedMinutes: 0, deadline: "2026-10-05T03:00:00Z" }],
    issues: [],
  });
  assert.deepEqual(input, before);
});

test("并行目标的相接安排不冲突，重叠可用窗口不重复计量", () => {
  const input = plan();
  input.availability.push({ start: "2026-10-05T10:00", end: "2026-10-05T12:00" });
  input.goals.push({ id: "physics", minutes: 90 });
  input.sessions.push({ id: "practice", goalId: "physics", start: "2026-10-05T10:30", end: "2026-10-05T12:00" });
  const result = checkPlan(input);
  assert.equal(result.availableMinutes, 180);
  assert.equal(result.requiredMinutes, 180);
  assert.equal(result.scheduledMinutes, 180);
  assert.equal(result.availability.length, 1);
  assert.deepEqual(result.issues, []);
});

test("期限提前后分别指出已排安排超期和期限前容量不足", () => {
  const input = plan();
  input.goals = [{ id: "algebra", minutes: 90, deadline: "2026-10-05T10:00" }];
  const result = checkPlan(input);
  assert.deepEqual(result.issues, [
    { code: "session_after_deadline", sessionId: "study", goalId: "algebra", deadline: "2026-10-05T02:00:00Z", lateMinutes: 30 },
    { code: "capacity_shortfall", scope: "deadline", deadline: "2026-10-05T02:00:00Z", goalIds: ["algebra"], requiredMinutes: 90, availableMinutes: 60, shortfallMinutes: 30 },
  ]);
  input.goals = [{ id: "algebra", minutes: 90, deadline: "2026-10-05T10:30" }];
  assert.deepEqual(checkPlan(input).issues, []);
});

test("多个目标累计共享期限前容量，不把每个目标单独视为可行", () => {
  const input = plan();
  input.goals = [
    { id: "algebra", minutes: 60, deadline: "2026-10-05T10:00" },
    { id: "physics", minutes: 60, deadline: "2026-10-05T10:30" },
    { id: "reading", minutes: 30 },
  ];
  input.sessions = [];
  const result = checkPlan(input);
  assert.deepEqual(result.goals.map((goal) => goal.unallocatedMinutes), [60, 60, 30]);
  assert.deepEqual(result.issues.filter((issue) => issue.code === "capacity_shortfall"), [
    { code: "capacity_shortfall", scope: "total", goalIds: ["algebra", "physics", "reading"], requiredMinutes: 150, availableMinutes: 120, shortfallMinutes: 30 },
    { code: "capacity_shortfall", scope: "deadline", deadline: "2026-10-05T02:30:00Z", goalIds: ["algebra", "physics"], requiredMinutes: 120, availableMinutes: 90, shortfallMinutes: 30 },
  ]);
  assert.deepEqual(result.issues.filter((issue) => issue.code === "goal_unallocated"), [
    { code: "goal_unallocated", goalId: "algebra", minutes: 60 },
    { code: "goal_unallocated", goalId: "physics", minutes: 60 },
    { code: "goal_unallocated", goalId: "reading", minutes: 30 },
  ]);
});

test("可用时间缩减后报告越界分钟和工作量缺口", () => {
  const input = plan();
  input.availability = [
    { start: "2026-10-05T09:00", end: "2026-10-05T09:30" },
    { start: "2026-10-05T10:00", end: "2026-10-05T10:15" },
  ];
  const result = checkPlan(input);
  assert.equal(result.availableMinutes, 45);
  assert.deepEqual(result.issues[0], { code: "session_outside_availability", sessionId: "study", outsideMinutes: 45 });
  assert.deepEqual(result.issues.filter((issue) => issue.code === "capacity_shortfall").map((issue) => issue.shortfallMinutes), [45, 45]);
});

test("同一人的交叠安排报告具体区间，未分配量与安排冲突分开", () => {
  const input = plan();
  input.goals.push({ id: "physics", minutes: 60 });
  input.sessions.push({ id: "practice", goalId: "physics", start: "2026-10-05T10:00", end: "2026-10-05T10:30" });
  const result = checkPlan(input);
  assert.equal(result.scheduledMinutes, 120);
  assert.deepEqual(result.issues.filter((issue) => issue.code === "session_overlap"), [
    { code: "session_overlap", sessionIds: ["study", "practice"], start: "2026-10-05T02:00:00Z", end: "2026-10-05T02:30:00Z", minutes: 30 },
  ]);
  assert.deepEqual(result.goals[1], { id: "physics", requiredMinutes: 60, scheduledMinutes: 30, unallocatedMinutes: 30 });
});

test("DST跳过和重复小时按实际经过时间计量，offset明确选择重复时刻", () => {
  const input: PlanInput = {
    timeZone: "America/New_York",
    availability: [
      { start: "2026-03-08T01:00", end: "2026-03-08T04:00" },
      { start: "2026-11-01T01:00-04:00", end: "2026-11-01T02:00-05:00" },
    ],
    goals: [{ id: "review", minutes: 240 }],
    sessions: [
      { id: "spring", goalId: "review", start: "2026-03-08T01:00", end: "2026-03-08T04:00" },
      { id: "autumn", goalId: "review", start: "2026-11-01T01:00-04:00", end: "2026-11-01T02:00-05:00" },
    ],
  };
  const result = checkPlan(input);
  assert.equal(resultValidator.Check(result), true);
  assert.deepEqual(result.sessions.map((session) => session.minutes), [120, 120]);
  assert.equal(result.availableMinutes, 240);
  assert.deepEqual(result.issues, []);
});

test("DST不存在或含糊的本地钟点不默猜，数字offset也必须吻合时区", () => {
  const input = plan();
  input.timeZone = "America/New_York";
  for (const start of ["2026-03-08T02:30", "2026-03-08T02:30-05:00", "2026-11-01T01:30"]) {
    input.availability = [{ start, end: "2026-11-02T03:00" }];
    assertTimeFault(input, "availability[0].start");
  }
});

test("无效时区、缺少明确截止时间和逆向区间返回可定位输入错误", () => {
  const invalidZone = plan();
  invalidZone.timeZone = "Mars/Olympus";
  assertTimeFault(invalidZone, "timeZone");
  const dateOnly = plan();
  dateOnly.goals = [{ id: "algebra", minutes: 90, deadline: "2026-10-05" }];
  assertTimeFault(dateOnly, "goals[0].deadline");
  const reversed = plan();
  reversed.availability = [{ start: "2026-10-05T11:00", end: "2026-10-05T09:00" }];
  assertTimeFault(reversed, "availability[0]");
});

test("无法确定归属的重复标识与未知目标拒绝计算", () => {
  const duplicateGoal = plan();
  duplicateGoal.goals.push({ id: "algebra", minutes: 30 });
  const duplicateSession = plan();
  duplicateSession.sessions.push({ id: "study", goalId: "algebra", start: "2026-10-05T10:30", end: "2026-10-05T11:00" });
  const unknownGoal = plan();
  unknownGoal.sessions = [{ id: "study", goalId: "missing", start: "2026-10-05T09:00", end: "2026-10-05T10:00" }];
  for (const input of [duplicateGoal, duplicateSession, unknownGoal]) {
    assert.throws(() => checkPlan(input), (error: unknown) => {
      assert.ok(error instanceof RepaFault);
      assert.equal(error.code, "invalid_plan_input");
      return true;
    });
  }
});

test("固定实际时钟与显式时区提供相对日期解释所需的事实", () => {
  assert.deepEqual(planClock({ timeZone: "Asia/Taipei" }, Date.parse("2026-10-03T20:30:00Z")), {
    instant: "2026-10-03T20:30:00Z",
    localDateTime: "2026-10-04T04:30:00",
    timeZone: "Asia/Taipei",
  });
});

test("秒级视频工作量恰好填满可用窗口，不因浮点汇总误报不足", () => {
  const input: PlanInput = {
    timeZone: "Asia/Taipei",
    availability: [{ start: "2026-10-05T09:00", end: "2026-10-05T10:00:24" }],
    goals: [
      { id: "first-video", minutes: 20.2, deadline: "2026-10-05T10:00:24" },
      { id: "second-video", minutes: 40.2, deadline: "2026-10-05T10:00:24" },
    ],
    sessions: [
      { id: "first-session", goalId: "first-video", start: "2026-10-05T09:00", end: "2026-10-05T09:20:12" },
      { id: "second-session", goalId: "second-video", start: "2026-10-05T09:20:12", end: "2026-10-05T10:00:24" },
    ],
  };
  const result = checkPlan(input);
  assert.equal(result.requiredMinutes, 60.4);
  assert.equal(result.availableMinutes, 60.4);
  assert.equal(result.scheduledMinutes, 60.4);
  assert.deepEqual(result.goals.map((goal) => goal.unallocatedMinutes), [0, 0]);
  assert.deepEqual(result.issues, []);
  assert.equal(resultValidator.Check(result), true);
});
