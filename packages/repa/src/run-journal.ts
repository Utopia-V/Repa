import {
  appendFileSync,
  existsSync,
  readFileSync,
  truncateSync,
} from "node:fs";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { RepaFault } from "./protocol.js";
import { PromptSettingsSchema } from "./configuration/schema.js";

export const RUN_RECORD_FORMAT = "repa.run";
export const RUN_RECORD_VERSION = 1;
const id = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-zA-Z0-9_-]+$",
});
const error = Type.Object(
  { code: Type.String(), message: Type.String() },
  { additionalProperties: false },
);
const request = Type.Object(
  {
    id,
    spaceId: id,
    sessionId: id,
    text: Type.String(),
    createdAt: Type.Number(),
    promptSettings: Type.Optional(PromptSettingsSchema),
  },
  { additionalProperties: false },
);
const result = Type.Object(
  {
    status: Type.Enum(["completed", "cancelled", "failed", "interrupted"]),
    finishedAt: Type.Optional(Type.Number()),
    error: Type.Optional(error),
  },
  { additionalProperties: false },
);
const recordV1 = Type.Object(
  {
    format: Type.Literal(RUN_RECORD_FORMAT),
    version: Type.Literal(RUN_RECORD_VERSION),
    request,
    result: Type.Optional(result),
  },
  { additionalProperties: false },
);
export type RecordedRun = Pick<Static<typeof recordV1>, "request" | "result">;

// Frozen reader for the original unversioned format. It must not follow changes to the wire schema.
const recordV0 = Type.Object(
  {
    id,
    spaceId: id,
    sessionId: id,
    text: Type.String(),
    createdAt: Type.Number(),
    status: Type.Enum([
      "accepted",
      "running",
      "waiting",
      "cancelling",
      "completed",
      "cancelled",
      "failed",
      "interrupted",
    ]),
    phase: Type.Enum([
      "preparing",
      "model",
      "tool",
      "retry",
      "compaction",
      "idle",
    ]),
    finishedAt: Type.Optional(Type.Number()),
    error: Type.Optional(error),
  },
  { additionalProperties: false },
);

function invalid(location: string, message: string): never {
  throw new RepaFault("invalid_run_record", `${location}：${message}`);
}

function decode(value: unknown, location: string): RecordedRun {
  if (
    value !== null &&
    typeof value === "object" &&
    ("format" in value || "version" in value)
  ) {
    if (
      !("format" in value) ||
      value.format !== RUN_RECORD_FORMAT ||
      !("version" in value) ||
      value.version !== RUN_RECORD_VERSION
    ) {
      throw new RepaFault(
        "unsupported_run_format",
        `${location}：不支持该运行记录的格式或版本，原文件保持不变。`,
      );
    }
    if (!Check(recordV1, value))
      invalid(location, "运行记录不符合已声明的版本。");
    return {
      request: value.request,
      ...(value.result ? { result: value.result } : {}),
    };
  }
  if (!Check(recordV0, value)) invalid(location, "无法识别旧版运行记录。");
  const recorded: RecordedRun = {
    request: {
      id: value.id,
      spaceId: value.spaceId,
      sessionId: value.sessionId,
      text: value.text,
      createdAt: value.createdAt,
    },
  };
  switch (value.status) {
    case "completed":
    case "cancelled":
    case "failed":
    case "interrupted":
      recorded.result = {
        status: value.status,
        ...(value.finishedAt === undefined
          ? {}
          : { finishedAt: value.finishedAt }),
        ...(value.error ? { error: value.error } : {}),
      };
  }
  return recorded;
}

function incorporate(
  runs: Map<string, RecordedRun>,
  next: RecordedRun,
  spaceId: string,
  location: string,
): void {
  if (next.request.spaceId !== spaceId)
    invalid(location, "运行记录属于另一个学习空间。");
  const previous = runs.get(next.request.id);
  if (previous) {
    for (const field of [
      "spaceId",
      "sessionId",
      "text",
      "createdAt",
    ] as const) {
      if (previous.request[field] !== next.request[field])
        invalid(location, "同一请求标识对应了不同的请求。");
    }
    if (
      previous.result &&
      (!next.result ||
        previous.result.status !== next.result.status ||
        previous.result.finishedAt !== next.result.finishedAt ||
        previous.result.error?.code !== next.result.error?.code ||
        previous.result.error?.message !== next.result.error?.message)
    ) {
      invalid(location, "已经记录的终态发生了冲突。");
    }
  }
  runs.set(next.request.id, next);
}

export function readRunJournal(file: string, spaceId: string): RecordedRun[] {
  if (!existsSync(file)) return [];
  const bytes = readFileSync(file);
  const end = bytes.lastIndexOf(10) + 1;
  const runs = new Map<string, RecordedRun>();
  const lines = bytes.subarray(0, end).toString("utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const location = `${file}:${index + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      invalid(location, "运行记录不是有效 JSON。");
    }
    incorporate(runs, decode(value, location), spaceId, location);
  }
  if (end < bytes.length) {
    const tail = bytes.subarray(end).toString("utf8");
    let value: unknown;
    try {
      value = JSON.parse(tail);
    } catch {
      /* An incomplete final append is not a committed record. */
    }
    // Even an unterminated record must not let this reader truncate a recognizable future format.
    if (value !== undefined) decode(value, `${file}:${lines.length}`);
    truncateSync(file, end);
  }
  return [...runs.values()];
}

export function appendRunRecord(file: string, run: RecordedRun): void {
  const record = {
    format: RUN_RECORD_FORMAT,
    version: RUN_RECORD_VERSION,
    request: run.request,
    ...(run.result ? { result: run.result } : {}),
  };
  if (!Check(recordV1, record))
    invalid(file, "不能写入不符合当前持久格式的运行记录。");
  appendFileSync(file, JSON.stringify(record) + "\n", {
    encoding: "utf8",
    mode: 0o600,
    flush: true,
  });
}
