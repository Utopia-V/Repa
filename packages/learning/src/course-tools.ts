/**
 * 给通用 Agent 做课用的两项工具：course_check 检查空间里的 course/，course_use 检查通过后让学习换用它。
 * 写课的说明随包附带，插件的提示说明指过去；工具输出写成分行文字，做课的 Agent 照着改课。
 */

import { fileURLToPath } from "node:url";

import type { Tool } from "@repa/base/plugin";
import { object, parse } from "@repa/base/protocol";
import { Type } from "typebox";

import { formatDiagnostic } from "./format/diagnostics.js";
import { SPACE_COURSE, type CourseCheck } from "./space-course.js";

/** 写课的说明：随包附带，通用 Agent 用 read 读取（read 可以读空间之外的文件）。src 与 dist 到包根目录的距离相同。 */
export const COURSE_GUIDE = fileURLToPath(new URL("../guides/making-courses.md", import.meta.url));

/** 一页最多列几处问题。一处约一两行，40 处在模型一次读得完的量之内。 */
export const CHECK_PAGE = 40;

const CheckParametersSchema = object({
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "从第几处问题开始列，默认 0；上一页的末尾会写明下一页的 offset" })),
});
const UseParametersSchema = object({});

/** 插件给工具的入口：读 course/、检查、换用，以及学习者现在学的是哪一份。 */
export interface CourseActions {
  /** 检查 course/；没有 course/ 时为 undefined。 */
  check(): Promise<CourseCheck | undefined>;
  /** 检查 course/，通过而且不打乱学习者做到一半的任务时换用。没有 course/ 时为 undefined。 */
  use(): Promise<{ checked: CourseCheck; outcome: "unchanged" | "busy" | "switched" } | undefined>;
  /** 学习者现在学的是哪一份、学过哪些部分、后台是否正在展开，一句话。 */
  status(): Promise<string>;
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
    lines.push("课里没有要运行 Python 的题，没有启动沙箱。");
  } else if (summary.ran) {
    lines.push(`在沙箱里运行了 verify 核对程序 ${summary.code.verifyJobs} 段、测试 ${summary.code.testRuns} 次。`);
  } else {
    lines.push("课里要运行 Python 的部分（verify、代码题、带 tests 的排列题）没有运行，也就没有核对，原因见下面的错误。");
  }
  if (summary.confirmationSlots.length > 0) {
    lines.push(`复习和测验题里有 ${summary.confirmationSlots.length} 个作答位列在 manual 里，没有经过独立核对：它们的答案对不对，只能靠你对照材料确认。`);
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

/** 做课的两项工具，只给通用 Agent：学习辅导 Agent 的工具清单里没有它们。 */
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
        + "学习者正在做的任务用到的部分改了也不换。",
      parameters: UseParametersSchema,
      async execute(raw) {
        parse(UseParametersSchema, raw);
        const used = await actions.use();
        if (!used) return { text: NO_COURSE };
        const { checked, outcome } = used;
        if (!checked.passed) {
          return { text: `没有换用。${checkText(checked)}\n\n学习者现在学的：${await actions.status()}` };
        }
        const head = {
          unchanged: "这一版与学习者正在学的相同，没有变化。",
          switched: "已换用：学习者现在学的是这一版。",
          busy: "检查通过，但没有换用：学习者正在做的任务（课、复习或测验）用到的部分在这一版里改了，换用会打乱它。"
            + "等他做完再运行 course_use；只增加部分、不改他正在学的部分时，可以立即换用。",
        }[outcome];
        return { text: `${head}\n${checkText(checked)}` };
      },
    },
  ];
}
