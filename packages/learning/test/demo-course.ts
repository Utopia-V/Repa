/**
 * 测试用的小课程：一个完整 topic、一个骨架 topic，覆盖五种作答位、程序核对、代码测试、Parsons 和 WWPD。
 * 每个测试取一份新的对象，改掉要检查的那一处，再写进临时目录。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

import { describeRuntime, PythonSandbox, SandboxUnavailable, verifyPackages } from "@repa/python-runner";
import { stringify } from "yaml";

import type { Course, Question, Topic } from "../src/format/schema.js";

export const RUNTIME = { pyodide: "314.0.7", python: "3.14.2", packages: { numpy: "2.4.6", pandas: "3.0.2" } };

export interface DemoCourse {
  course: Course;
  topics: Record<string, Topic>;
}

function predict(id: string, code: string, output: number): Question {
  return {
    id,
    kind: ["predict"],
    body: `程序显示什么？\n\n\`\`\`python\n${code}\n\`\`\``,
    slots: [{ id: "output", type: "text", format: "integer", key: output }],
    explanation: `显示 ${output}。`,
    verify: 'answers = {"output": int(run().out)}',
  };
}

export function demoCourse(): DemoCourse {
  const course: Course = {
    id: "demo",
    version: "0.1.0",
    title: "示例课程",
    language: "zh-CN",
    license: "NOASSERTION",
    runtime: structuredClone(RUNTIME),
    sources: {
      open: { title: "开放教材", url: "https://example.org/open", version: "第 1 版", license: "CC BY 4.0", permits: ["reference", "adapt", "code"] },
      closed: { title: "只能链接的教材", url: "https://example.org/closed", version: "第 1 版", license: "保留所有权利", permits: ["reference"] },
    },
    topics: ["t01", "t02"],
  };
  const t01: Topic = {
    id: "t01",
    title: "完整的示例",
    status: "complete",
    minutes: 20,
    prerequisites: [],
    sources: [{ source: "open", where: "第 1 章", use: "reference" }],
    data: {
      nums: { kind: "dataframe", name: "nums", index: ["a", "b", "c"], columns: { value: [3, 8, 5] } },
    },
    kps: [
      {
        id: "t01.k1",
        title: "赋值先算右边",
        card: {
          name: "赋值",
          definition: "先算出右边的值，再让左边的名字指向它。",
          conditions: ["赋值本身不显示任何东西。"],
          example: { from: "t01.k1.e0", text: "`x = 2` 之后 `x + 1` 是 3。" },
        },
        lesson: "赋值先算右边，再起名。和[重新赋值](repa:concept/t01.k2)一起看。",
        example: predict("t01.k1.e0", "x = 2\nprint(x + 1)", 3),
        practice: [
          predict("t01.k1.q1", "a = 4\nprint(a - 1)", 3),
          predict("t01.k1.q2", "b = 5\nb = b + 1\nprint(b)", 6),
          {
            id: "t01.k1.q3",
            kind: ["explain"],
            body: "哪一行写出“比 raw 少 2”？",
            slots: [{
              id: "line",
              type: "choice",
              options: [
                { id: "minus", content: "```python\nleft = raw - 2\n```" },
                { id: "plus", content: "```python\nleft = raw + 2\n```", feedback: "应当减去。" },
              ],
              key: "minus",
            }],
            explanation: "`raw - 2`。",
            verify: 'answers = {"line": next(k for k, code in OPTIONS["line"].items() if run(code, raw=9)["left"] == 7)}',
          },
        ],
        review: [predict("t01.k1.r1", "c = 10\nprint(c - 4)", 6)],
        quiz: [predict("t01.k1.x1", "d = 1\nd = d + d\nprint(d)", 2)],
      },
      {
        id: "t01.k2",
        title: "读表、写代码、排代码",
        card: {
          name: "重新赋值",
          definition: "名字可以改指向新的值。",
          conditions: ["先前算出的值不会跟着变。"],
          example: { from: "t01.k2.e0", text: "见例题。" },
        },
        lesson: "逐行记下每个名字的值。",
        example: {
          id: "t01.k2.e0",
          data: ["nums"],
          body: "```python\nmask = nums[\"value\"] > 4\n```",
          slots: [{
            id: "mask",
            type: "table",
            columns: [{ id: "label", header: "索引" }, { id: "mask", header: "mask", input: "bool" }],
            rows: [
              { id: "ra", cells: { label: "a", mask: false } },
              { id: "rb", cells: { label: "b", mask: true } },
              { id: "rc", cells: { label: "c", mask: true } },
            ],
          }],
          explanation: "False、True、True。",
          verify: 'r = run()\nanswers = {"mask": {f"r{label}": {"mask": value} for label, value in r["mask"].items()}}',
        },
        practice: [
          {
            id: "t01.k2.q1",
            kind: ["modify"],
            body: "补全函数 `double`，让它返回 x 的两倍。",
            slots: [{
              id: "code",
              type: "code",
              language: "python",
              starter: 'def double(x):\n    """\n    >>> double(2)\n    4\n    """\n    return ____\n',
              solution: "def double(x):\n    return x * 2\n",
              accepts: ["def double(x):\n    return x + x\n"],
              rejects: [
                { code: "def double(x):\n    return x * 3\n", why: "乘错了倍数" },
                { code: "def double(x):\n    return 4\n", why: "照着例子写死了答案" },
              ],
              tests: [
                { name: "公开例子", doctest: ">>> double(2)\n4" },
                { name: "更多输入", hidden: true, expect: { "double(5)": "10", "double(-1)": "-2" } },
                { name: "定义函数时不打印", hidden: true, stdout: "" },
              ],
            }],
            explanation: "`return x * 2`。",
          },
          {
            id: "t01.k2.q2",
            kind: ["modify"],
            body: "把代码块排成函数 `count_high(values, limit)`，返回不小于 limit 的个数。有一块用不到。",
            slots: [{
              id: "lines",
              type: "order",
              partial: true,
              indent: 3,
              items: [
                { id: "b1", code: "def count_high(values, limit):" },
                { id: "b2", code: "count = 0" },
                { id: "b3", code: "for v in values:" },
                { id: "b4", code: "if v >= limit:" },
                { id: "b5", code: "count = count + 1" },
                { id: "b6", code: "return count" },
                { id: "b7", code: "if v > limit:" },
              ],
              key: ["b1", "b2", "b3", "b4", "b5", "b6"],
              indents: { b1: 0, b2: 1, b3: 1, b4: 2, b5: 3, b6: 1, b7: 2 },
              tests: [
                { name: "公开例子", expect: { "count_high([1, 5, 7], 5)": "2" } },
                { name: "空列表", hidden: true, expect: { "count_high([], 3)": "0" } },
              ],
            }],
            explanation: "初始化、循环、判断、累加、返回。",
          },
          {
            id: "t01.k2.q3",
            kind: ["predict"],
            body: "依次输入下面每一行，Python 会显示什么？\n\n```python\nx = [1, 2]\ny = x\ny.append(3)\nx\nlen\n```",
            slots: [{
              id: "session",
              type: "table",
              columns: [
                { id: "line", header: "输入" },
                { id: "shown", header: "显示", input: { type: "text", match: "output", quick: ["NOTHING", "ERROR", "FUNCTION"] } },
              ],
              rows: [
                { id: "l1", cells: { line: "`x = [1, 2]`", shown: "NOTHING" } },
                { id: "l2", cells: { line: "`y = x`", shown: "NOTHING" } },
                { id: "l3", cells: { line: "`y.append(3)`", shown: "NOTHING" } },
                { id: "l4", cells: { line: "`x`", shown: "[1, 2, 3]" } },
                { id: "l5", cells: { line: "`len`", shown: "FUNCTION" } },
              ],
            }],
            explanation: "x 和 y 指向同一个列表。",
            verify: 'answers = {"session": {f"l{i}": {"shown": text} for i, text in enumerate(repl(), 1)}}',
          },
        ],
        review: [{
          id: "t01.k2.r1",
          data: ["nums"],
          body: "保留 value 至少为 5 的行。",
          slots: [
            { id: "rows", type: "order", partial: true, items: [{ id: "a", content: "a" }, { id: "b", content: "b" }, { id: "c", content: "c" }], key: ["b", "c"] },
            {
              id: "equal", type: "choice", multiple: true, minSelected: 0, scoring: "options",
              options: [{ id: "a", content: "a" }, { id: "b", content: "b" }, { id: "c", content: "c" }], key: ["c"],
            },
          ],
          explanation: "b、c；恰好等于 5 的是 c。",
          verify: 'answers = {"rows": list(nums.index[nums["value"] >= 5]), "equal": list(nums.index[nums["value"] == 5])}',
        }],
        quiz: [predict("t01.k2.x1", "e = 3\nf = e\ne = 0\nprint(f)", 3)],
      },
    ],
  };
  const t02: Topic = {
    id: "t02",
    title: "骨架示例",
    status: "outline",
    minutes: 20,
    prerequisites: ["t01"],
    sources: [{ source: "closed", where: "第 2 章", use: "reference" }],
    kps: [{ id: "t02.k1", title: "第一个知识点" }, { id: "t02.k2", title: "第二个知识点" }],
  };
  return { course, topics: { t01, t02 } };
}

/** 把课程写进临时目录，测试结束时删除。 */
export async function writeCourse(t: TestContext, demo: DemoCourse): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-learning-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "topics"));
  await writeFile(path.join(root, "course.yaml"), stringify(demo.course, { lineWidth: 0 }));
  for (const [id, topic] of Object.entries(demo.topics)) {
    await writeFile(path.join(root, "topics", `${id}.yaml`), stringify(topic, { lineWidth: 0 }));
  }
  return root;
}

let readiness: Promise<string | undefined> | undefined;

/** 运行时没有准备好或这台机器建不了沙箱时返回原因，需要 Pyodide 的测试据此跳过。 */
export function runtimeUnavailable(): Promise<string | undefined> {
  // 课程核对用的 Node 沙箱依赖 Landlock 与 seccomp，只在 Linux 上可用。
  if (process.platform !== "linux") return Promise.resolve("Linux 沙箱只在 Linux 上可用");
  readiness ??= (async () => {
    try {
      const assets = await describeRuntime(RUNTIME);
      await verifyPackages(assets);
      const { sandbox } = await PythonSandbox.start({ assets });
      await sandbox.close();
      return undefined;
    } catch (error) {
      if (error instanceof SandboxUnavailable || (error instanceof Error && error.name === "RuntimeProblem")) return error.message;
      throw error;
    }
  })();
  return readiness;
}
