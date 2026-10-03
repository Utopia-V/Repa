import { Temporal } from "@js-temporal/polyfill";
import { RepaFault } from "repa/protocol";
import type { PlanClockInput, PlanClockResult, PlanInput, PlanIssue, PlanResult } from "./schema.js";

type Interval = { start: bigint; end: bigint };
type Session = Interval & { id: string; goalId: string };
type Goal = { id: string; nanoseconds: bigint; deadline?: bigint };

const MINUTE_NANOSECONDS = 60_000_000_000n;
const toMinutes = (nanoseconds: bigint) =>
  Number(nanoseconds / MINUTE_NANOSECONDS) + Number(nanoseconds % MINUTE_NANOSECONDS) / Number(MINUTE_NANOSECONDS);

function toNanoseconds(minutes: number): bigint {
  // 输入估计只量化一次；十进制数先精确换算，避免浮点乘法与加减制造虚假缺口。
  const text = minutes.toString();
  const exponentIndex = text.indexOf("e");
  const decimal = exponentIndex < 0 ? text : text.slice(0, exponentIndex);
  const exponent = exponentIndex < 0 ? 0 : Number(text.slice(exponentIndex + 1));
  const pointIndex = decimal.indexOf(".");
  const scale = exponent - (pointIndex < 0 ? 0 : decimal.length - pointIndex - 1);
  const numerator = BigInt(decimal.replace(".", "")) * MINUTE_NANOSECONDS;
  if (scale >= 0) return numerator * 10n ** BigInt(scale);
  const denominator = 10n ** BigInt(-scale);
  return (numerator + denominator / 2n) / denominator;
}
const instant = (nanoseconds: bigint) =>
  Temporal.Instant.fromEpochNanoseconds(nanoseconds).toString();

function parseTime(value: string, timeZone: string, field: string): bigint {
  try {
    // 时区是输入的单一解释来源；日期本身不足以确定截止时刻。
    if (!/^[+-]?\d{4,6}-\d{2}-\d{2}[Tt]\d{2}:\d{2}/.test(value) || /[\[\]]/.test(value)) {
      throw new RangeError("需要明确的 ISO 日期时间");
    }
    return Temporal.ZonedDateTime.from(`${value}[${timeZone}]`, {
      disambiguation: "reject",
      offset: "reject",
    }).epochNanoseconds;
  } catch {
    throw new RepaFault("invalid_plan_time", "规划时间无效、不存在或含糊；请提供明确的日期时间与时区。", { field, value, timeZone });
  }
}

function parseInterval(value: { start: string; end: string }, timeZone: string, field: string): Interval {
  const start = parseTime(value.start, timeZone, `${field}.start`);
  const end = parseTime(value.end, timeZone, `${field}.end`);
  if (end <= start) {
    throw new RepaFault("invalid_plan_time", "规划区间的结束时刻必须晚于开始时刻。", { field, start: value.start, end: value.end });
  }
  return { start, end };
}

function mergedIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.toSorted((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval.start > previous.end) {
      merged.push({ ...interval });
    } else if (interval.end > previous.end) {
      previous.end = interval.end;
    }
  }
  return merged;
}

function coveredNanoseconds(availability: Interval[], range?: Interval): bigint {
  let total = 0n;
  for (const window of availability) {
    const start = range && range.start > window.start ? range.start : window.start;
    const end = range && range.end < window.end ? range.end : window.end;
    if (start < end) total += end - start;
  }
  return total;
}

function normalizedInterval(interval: Interval) {
  return {
    start: instant(interval.start),
    end: instant(interval.end),
    minutes: toMinutes(interval.end - interval.start),
  };
}

function assertUniqueIds(values: { id: string }[], field: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) {
      throw new RepaFault("invalid_plan_input", "规划标识重复，无法确定目标或安排的归属。", { field, id: value.id });
    }
    ids.add(value.id);
  }
}

/** 只检查明确输入的时间和工作量；不排程，也不把安排量解释为实际学习成果。 */
export function checkPlan(input: PlanInput): PlanResult {
  let timeZone: string;
  try {
    timeZone = Temporal.Instant.from("2000-01-01T00:00Z").toZonedDateTimeISO(input.timeZone).timeZoneId;
  } catch {
    throw new RepaFault("invalid_plan_time", "规划时区无效。", { field: "timeZone", value: input.timeZone });
  }
  assertUniqueIds(input.goals, "goals");
  assertUniqueIds(input.sessions, "sessions");
  const availability = mergedIntervals(input.availability.map((value, index) =>
    parseInterval(value, timeZone, `availability[${index}]`),
  ));
  const goals: Goal[] = input.goals.map((value, index) => ({
    id: value.id,
    nanoseconds: toNanoseconds(value.minutes),
    ...(value.deadline === undefined ? {} : {
      deadline: parseTime(value.deadline, timeZone, `goals[${index}].deadline`),
    }),
  }));
  const goalsById = new Map(goals.map((goal) => [goal.id, goal]));
  const sessions: Session[] = input.sessions.map((value, index) => {
    if (!goalsById.has(value.goalId)) {
      throw new RepaFault("invalid_plan_input", "安排引用了输入中不存在的目标。", { sessionId: value.id, goalId: value.goalId });
    }
    return { id: value.id, goalId: value.goalId, ...parseInterval(value, timeZone, `sessions[${index}]`) };
  });
  const issues: PlanIssue[] = [];
  const scheduledByGoal = new Map<string, bigint>();
  for (const session of sessions) {
    const duration = session.end - session.start;
    scheduledByGoal.set(session.goalId, (scheduledByGoal.get(session.goalId) ?? 0n) + duration);
    const outsideNanoseconds = duration - coveredNanoseconds(availability, session);
    if (outsideNanoseconds > 0n) {
      issues.push({ code: "session_outside_availability", sessionId: session.id, outsideMinutes: toMinutes(outsideNanoseconds) });
    }
    const deadline = goalsById.get(session.goalId)?.deadline;
    if (deadline !== undefined && session.end > deadline) {
      issues.push({
        code: "session_after_deadline",
        sessionId: session.id,
        goalId: session.goalId,
        deadline: instant(deadline),
        lateMinutes: toMinutes(session.end - (deadline > session.start ? deadline : session.start)),
      });
    }
  }
  for (const [index, first] of sessions.entries()) {
    for (const second of sessions.slice(index + 1)) {
      const start = first.start > second.start ? first.start : second.start;
      const end = first.end < second.end ? first.end : second.end;
      if (start < end) {
        issues.push({ code: "session_overlap", sessionIds: [first.id, second.id], ...normalizedInterval({ start, end }) });
      }
    }
  }
  const goalResults = goals.map((goal) => {
    const scheduledNanoseconds = scheduledByGoal.get(goal.id) ?? 0n;
    const unallocatedNanoseconds = goal.nanoseconds > scheduledNanoseconds ? goal.nanoseconds - scheduledNanoseconds : 0n;
    if (unallocatedNanoseconds > 0n) {
      issues.push({ code: "goal_unallocated", goalId: goal.id, minutes: toMinutes(unallocatedNanoseconds) });
    }
    return {
      id: goal.id,
      requiredMinutes: toMinutes(goal.nanoseconds),
      scheduledMinutes: toMinutes(scheduledNanoseconds),
      unallocatedMinutes: toMinutes(unallocatedNanoseconds),
      ...(goal.deadline === undefined ? {} : { deadline: instant(goal.deadline) }),
    };
  });
  const availableNanoseconds = coveredNanoseconds(availability);
  const requiredNanoseconds = goals.reduce((sum, goal) => sum + goal.nanoseconds, 0n);
  if (requiredNanoseconds > availableNanoseconds) {
    issues.push({
      code: "capacity_shortfall",
      scope: "total",
      goalIds: goals.map((goal) => goal.id),
      requiredMinutes: toMinutes(requiredNanoseconds),
      availableMinutes: toMinutes(availableNanoseconds),
      shortfallMinutes: toMinutes(requiredNanoseconds - availableNanoseconds),
    });
  }
  // 所有工作可在输入窗口中分配；每个期限检查此前全部目标的累计需求，而不是单目标独占容量。
  const deadlines = [...new Set(goals.flatMap((goal) => goal.deadline === undefined ? [] : [goal.deadline]))]
    .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  for (const deadline of deadlines) {
    const dueGoals = goals.filter((goal) => goal.deadline !== undefined && goal.deadline <= deadline);
    const requiredNanoseconds = dueGoals.reduce((sum, goal) => sum + goal.nanoseconds, 0n);
    const availableNanoseconds = availability.reduce((sum, window) => {
      const end = window.end < deadline ? window.end : deadline;
      return sum + (window.start < end ? end - window.start : 0n);
    }, 0n);
    if (requiredNanoseconds > availableNanoseconds) {
      issues.push({
        code: "capacity_shortfall",
        scope: "deadline",
        deadline: instant(deadline),
        goalIds: dueGoals.map((goal) => goal.id),
        requiredMinutes: toMinutes(requiredNanoseconds),
        availableMinutes: toMinutes(availableNanoseconds),
        shortfallMinutes: toMinutes(requiredNanoseconds - availableNanoseconds),
      });
    }
  }
  return {
    timeZone,
    availability: availability.map(normalizedInterval),
    sessions: sessions.map((session) => ({ id: session.id, goalId: session.goalId, ...normalizedInterval(session) })),
    availableMinutes: toMinutes(availableNanoseconds),
    requiredMinutes: toMinutes(requiredNanoseconds),
    scheduledMinutes: toMinutes([...scheduledByGoal.values()].reduce((sum, nanoseconds) => sum + nanoseconds, 0n)),
    goals: goalResults,
    issues,
  };
}

/** 相对日期解释需要实际时钟事实；日期含义仍由调用方确认。 */
export function planClock(input: PlanClockInput, now = Date.now()): PlanClockResult {
  const timeZone = input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const current = Temporal.Instant.fromEpochMilliseconds(now);
  try {
    const local = current.toZonedDateTimeISO(timeZone);
    return {
      instant: current.toString(),
      localDateTime: local.toPlainDateTime().toString(),
      timeZone: local.timeZoneId,
    };
  } catch {
    throw new RepaFault("invalid_plan_time", "规划时区无效。", { field: "timeZone", value: timeZone });
  }
}
