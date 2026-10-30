/**
 * 辅导交给模型的文字：当前任务、搜索结果、读到的内容和视图，写成分行文字。
 *
 * 只写模型讲题要用的内容：题面、学习者的作答、判分结果和题解。任务、交付和提交的编号与前端用的字段名都不写，
 * 选项和排列块按学习者看到的顺序编号。文字里的编号只有两种：learning_read 要用的内容编号，和写概念链接要用的知识点编号。
 * 文字超过底座的上限时，底座省略中间部分并保存全文，模型用 read 按行续取，所以这里不分页，长题面和长代码照原样分行写出。
 */
import type { Answer, Content, Item } from "@repa/base/protocol";
import type { CourseIndex } from "./course-index.js";
import { contentText, entryText } from "./model-text.js";
import type {
  ContentPage, ContentRef, LearningResult, LearningTask, Processing, SlotFeedback, Submission, TestResult, Verdict,
} from "./protocol.js";
import { currentDelivery } from "./tutor-content.js";

type Slot = Item["slots"][number];
type OrderSlot = Extract<Slot, { type: "order" }>;
type TableSlot = Extract<Slot, { type: "table" }>;
type Delivery = LearningTask["deliveries"][number];
type Phase = LearningTask["phase"];
type KpProgress = LearningTask["kps"][number];

const KINDS: Record<LearningTask["kind"], string> = { lesson: "课", review: "复习", quiz: "测验", retake: "换题重考" };
const OUTCOMES: Record<Extract<Phase, { stage: "completed" }>["outcome"], string> = {
  passed: "通过",
  failed: "没有通过",
  timeout: "到时间没有做完，没有通过",
  unresolved: "还有作答没判出结果，结论要等它们判完",
};
const VERDICTS: Record<Verdict, string> = { correct: "正确", partial: "部分正确", incorrect: "错误", ungraded: "不判对错", pending: "还在判" };
const INTERRUPTED: Record<Extract<Processing, { status: "interrupted" }>["reason"], string> = {
  restart: "判分途中应用关闭了",
  service_failure: "判分服务暂时不可用",
  uncertain_grade: "判分的模型没有把握",
  cancelled: "判分被取消了",
};
const TEST_RESULTS: Record<TestResult["result"], string> = { passed: "通过", failed: "没通过", error: "没能得出结果", timeout: "超时" };
/** 文本作答位的 format 只是输入提示；认识的写成要填什么，其余按文字。 */
const TEXT_FORMATS: Partial<Record<string, string>> = { integer: "填一个整数", number: "填一个数" };
/** 视图里的阶段：一句话说明学习者此刻在做什么。 */
const STAGES: Record<Exclude<Phase["stage"], "completed">, string> = {
  preparing: "正在准备，还没有出题",
  explanation: "学习者在读讲解",
  example: "学习者在看例题",
  awaiting_answer: "学习者正在作答一道题",
  judging: "学习者已提交，正在判分",
  recovery: "学习者已提交，判分还没有结果",
  feedback: "学习者在看判分结果",
  aborted: "学习者中止了这项任务",
};

function topicTitle(course: CourseIndex, topicId: string): string {
  return course.topics.get(topicId)?.title ?? topicId;
}

function kpTitle(course: CourseIndex, topicId: string, kpId: string): string {
  return course.topics.get(topicId)?.kps.find((kp) => kp.id === kpId)?.title ?? kpId;
}

function taskName(task: LearningTask, course: CourseIndex): string {
  return `${KINDS[task.kind]}${task.topicIds.map((id) => `「${topicTitle(course, id)}」`).join("")}`;
}

/** 学习者写的多行文字和代码放进围栏；围栏比文字里最长的一串反引号还长，不会被提前截断。 */
function fenced(text: string, language = ""): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text.replace(/\n$/, "")}\n${fence}`;
}

/** 选项和排列块：只有一行代码时写成行内代码，排列出来的程序才看得清；其余按内容块写出。 */
function optionText(content: Content): string {
  const [only] = content;
  if (content.length === 1 && only?.type === "code" && only.startLine === undefined && !/[\n`]/.test(only.text)) {
    return `\`${only.text}\``;
  }
  return contentText(content);
}

/** 选项编号从 1 起，按学习者看到的顺序；找不到的编号原样写出。 */
function optionNumbers(ids: string[], options: { id: string }[]): string {
  return ids.map((id) => {
    const index = options.findIndex((option) => option.id === id);
    return index < 0 ? id : String(index + 1);
  }).join("、");
}

function arrangement(slot: OrderSlot, answer: Extract<Answer, { type: "order" }>): string[] {
  if (!answer.items.length) return ["（一块也没有用）"];
  return answer.items.map((id, position) => {
    const index = slot.items.findIndex((item) => item.id === id);
    const item = slot.items[index];
    const indent = "    ".repeat(answer.indents?.[position] ?? 0);
    return item ? entryText(`${indent}${index + 1}. `, optionText(item.content)) : `${indent}${id}`;
  });
}

/** 表格写成 Markdown 表；fill 给出输入格里的内容，省略时写出要学习者填什么。 */
function table(slot: TableSlot, fill?: (row: string, column: string) => string): string[] {
  const escape = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
  const headed = slot.rows.some((row) => row.header !== undefined);
  const header = [...(headed ? [""] : []), ...slot.columns.map((column) => column.header)];
  const lines = [`| ${header.map(escape).join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const row of slot.rows) {
    const cells = slot.columns.map((column) => {
      const cell = row.cells[column.id];
      if (!cell) return "";
      if ("value" in cell) return cell.value;
      if (fill) return fill(row.id, column.id);
      return cell.input.type === "choice" ? `待选：${cell.input.options.map((option) => option.label).join(" / ")}` : "待填";
    });
    lines.push(`| ${[...(headed ? [row.header ?? ""] : []), ...cells].map(escape).join(" | ")} |`);
  }
  return lines;
}

function tableAnswer(slot: TableSlot, cells: Extract<Answer, { type: "table" }>["cells"]): string[] {
  return table(slot, (rowId, columnId) => {
    const value = cells[rowId]?.[columnId];
    if (value?.type === "text") return value.text === "" ? "（空）" : value.text;
    const cell = slot.rows.find((row) => row.id === rowId)?.cells[columnId];
    const options = cell && "input" in cell && cell.input.type === "choice" ? cell.input.options : [];
    const labels = (value?.selected ?? []).map((id) => options.find((option) => option.id === id)?.label ?? id);
    return labels.length ? labels.join("、") : "（空）";
  });
}

/** 一个作答位要学习者做什么：选项、要填的格、起始代码。 */
function slotTask(slot: Slot): string[] {
  switch (slot.type) {
    case "choice":
      return [
        `${slot.multiple ? "多选" : "单选"}，选项按学习者看到的顺序：`,
        ...slot.options.map((option, index) => entryText(`${index + 1}. ${option.label ? `（${option.label}）` : ""}`, optionText(option.content))),
      ];
    case "text": {
      const kind = TEXT_FORMATS[slot.format ?? ""] ?? "填写文字";
      return [slot.quick?.length ? `${kind}，也可以直接填：${slot.quick.join("、")}。` : `${kind}。`];
    }
    case "order":
      return [
        `${slot.partial ? "从下面的块里挑出需要的，排成正确的顺序" : "把下面的块全部排成正确的顺序"}${slot.indent === undefined ? "" : `，可以缩进，最多 ${slot.indent} 层`}。块按学习者看到的初始顺序：`,
        ...slot.items.map((item, index) => entryText(`${index + 1}. `, optionText(item.content))),
      ];
    case "table":
      return ["表格，学习者填写标着“待填”“待选”的格：", ...table(slot)];
    case "code":
      return slot.starter.trim() ? ["写代码，起始代码：", fenced(slot.starter, slot.language)] : ["写代码，没有起始代码。"];
  }
}

/** 一份作答写成文字：label 是“学习者的作答”或“正确答案”。 */
function answerLines(slot: Slot, answer: Answer, label: string): string[] {
  if (slot.type === "choice" && answer.type === "choice") {
    const chosen = answer.selected.length ? `选 ${optionNumbers(answer.selected, slot.options)}` : "一个都不选";
    return [`${label}：${chosen}${answer.other === undefined ? "" : `；另填：${answer.other}`}`];
  }
  if (slot.type === "text" && answer.type === "text") {
    if (answer.text === "") return [`${label}：（空）`];
    return answer.text.includes("\n") ? [`${label}：`, fenced(answer.text)] : [`${label}：${answer.text}`];
  }
  if (slot.type === "order" && answer.type === "order") {
    return [`${label}${slot.indent === undefined ? "" : "（每层缩进 4 个空格）"}：`, ...arrangement(slot, answer)];
  }
  if (slot.type === "table" && answer.type === "table") {
    return [`${label}：`, ...tableAnswer(slot, answer.cells)];
  }
  if (slot.type === "code" && answer.type === "code") {
    return [`${label}：`, fenced(answer.code, slot.language)];
  }
  return [`${label}：与这一问的作答方式不符，无法显示`];
}

function feedbackLines(slot: Slot, feedback: SlotFeedback): string[] {
  const lines = [`判分：${VERDICTS[feedback.verdict]}`];
  if (feedback.tests?.length) {
    lines.push("测试：", ...feedback.tests.map((test) => `- 「${test.name}」${test.hidden ? "（隐藏）" : ""}：${TEST_RESULTS[test.result]}`));
  }
  const reason = contentText(feedback.message);
  if (reason) {
    lines.push(reason.includes("\n") ? `判分理由：\n${reason}` : `判分理由：${reason}`);
  }
  if (feedback.verdict !== "correct" && feedback.expected) {
    lines.push(...answerLines(slot, feedback.expected, "正确答案"));
  }
  return lines;
}

function slotText(slot: Slot, number: number, single: boolean, submission: Submission | undefined): string {
  const lines = single ? [] : [`### 第 ${number} 问${slot.label ? `（${slot.label}）` : ""}`];
  const prompt = contentText(slot.prompt);
  if (prompt) lines.push(prompt);
  lines.push(...slotTask(slot));
  if (submission && !submission.response.dontKnow) {
    const answer = submission.response.answers[slot.id];
    lines.push(...(answer ? answerLines(slot, answer, "学习者的作答") : ["学习者没有作答这一问。"]));
  }
  const feedback = submission?.feedback?.slots?.[slot.id];
  if (feedback) lines.push(...feedbackLines(slot, feedback));
  return lines.join("\n");
}

/** 这道题提交到了哪一步：还没提交、在判、判不出结果，或判分结果。 */
function submissionLine(submission: Submission | undefined): string {
  if (!submission) return "学习者还没有提交这道题。";
  const done = submission.response.dontKnow ? "学习者对这道题选择了“不会”，没有作答" : "学习者已提交这道题";
  const processing = submission.processing;
  if (processing.status === "interrupted") {
    return `${done}，判分没有完成（${INTERRUPTED[processing.reason]}），这份作答暂不算对也不算错。`;
  }
  if (processing.status !== "completed") return `${done}，正在判分。`;
  const feedback = submission.feedback;
  if (!feedback) return `${done}，判分结果暂不公开。`;
  const judge = feedback.judge === "model" ? "（由模型按评分要点判）" : "";
  const helped = feedback.evidence?.status === "ineligible" ? "作答前问过辅导或读过参考内容，这次不算独立完成。" : "";
  return `${done}，判分结果：${VERDICTS[feedback.verdict]}${judge}。${helped}`;
}

function questionText(delivery: Delivery, submission: Submission | undefined): string {
  const item = delivery.item;
  const body = contentText(item.body);
  const sections = [["## 题目", ...(item.title ? [`**${item.title}**`] : []), ...(body ? [body] : [])].join("\n")];
  item.slots.forEach((slot, index) => sections.push(slotText(slot, index + 1, item.slots.length === 1, submission)));
  if (submission?.explanation?.length) sections.push(`## 题解\n${contentText(submission.explanation)}`);
  return sections.join("\n\n");
}

/** learning_task 的文字：学习者正在读的讲解或例题，或者正在做的题连同作答、判分结果和题解。 */
export function taskText(task: LearningTask | null, course: CourseIndex): string {
  if (!task) return "学习者还没有开始任何任务。";
  const head = [taskName(task, course)];
  const phase = task.phase;
  if (phase.stage === "explanation" || phase.stage === "example") {
    const ref = phase.page.ref;
    head.push(`知识点 ${ref.kpId ?? ""}「${kpTitle(course, ref.topicId, ref.kpId ?? "")}」`);
    head.push(phase.stage === "explanation" ? "学习者在读这个知识点的讲解，还没开始做这个知识点的题。" : "学习者在看这个知识点的例题。");
    return `${head.join("\n")}\n\n## ${phase.stage === "explanation" ? "讲解" : "例题"}\n${contentText(phase.page.blocks)}`;
  }
  if (phase.stage === "completed") head.push(`这项任务已经结束：${OUTCOMES[phase.outcome]}。`);
  if (phase.stage === "aborted") head.push("学习者中止了这项任务。");
  if (phase.stage === "preparing") head.push("任务正在准备，还没有出题。");
  const delivery = currentDelivery(task);
  if (!delivery) return head.join("\n");
  const submission = task.submissions.find((entry) => entry.deliveryId === delivery.deliveryId);
  if (phase.stage === "completed" || phase.stage === "aborted") head.push("下面是最后一道题。");
  head.push(`知识点 ${delivery.kpId}「${kpTitle(course, delivery.topicId, delivery.kpId)}」`, submissionLine(submission));
  return `${head.join("\n")}\n\n${questionText(delivery, submission)}`;
}

/** 一项内容的名字：属于哪个知识点、是什么，以及所在的课。titles 是内容索引里的标题，用于概念卡的名称。 */
function pageName(ref: ContentRef, titles: ReadonlyMap<string, string>, course: CourseIndex): string {
  const topic = `课「${topicTitle(course, ref.topicId)}」`;
  if (ref.kind === "topic" || ref.kpId === undefined) return `${topic}的引言与小结`;
  const kp = `知识点 ${ref.kpId}「${kpTitle(course, ref.topicId, ref.kpId)}」`;
  const what = {
    kp: "",
    lesson: "的讲解",
    example: "的例题",
    card: `的概念卡「${titles.get(ref.id) ?? ""}」`,
    explanation: "一道题的题解",
  }[ref.kind];
  return `${kp}${what}，${topic}`;
}

/** learning_search 的文字：每条结果一行编号与名字，下一行是摘录。 */
export function searchText(
  query: string, offset: number, result: LearningResult<"content.search">,
  titles: ReadonlyMap<string, string>, course: CourseIndex,
): string {
  if (!result.hits.length) return offset > 0 ? "没有更多结果。" : `学过的内容里没有找到「${query}」。`;
  const lines = result.hits.flatMap((hit) => [
    `- \`${hit.ref.id}\` ${pageName(hit.ref, titles, course)}`,
    `  ${hit.snippet.replace(/\s+/g, " ").trim()}`,
  ]);
  if (result.nextOffset !== null) lines.push(`还有更多结果，用 offset=${result.nextOffset} 继续。`);
  return lines.join("\n");
}

/** learning_read 的文字：每项内容一个标题，下面是全文。 */
export function pagesText(pages: ContentPage[], titles: ReadonlyMap<string, string>, course: CourseIndex): string {
  return pages.map((page) => `# \`${page.ref.id}\` ${pageName(page.ref, titles, course)}\n\n${contentText(page.blocks) || "（没有内容）"}`).join("\n\n");
}

/** 视图：当前任务、阶段、知识点进度和学过的直接先修（按学生模型估计的记忆由弱到强）。 */
export function viewText(task: LearningTask | null, course: CourseIndex, kp: KpProgress | undefined, prerequisites: string[]): string {
  if (!task) return "学习者还没有开始任何任务。";
  const phase = task.phase;
  const stage = phase.stage === "completed" ? `已经结束：${OUTCOMES[phase.outcome]}` : STAGES[phase.stage];
  const lines = [`当前任务：${taskName(task, course)}，${stage}`];
  if (kp) {
    const title = kpTitle(course, task.topicIds[0] ?? "", kp.kpId);
    lines.push(`知识点「${title}」：已答 ${kp.attempts} 题，连续独立答对 ${kp.consecutiveCorrect} 题${kp.completed ? "，已通过" : ""}`);
  }
  if (prerequisites.length) {
    lines.push(`学过的直接先修，学生模型估计的记忆由弱到强：${prerequisites.map((id) => `「${topicTitle(course, id)}」`).join("")}`);
  }
  return lines.join("\n");
}
