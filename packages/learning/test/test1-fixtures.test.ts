/**
 * 测试版 v0.1.0-test.1 留下的学习数据，现在的代码打开以后，在同一时刻读出的结果与测试版自己算出的相同。
 * 数据与标准答案见 test/fixtures/test1/README.md；标准答案由测试版的代码算出，这里不通过时不改它。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { copySpace, TIME_ZONE, type Reading } from "./fixtures/test1-readings.js";

const run = promisify(execFile);
const FIXTURE = fileURLToPath(new URL("./fixtures/test1/", import.meta.url));
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

interface Case {
  id: string;
  why: string;
  space: string;
  snapshot: string | null;
  facts: number | null;
  model: boolean;
  at: number;
  atLocal: string;
  reading: Record<string, unknown>;
}
const answers = JSON.parse(await readFile(path.join(FIXTURE, "answers.json"), "utf8")) as { timeZone: string; cases: Case[] };

/** 全部取数点在一个子进程里读完：时区要在进程启动时定下。 */
let readings: Promise<Map<string, Record<string, unknown>>> | undefined;
function readAll(): Promise<Map<string, Record<string, unknown>>> {
  readings ??= (async () => {
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-test1-")));
    try {
      const list = [];
      for (const entry of answers.cases) {
        const root = path.join(base, entry.id, "home", "Repa", entry.space);
        const source = entry.snapshot === null ? path.join(FIXTURE, "home", "Repa", entry.space) : path.join(FIXTURE, "snapshots", entry.space, entry.snapshot);
        await copySpace(source, root, entry.facts ?? undefined);
        list.push({ root, at: entry.at, model: entry.model });
      }
      await writeFile(path.join(base, "cases.json"), JSON.stringify(list));
      const { stdout } = await run(process.execPath, ["--import", "tsx", "test/fixtures/test1-read.ts", path.join(base, "cases.json")], {
        cwd: PACKAGE, env: { ...process.env, TZ: TIME_ZONE }, maxBuffer: 64 * 1024 * 1024,
      });
      const results = JSON.parse(stdout) as Reading[];
      return new Map(answers.cases.map((entry, index) => [entry.id, results[index]?.meaning as Record<string, unknown>]));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  })();
  return readings;
}

/**
 * 测试版之后有意改写的说明文字，不属于学习的含义，比较时两边都去掉。每一项写明是哪次改动、改成了什么；
 * 只收给学习者看的文字，结论、时刻、XP、学生模型这类读数不得列在这里。
 */
const REWORDED: Record<string, readonly string[]> = {
  // #173：菜单为空时的说明改由界面给出，插件不再产生这句话。
  menu: ["unavailableReason"],
  // #173：学习者自己中止时不再附理由，界面只显示“已中止。”。
  currentTask: ["abortReason"],
};

function comparable(field: string, value: unknown): unknown {
  const dropped = REWORDED[field];
  if (dropped === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !dropped.includes(key)));
}

test("标准答案取数时的时区与现在取数的时区相同", () => {
  assert.equal(answers.timeZone, TIME_ZONE);
});

for (const entry of answers.cases) {
  test(`测试版数据 ${entry.id}（${entry.why}，${entry.atLocal}）：现在的代码读出的各项与测试版相同`, async (t) => {
    const reading = (await readAll()).get(entry.id);
    assert.ok(reading);
    for (const [field, expected] of Object.entries(entry.reading)) {
      await t.test(field, () => {
        assert.deepEqual(comparable(field, reading[field]), comparable(field, expected));
      });
    }
    assert.deepEqual(Object.keys(reading).sort(), Object.keys(entry.reading).sort());
  });
}
