/**
 * 重放的对照：测试版 v0.1.0-test.1 留下的学习记录，在测试一侧按测试版当时的课直接重放（产品不读测试版的数据，见 fixtures/test1-readings.ts），
 * 在同一时刻读出的结果与测试版自己算出的相同。除了 17 个取数点，还对每个空间学习记录的每个前缀比较一次（prefixes.json.br）：
 * 每次只多一条事实，哪一条事实之后读数开始不同一目了然。数据与标准答案见 test/fixtures/test1/README.md；标准答案由测试版的代码算出，
 * 这里不通过时不改它。学生模型改成按知识点时，连同这份固定数据一起退役。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import { StructureIndex } from "../src/course-structure.js";
import type { Fact } from "../src/records-schema.js";
import { copySpace, PREFIX_LATER_MS, TEST1_PYTHON, TIME_ZONE, type PrefixReading, type Reading } from "./fixtures/test1-readings.js";

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

interface PrefixSpace {
  id: string;
  source: string;
  model: boolean;
  prefixes: PrefixReading[];
}
const prefixAnswers = JSON.parse(brotliDecompressSync(await readFile(path.join(FIXTURE, "prefixes.json.br"))).toString("utf8")) as {
  timeZone: string;
  laterMs: number;
  spaces: PrefixSpace[];
};

/** 在一个子进程里按清单读数：时区要在进程启动时定下。spaces 是每项要复制的空间目录与学习记录只留的行数。 */
async function readInChild<T>(spaces: { source: string; facts?: number }[], entry: (root: string, index: number) => object): Promise<T[]> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-test1-")));
  try {
    const list = [];
    for (const [index, space] of spaces.entries()) {
      const root = path.join(base, String(index), "home", "Repa", path.basename(space.source));
      await copySpace(space.source, root, space.facts);
      list.push(entry(root, index));
    }
    await writeFile(path.join(base, "cases.json"), JSON.stringify(list));
    const { stdout } = await run(process.execPath, ["--import", "tsx", "test/fixtures/test1-read.ts", path.join(base, "cases.json")], {
      cwd: PACKAGE, env: { ...process.env, TZ: TIME_ZONE }, maxBuffer: 256 * 1024 * 1024,
    });
    return JSON.parse(stdout) as T[];
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

/** 全部取数点在一个子进程里读完。 */
let readings: Promise<Map<string, Record<string, unknown>>> | undefined;
function readAll(): Promise<Map<string, Record<string, unknown>>> {
  readings ??= (async () => {
    const spaces = answers.cases.map((entry) => ({
      source: entry.snapshot === null ? path.join(FIXTURE, "home", "Repa", entry.space) : path.join(FIXTURE, "snapshots", entry.space, entry.snapshot),
      ...(entry.facts === null ? {} : { facts: entry.facts }),
    }));
    const results = await readInChild<Reading>(spaces, (root, index) => ({ root, at: answers.cases[index]?.at, model: answers.cases[index]?.model }));
    return new Map(answers.cases.map((entry, index) => [entry.id, results[index]?.meaning as Record<string, unknown>]));
  })();
  return readings;
}

/** 全部空间的逐前缀读数，也在一个子进程里读完。 */
let prefixReadings: Promise<Map<string, PrefixReading[]>> | undefined;
function readAllPrefixes(): Promise<Map<string, PrefixReading[]>> {
  prefixReadings ??= (async () => {
    const spaces = prefixAnswers.spaces.map((entry) => ({ source: path.join(FIXTURE, entry.source) }));
    const results = await readInChild<PrefixReading[]>(spaces, (root, index) => ({ root, model: prefixAnswers.spaces[index]?.model, prefixes: true }));
    return new Map(prefixAnswers.spaces.map((entry, index) => [entry.id, results[index] ?? []]));
  })();
  return prefixReadings;
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

/**
 * 取数点里插件一层的读数：做课的状态与设置。产品不再为测试版的数据打开插件，对照在测试一侧直接重放，没有这两项；
 * 它们与重放无关（学习记录不影响它们，逐前缀的读数本来就没有），比较时略去。
 */
const PLUGIN_LEVEL = new Set(["building", "autoExpand"]);

function comparable(field: string, value: unknown): unknown {
  const dropped = REWORDED[field];
  if (dropped === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !dropped.includes(key)));
}

/**
 * 两份读数是否相同。小数允许末位的出入：记忆量经指数函数算出，同一份 V8 在不同平台上的结果会差最后一位
 * （Windows 上 0.48574933424651034，Linux 上 0.4857493342465103），这不是读数变了。整数、字符串、结构必须完全相同。
 */
function sameReading(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "number" && typeof expected === "number") {
    if (Number.isInteger(actual) || Number.isInteger(expected)) return actual === expected;
    return Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(actual), Math.abs(expected));
  }
  if (actual === null || expected === null || typeof actual !== "object" || typeof expected !== "object") return actual === expected;
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  const left = Object.keys(actual), right = Object.keys(expected);
  return left.length === right.length && left.every((key) => Object.hasOwn(expected, key)
    && sameReading((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key]));
}

test("标准答案取数时的时区与现在取数的时区相同", () => {
  assert.equal(answers.timeZone, TIME_ZONE);
});

for (const entry of answers.cases) {
  test(`测试版数据 ${entry.id}（${entry.why}，${entry.atLocal}）：现在的代码读出的各项与测试版相同`, async (t) => {
    const reading = (await readAll()).get(entry.id);
    assert.ok(reading);
    for (const [field, expected] of Object.entries(entry.reading)) {
      if (PLUGIN_LEVEL.has(field)) continue;
      await t.test(field, () => {
        const actual = comparable(field, reading[field]);
        const wanted = comparable(field, expected);
        if (!sameReading(actual, wanted)) assert.deepEqual(actual, wanted);
      });
    }
    assert.deepEqual(Object.keys(reading).sort(), Object.keys(entry.reading).filter((field) => !PLUGIN_LEVEL.has(field)).sort());
  });
}

test("逐前缀的标准答案与现在取数用的时区、能力和间隔相同", () => {
  assert.equal(prefixAnswers.timeZone, TIME_ZONE);
  assert.equal(prefixAnswers.laterMs, PREFIX_LATER_MS);
});

/**
 * 测试版读不出状态的前缀：丁用换用后的自制课读换课前的前缀时，Python 的课停在自制课里没有的知识点上，测试版的 state.get 整个失败。
 * 现在画面退回到说明页，学习者可以中止（有意的改变，见设计记录 2026-11-18-self-contained-records）。这些读数不与报错比较，
 * 只核对现在读得出、当前任务停在讲解或例题页；其余前缀照常逐项比较。
 */
const UNREADABLE_IN_TEST1: Record<string, number> = { d: 12 };

for (const space of prefixAnswers.spaces) {
  test(`测试版数据 ${space.source} 的每个前缀（0 到 ${space.prefixes.length - 1} 条事实，各在最后一条事实时与 25 小时后）：现在的代码读出的各项与测试版相同`, async () => {
    const actual = (await readAllPrefixes()).get(space.id) ?? [];
    assert.equal(actual.length, space.prefixes.length);
    // 逐项比较全部前缀，报出最早不同的那一处和不同的总数：最早的那一处之前的事实都读得相同，问题出在它这一条事实上。
    const differences: { facts: number; clock: "at" | "later"; field: string; actual: unknown; expected: unknown }[] = [];
    let unreadable = 0;
    for (const [index, expected] of space.prefixes.entries()) {
      for (const clock of ["at", "later"] as const) {
        const got = actual[index]?.[clock] ?? {};
        const want = expected[clock];
        if (want.error !== undefined) {
          unreadable++;
          const stage = (got.currentTask as { stage?: string } | null | undefined)?.stage;
          assert.ok(got.error === undefined && (stage === "explanation" || stage === "example"), `${expected.facts} 条/${clock}：${JSON.stringify(got.error ?? stage)}`);
          continue;
        }
        for (const field of new Set([...Object.keys(got), ...Object.keys(want)])) {
          const left = comparable(field, got[field]);
          const right = comparable(field, want[field]);
          if (!sameReading(left, right)) differences.push({ facts: expected.facts, clock, field, actual: left, expected: right });
        }
      }
    }
    assert.equal(unreadable, UNREADABLE_IN_TEST1[space.id] ?? 0, "测试版读不出状态的读数个数");
    const first = differences[0];
    if (first) {
      const where = differences.slice(0, 10).map((entry) => `${entry.facts} 条/${entry.clock}/${entry.field}`).join("，");
      assert.deepEqual(first.actual, first.expected, `共 ${differences.length} 处不同，最早的几处：${where}`);
    }
  });
}

test("同一笔合法的补判（乙第二天补判开放题）：补判前后的读数与测试版收到这笔补判前后的读数相同，变化也就相同", async () => {
  const source = path.join(FIXTURE, "home", "Repa", "操作系统 复习");
  const lines = (await readFile(path.join(source, ".repa", "plugins", "learning", "records.jsonl"), "utf8")).split("\n").filter(Boolean);
  const regrade = lines[46];
  assert.ok(regrade && (JSON.parse(regrade) as { type: string }).type === "graded");
  // 经插件方法的取法会触发后台补判：有模型时假模型判不了，这份作答显示为判分失败；逐前缀的标准答案直接取会话的 view，不触发补判。
  // 不给模型时两种取法读到的相同。
  const at = (count: number) => (JSON.parse(lines[count - 1] ?? "{}") as Fact).at;
  const result = await readInChild<Reading>([{ source, facts: 46 }, { source, facts: 47 }], (root, index) => ({ root, model: false, at: at(46 + index) }));
  const expected = prefixAnswers.spaces.find((entry) => entry.id === "b")?.prefixes;
  assert.ok(expected);
  // 这笔补判确实改变了读数：第二天补发 12 XP。
  assert.notDeepEqual(expected[46]?.at.awards, expected[47]?.at.awards);
  for (const [reading, prefix] of [[result[0], expected[46]], [result[1], expected[47]]] as const) {
    assert.ok(reading && prefix);
    for (const [field, want] of Object.entries(prefix.at)) {
      const got = comparable(field, (reading.meaning as Record<string, unknown>)[field]);
      if (!sameReading(got, comparable(field, want))) assert.deepEqual(got, comparable(field, want), `${prefix.facts} 条/${field}`);
    }
  }
});

test("冻结的测试版随包课结构没有被改动：摘要与生成时记下的相同，测试版数据里出过的 Python 题都在其中", async () => {
  // Windows 上检出时换行可能变成 CRLF，内容没变：摘要按 LF 的文本算，与生成时记下的一致。
  const text = (await readFile(TEST1_PYTHON, "utf8")).replaceAll("\r\n", "\n");
  assert.equal(createHash("sha256").update(text).digest("hex"), "2789be368efad2f4f28faa05be4a589381961d9140f8db734f43aaaf79ab5906");
  const index = new StructureIndex(JSON.parse(text));
  for (const source of ["home/Repa/Python 入门", "home/Repa/Python 测验"]) {
    const facts = (await readFile(path.join(FIXTURE, source, ".repa", "plugins", "learning", "records.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Fact);
    for (const fact of facts) if (fact.type === "delivered") assert.ok(index.questions.has(fact.question), fact.question);
  }
});
