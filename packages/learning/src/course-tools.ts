/**
 * 给通用 Agent 做课用的四项工具：course_check 检查空间里的 course/，course_confirm 让另一次模型调用不看答案重做题目，
 * course_use 检查通过、题目都核对过以后让学习换用它，
 * course_brief 写出要展开的部分的轮廓和学习者在它们之前学到的概念（后台展开的任务里也是这一段）。
 * 写课的说明随包附带，插件的提示说明指过去；工具输出写成分行文字，做课的 Agent 照着改课。
 */

import { fileURLToPath } from "node:url";

import type { Tool } from "@repa/base/plugin";
import { object, parse } from "@repa/base/protocol";
import { Type } from "typebox";

import type { ConfirmOutcome, ConfirmResult } from "./check/confirm.js";
import { formatDiagnostic } from "./format/diagnostics.js";
import { SPACE_COURSE, type CourseCheck } from "./space-course.js";

/** 写课的说明：随包附带，通用 Agent 用 read 读取（read 可以读空间之外的文件）。src 与 dist 到包根目录的距离相同。 */
export const COURSE_GUIDE = fileURLToPath(new URL("../guides/making-courses.md", import.meta.url));
/** 说明里引用的示例课。路径直接写给模型：只说“同一目录下”时，模型曾把它拼到包的根目录下，读不到以后再去列目录。 */
export const COURSE_EXAMPLE = fileURLToPath(new URL("../guides/example-course", import.meta.url));

/** 一页最多列几处问题。一处约一两行，40 处在模型一次读得完的量之内。 */
export const CHECK_PAGE = 40;

const CheckParametersSchema = object({
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "从第几处问题开始列，默认 0；上一页的末尾会写明下一页的 offset" })),
});
const UseParametersSchema = object({});
const BriefParametersSchema = object({
  topicIds: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 8, description: "要展开的 topic id，按要写的先后" }),
});
const ConfirmParametersSchema = object({
  topicIds: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 8, description: "要核对的 topic id" }),
});

/**
 * course_confirm 一次最多发的请求数（含输出不合格式时的重试）。一个展开的 topic 有二三十道要核对的题，
 * 100 次够核对三四个 topic；超出的题如实列为没有核对，再调用一次接着核对。用 flash 一类的模型约 0.05 美元。Repa 的假设。
 */
export const CONFIRM_REQUESTS = 100;
/** 同时等回答的请求数。请求互不相干；8 个让一个 topic 在十几秒内核对完，又不容易撞上提供方的并发限制。Repa 的假设。 */
export const CONFIRM_CONCURRENCY = 8;
/** course_use 不换用时列出的缺记录的题最多几道，其余只给总数。 */
const MISSING_PAGE = 40;

/** 插件给工具的入口：读 course/、检查、核对、换用，以及学习者现在学的是哪一份。 */
export interface CourseActions {
  /** 检查 course/；没有 course/ 时为 undefined。 */
  check(): Promise<CourseCheck | undefined>;
  /**
   * 检查 course/，通过、每道由程序判分的题都有当前核对记录，而且不打乱学习者做到一半的任务时换用。
   * unconfirmed：检查通过，但有题缺核对记录，没有换用。没有 course/ 时为 undefined。
   */
  use(): Promise<{ checked: CourseCheck; outcome: "unchanged" | "busy" | "switched" | "unconfirmed" } | undefined>;
  /** 对这几个 topic 里缺当前记录的题做模型核对，一致的记下；signal 是这次工具调用的取消信号。没有 course/ 时为 undefined。 */
  confirm(topicIds: string[], signal: AbortSignal): Promise<ConfirmResult | undefined>;
  /** 学习者现在学的是哪一份、学过哪些部分、后台是否正在展开，一句话。 */
  status(): Promise<string>;
  /** 这几部分的轮廓和学习者在它们之前学到的概念，按学习者现在学的那一份算。 */
  brief(topicIds: string[]): Promise<string>;
}

const NO_COURSE = `空间里没有 ${SPACE_COURSE}/ 文件夹。做课的格式与顺序见 ${COURSE_GUIDE}。`;

/** 一次检查的结果：统计、没有运行或没有核对的部分，以及从 offset 起的一页问题。 */
export function checkText(checked: CourseCheck, offset = 0): string {
  const { result } = checked;
  const { summary, diagnostics } = result;
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const lines: string[] = [];
  const course = summary.course ? `课程 ${summary.course.id} ${summary.course.version}，` : "";
  const counts = `完整 topic ${summary.topics.complete} 个、骨架 ${summary.topics.outline} 个，题目 ${summary.questions} 道`;
  lines.push(checked.passed
    ? `${SPACE_COURSE}/ 通过检查：${course}${counts}${warnings > 0 ? `；提醒 ${warnings} 处` : ""}。`
    : `${SPACE_COURSE}/ 没有通过检查：错误 ${errors} 处${warnings > 0 ? `、提醒 ${warnings} 处` : ""}。${summary.course ? `${course}${counts}。` : ""}`);
  if (!summary.course) {
    // 清单读不出来时还不知道课里有没有要运行 Python 的题，不下结论。
  } else if (!summary.python) {
    lines.push("课里没有要运行 Python 的题，没有运行 Python。");
  } else if (summary.ran) {
    lines.push(`在${summary.where === "frontend" ? "应用页面的 Worker 里" : " Linux 沙箱里"}运行了 verify 核对程序 ${summary.code.verifyJobs} 段、测试 ${summary.code.testRuns} 次。`);
  } else {
    lines.push("课里要运行 Python 的部分（verify、代码题、带 tests 的排列题）没有运行，也就没有核对，原因见下面的错误。");
  }
  const { confirmations } = summary;
  if (confirmations.missing.length > 0) {
    lines.push(`由程序判分的题 ${confirmations.questions} 道，其中 ${confirmations.missing.length} 道还没有当前的核对记录：用 course_confirm 核对，没有核对完的课 course_use 不换用。`);
  } else if (confirmations.questions > 0) {
    lines.push(`由程序判分的题 ${confirmations.questions} 道都有当前的核对记录。`);
  }
  if (diagnostics.length > 0) {
    const page = diagnostics.slice(offset, offset + CHECK_PAGE);
    const end = offset + page.length;
    lines.push("");
    if (page.length === 0) {
      lines.push(`共 ${diagnostics.length} 处问题，offset ${offset} 之后没有了。`);
    } else {
      lines.push(`第 ${offset + 1}–${end} 处（共 ${diagnostics.length} 处）：`);
      for (const diagnostic of page) lines.push(formatDiagnostic(diagnostic));
      if (end < diagnostics.length) lines.push(`还有 ${diagnostics.length - end} 处，用 course_check 加 offset: ${end} 接着看。`);
    }
  }
  return lines.join("\n");
}

/** 课里缺当前核对记录的题：前 MISSING_PAGE 道和总数，以及要核对的 topic。 */
function missingText(checked: CourseCheck): string {
  const { missing } = checked.result.summary.confirmations;
  const shown = missing.slice(0, MISSING_PAGE).map((entry) => entry.question).join("、");
  const rest = missing.length > MISSING_PAGE ? `，还有 ${missing.length - MISSING_PAGE} 道` : "";
  const topics = [...new Set(missing.map((entry) => entry.topic))].join("、");
  return `没有换用：${missing.length} 道题还没有当前的核对记录（${shown}${rest}）。`
    + `用 course_confirm 核对 ${topics}，改到没有不一致，再运行 course_use。`;
}

/** 写成一行的值，太长的截断。 */
function shown(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function unfinishedReason(outcome: ConfirmOutcome): string {
  switch (outcome.status) {
    case "unusable":
      return `模型两次的输出都不合格式：${outcome.detail ?? ""}`;
    case "failed":
      return `请求失败：${outcome.detail ?? ""}`;
    default:
      return outcome.detail ?? "没有发请求";
  }
}

/** 一次核对的结果：没有通过的题逐道列出（编号、模型的作答、标准答案、模型的说明），全部一致时一句话。 */
export function confirmText(result: ConfirmResult, topicIds: string[]): string {
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    return `${SPACE_COURSE}/ 读不出来，没有核对：${errors.slice(0, 5).map(formatDiagnostic).join("；")}。先用 course_check 改到通过。`;
  }
  const { outcomes } = result;
  const lines: string[] = [];
  const empty = topicIds.filter((id) => !outcomes.some((outcome) => outcome.topic === id));
  if (empty.length > 0) lines.push(`${empty.join("、")} 里没有要核对的题（还是轮廓，或不在课里）。`);
  const current = outcomes.filter((outcome) => outcome.status === "current").length;
  const confirmed = outcomes.filter((outcome) => outcome.status === "confirmed").length;
  const failing = outcomes.filter((outcome) => outcome.status !== "current" && outcome.status !== "confirmed");
  if (outcomes.length > 0) {
    lines.push(`要核对的题 ${outcomes.length} 道：已有当前记录 ${current} 道；这次发请求 ${result.requests} 次，一致并已记下 ${confirmed} 道`
      + `${failing.length === 0 ? "，全部一致。" : `，没有通过 ${failing.length} 道。`}`);
  }
  const disagreed = failing.filter((outcome) => outcome.status === "disagreed");
  if (disagreed.length > 0) {
    lines.push("", "与标准答案不一致的题（独立作答的一方只看了讲解和题面）：");
    for (const outcome of disagreed) {
      const slots = (outcome.differences ?? []).map((difference) => `${difference.slot} 作答 ${shown(difference.model)}，标准答案 ${shown(difference.key)}`);
      lines.push(`- ${outcome.question}：${slots.join("；")}${outcome.note ? `。说明：${outcome.note}` : ""}`);
    }
  }
  const noted = failing.filter((outcome) => outcome.status === "noted");
  if (noted.length > 0) {
    lines.push("", "作答与标准答案一致，但独立作答的一方指出题目有问题（没有记录）：");
    for (const outcome of noted) lines.push(`- ${outcome.question}：${outcome.note ?? ""}`);
  }
  const unfinished = failing.filter((outcome) => outcome.status !== "disagreed" && outcome.status !== "noted");
  if (unfinished.length > 0) {
    lines.push("", "没有核对成的题（没有记录；再运行 course_confirm 只会核对还没有记录的题）：");
    for (const outcome of unfinished) lines.push(`- ${outcome.question}：${unfinishedReason(outcome)}`);
  }
  return lines.join("\n");
}

/** 做课的四项工具，只给通用 Agent：学习辅导 Agent 的工具清单里没有它们。 */
export function courseTools(actions: CourseActions): Tool[] {
  return [
    {
      name: "course_check",
      description: `检查空间里 ${SPACE_COURSE}/ 的课：逐处列出哪个文件、哪一行、错在哪里、怎样改，错误多时分页。只检查，不改变学习者在学的课。`,
      parameters: CheckParametersSchema,
      async execute(raw) {
        const { offset = 0 } = parse(CheckParametersSchema, raw);
        const checked = await actions.check();
        if (!checked) return { text: NO_COURSE };
        return { text: `${checkText(checked, offset)}\n\n学习者现在学的：${await actions.status()}` };
      },
    },
    {
      name: "course_use",
      description: `检查空间里 ${SPACE_COURSE}/ 的课，通过以后让学习者改学这一版；没通过就不换，学习者学的仍是上一次换用的那一版。`
        + "有题还没有当前的核对记录（course_confirm）时不换；学习者正在做一项任务时，这一版改了展开过的部分也不换。",
      parameters: UseParametersSchema,
      async execute(raw) {
        parse(UseParametersSchema, raw);
        const used = await actions.use();
        if (!used) return { text: NO_COURSE };
        const { checked, outcome } = used;
        if (!checked.passed) {
          return { text: `没有换用。${checkText(checked)}\n\n学习者现在学的：${await actions.status()}` };
        }
        if (outcome === "unconfirmed") {
          return { text: `${missingText(checked)}\n${checkText(checked)}\n\n学习者现在学的：${await actions.status()}` };
        }
        const head = {
          unchanged: "这一版与学习者正在学的相同，没有变化。",
          switched: "已换用：学习者现在学的是这一版。",
          busy: "检查通过，但没有换用：学习者正在做一项任务（课、复习或测验），而这一版改了展开过的部分，换用会打乱它。"
            + "等他做完再运行 course_use；只展开轮廓、增加部分而不改展开过的部分时，可以立即换用。",
        }[outcome];
        return { text: `${head}\n${checkText(checked)}\n\n学习者现在学的：${await actions.status()}` };
      },
    },
    {
      name: "course_confirm",
      description: "让另一次模型调用只看讲解和题面、不看答案，把这几个 topic 里由程序判分的题各做一遍，与标准答案比对；"
        + "一致的记在 topic 文件末尾的 verified 段（不要手改这一段），已有当前记录的题不再做。交回不一致的题（模型的作答、标准答案和它对题目的说明），以及答案一致而它指出题目有问题的题，这两种都不记录。"
        + `course_check 通过以后用；每次最多发 ${CONFIRM_REQUESTS} 个请求，会花模型的费用。`,
      parameters: ConfirmParametersSchema,
      async execute(raw, context) {
        const { topicIds } = parse(ConfirmParametersSchema, raw);
        const result = await actions.confirm(topicIds, context.signal);
        if (!result) return { text: NO_COURSE };
        return { text: confirmText(result, topicIds) };
      },
    },
    {
      name: "course_brief",
      description: "写出要展开的几部分的轮廓（范围、出处、直接先修）和学习者在它们之前学到的概念，按学习者现在学的这一版课算。"
        + "前面已有展开过的部分时，展开之前先用它，讲解里就知道哪些术语可以直接用、哪些要先说清。",
      parameters: BriefParametersSchema,
      async execute(raw) {
        const { topicIds } = parse(BriefParametersSchema, raw);
        return { text: await actions.brief(topicIds) };
      },
    },
  ];
}
