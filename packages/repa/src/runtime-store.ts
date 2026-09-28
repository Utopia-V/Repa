import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import {
  readRunJournal,
  appendRunRecord,
  type RecordedRun,
} from "./run-journal.js";
import { isTerminal, RepaFault, type Run, type Space } from "./protocol.js";
import { managedDirectory } from "./storage/managed-directory.js";

function currentRun(record: RecordedRun): Run {
  return {
    ...record.request,
    status: record.result?.status ?? "accepted",
    phase: record.result ? "idle" : "preparing",
    ...(record.result?.finishedAt === undefined
      ? {}
      : { finishedAt: record.result.finishedAt }),
    ...(record.result?.error ? { error: record.result.error } : {}),
  };
}

function recordedRun(run: Run): RecordedRun {
  const record: RecordedRun = {
    request: {
      id: run.id,
      spaceId: run.spaceId,
      sessionId: run.sessionId,
      text: run.text,
      createdAt: run.createdAt,
      ...(run.promptSettings ? { promptSettings: run.promptSettings } : {}),
    },
  };
  switch (run.status) {
    case "accepted":
      return record;
    case "completed":
    case "cancelled":
    case "failed":
    case "interrupted":
      record.result = {
        status: run.status,
        ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
        ...(run.error ? { error: run.error } : {}),
      };
      return record;
    default:
      throw new RepaFault(
        "invalid_run_record",
        "运行过程状态由后端持有，不作为受理或终态写入日志。",
      );
  }
}

export class RuntimeStore {
  readonly space: Space;
  readonly runs = new Map<string, Run>();
  readonly #directory: string;
  readonly #unlock: () => void;
  #compromised: Error | undefined;
  #released = false;

  constructor(directory: string, onCompromised: (error: Error) => void) {
    mkdirSync(directory, { recursive: true });
    directory = realpathSync(directory);
    this.#directory = managedDirectory(directory, "runtime");
    try {
      this.#unlock = lockfile.lockSync(this.#directory, {
        lockfilePath: path.join(this.#directory, "owner.lock"),
        onCompromised: (error) => {
          this.#compromised = error;
          onCompromised(error);
        },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED")
        throw new RepaFault(
          "space_in_use",
          "学习空间已由另一个后端占用，或中断后的锁尚未过期。请连接已有后端，或稍后重试。",
        );
      throw error;
    }
    try {
      const identity = path.join(this.#directory, "space.json");
      if (!existsSync(identity))
        writeFileSync(identity, JSON.stringify({ id: randomUUID() }) + "\n", {
          flag: "wx",
          mode: 0o600,
          flush: true,
        });
      const saved = JSON.parse(readFileSync(identity, "utf8"));
      if (
        typeof saved.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(saved.id)
      )
        throw new Error("学习空间身份记录无效。");
      this.space = { id: saved.id, path: directory };
      const journal = path.join(this.#directory, "runs.jsonl");
      for (const record of readRunJournal(journal, this.space.id)) {
        const run = currentRun(record);
        this.runs.set(run.id, run);
      }
      for (const run of this.runs.values()) {
        if (!isTerminal(run))
          this.saveRun({
            ...run,
            status: "interrupted",
            phase: "idle",
            finishedAt: Date.now(),
            error: {
              code: "interrupted",
              message:
                "此前后端进程已中断，操作结果需要核对；任务未自动重新执行。",
            },
          });
      }
    } catch (error) {
      this.release();
      throw error;
    }
  }

  assertOwned(): void {
    if (this.#released || this.#compromised)
      throw new RepaFault("space_lock_lost", "学习空间的独占访问已经结束。");
  }

  saveRun(run: Run): void {
    this.assertOwned();
    appendRunRecord(path.join(this.#directory, "runs.jsonl"), recordedRun(run));
    this.runs.set(run.id, structuredClone(run));
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    if (!this.#compromised) this.#unlock();
  }
}
