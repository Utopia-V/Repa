/**
 * 走查的步骤。每一步像学习者那样操作界面，再用 expect 写下必须成立的事；已知而尚未修好的界面问题用 known 写，
 * 不成立记为预期失败，修好以后自动翻成“已修好”。步骤按顺序依赖前一步留下的状态，一步不通过，后面的不再运行。
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import type { App } from "./app.js";
import type { Page } from "./browser.js";
import { confirmationAnswers, courseFiles, courseQuestions, type QuestionDefinition } from "./course.js";
import type { ScriptedModel } from "./model.js";
import type { Checks } from "./walk.js";

export interface Context {
  app: App;
  page: Page;
  model: ScriptedModel;
  /** 步骤之间传的值，例如上一步看到的 XP。 */
  notes: Map<string, unknown>;
}

export interface Step {
  id: string;
  title: string;
  run(context: Context, checks: Checks): Promise<void>;
}

/** 已知的界面状态问题（2026-11-16 候选版本验收时发现），修好以后对应的检查会翻成“已修好”。 */
export const KNOWN = {
  panelEntry: "学过或中止过一节以后，学习页右上一直是“问辅导”，“做课”入口不再出现（learn.tsx 的右侧面板取决于 task 非空，结束的任务一直留在状态里）",
  learnedCount: "学完一节后“整门课”一行的已学数不立即更新",
  makingPanel: "做课的面板在课做好以后不收起",
} as const;

const COURSE_NAME = "操作系统 走查";
const REQUEST = "想学进程状态和进程控制块，下周考试。";
const FIX_REQUEST = "第一节问正在执行的进程是什么状态，我写“执行”被判错了，这个说法也该算对。";

/** 学习页标题栏右边那个打开面板的按钮的文字（窄屏时面板收在这里）。 */
async function headerAction(page: Page): Promise<string> {
  return page.evaluate<string>("(() => { const header = document.querySelector('main header, header'); const button = header && [...header.querySelectorAll('button')].pop(); return button ? button.innerText.trim() : ''; })()");
}

/** 打开着的对话框或抽屉的标题；没有时为空串。 */
async function openDialog(page: Page): Promise<string> {
  return page.evaluate<string>("(() => { const dialog = document.querySelector('[role=dialog]'); if (!dialog) return ''; const title = dialog.querySelector('h2, [data-slot=sheet-title], [data-slot=dialog-title]'); return (title ? title.innerText : dialog.innerText).trim().slice(0, 60); })()");
}

/** 轮询一个异步条件直到成立；超时报出描述。 */
async function until(description: string, condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`${timeoutMs / 1000} 秒内没有等到：${description}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** 学习页上看得见的状态：今日 XP、整门课一行、菜单里的各项。 */
interface LearnView {
  xp: number | undefined;
  parts: { total: number; ready: number; learned: number } | undefined;
  menu: string[];
}

function learnView(text: string): LearnView {
  const xp = /今天 (\d+) \/ \d+ XP/u.exec(text);
  const parts = /(\d+) 部分 · 可学 (\d+) · 已学 (\d+)/u.exec(text);
  const menu = /接下来\n([\s\S]*?)(?:\n整门课|$)/u.exec(text)?.[1] ?? "";
  return {
    xp: xp ? Number(xp[1]) : undefined,
    parts: parts ? { total: Number(parts[1]), ready: Number(parts[2]), learned: Number(parts[3]) } : undefined,
    // 每一项是“类型 标题”，后面跟一个“开始”。
    menu: [...menu.matchAll(/(新课|复习|测验|重考)\n([^\n]+)\n开始/gu)].map((match) => `${match[1]} ${match[2]}`),
  };
}

/** 页面上当前这道题：题面出现在页面文字里、且最长的那一道（题面互不包含时就是唯一的那道）。 */
function currentQuestion(text: string, questions: Map<string, QuestionDefinition>): QuestionDefinition | undefined {
  let best: QuestionDefinition | undefined;
  for (const question of questions.values()) {
    if (text.includes(question.body.trim()) && (!best || question.body.length > best.body.length)) best = question;
  }
  return best;
}

/** 按课程文件里的标准答案作答；answers 里给了的题用给定的答案（故意答错或开放题）。交回题目 id。 */
async function answer(page: Page, questions: Map<string, QuestionDefinition>, answers: Record<string, string>): Promise<string> {
  // 按钮出现时题面可能还在渲染：按此刻的页面文字找题，等题面出现。
  const text = await page.waitFor("题面出现", (current) => currentQuestion(current, questions) !== undefined, 5_000)
    .catch(() => { throw new Error("页面上的题在走查的课里找不到"); });
  const question = currentQuestion(text, questions);
  if (!question) throw new Error("页面上的题在走查的课里找不到");
  for (const slot of question.slots) {
    const given = answers[question.id];
    if (slot.type === "choice") {
      const keys = given === undefined ? (Array.isArray(slot.key) ? slot.key : [slot.key]).map(String) : [given];
      for (const key of keys) {
        const option = slot.options?.find((entry) => entry.id === key);
        await page.click({ name: option?.content ?? key, selector: "label" });
      }
    } else {
      const value = given ?? String(Array.isArray(slot.key) ? slot.key[0] : slot.key);
      await page.fill("", value, { near: question.body.trim() });
    }
  }
  await page.click({ name: /^提交$/u, selector: "button" });
  return question.id;
}

/**
 * 把当前的课或复习做到出现 stop 为止（缺省是做完）：讲解、例题翻过去，题按答案作答，反馈后继续。
 * 交回答过的题。每次操作后等页面文字变化，不靠固定的等待。
 */
async function work(page: Page, questions: Map<string, QuestionDefinition>, options: { answers?: Record<string, string>; stopBefore?: string } = {}): Promise<string[]> {
  const answered: string[] = [];
  for (let round = 0; round < 60; round++) {
    const text = await page.text();
    if (/(新课|复习)结束/u.test(text)) return answered;
    const question = currentQuestion(text, questions);
    if (options.stopBefore !== undefined && question?.id === options.stopBefore && await page.has({ name: /^提交$/u, selector: "button" })) return answered;
    const ready = async (name: string) => {
      const found = await page.find({ name: new RegExp(`^${name}$`, "u"), selector: "button" });
      return found.found && !found.disabled;
    };
    if (await ready("看例题")) await page.click({ name: "看例题", selector: "button" });
    else if (await ready("开始练习")) await page.click({ name: "开始练习", selector: "button" });
    else if (await ready("提交") && await ready("不会")) answered.push(await answer(page, questions, options.answers ?? {}));
    else if (await ready("继续")) await page.click({ name: "继续", selector: "button" });
    else {
      // 正在判分或正在读取：等画面变化。
    }
    await page.waitFor("画面变化", (next) => next !== text, 15_000);
  }
  throw new Error("60 次操作内没有做完");
}

/** 学习记录里这道题最近一次判分的结论；没有判分时为 undefined。只读文件，不经后端，不改变任何状态。 */
async function latestVerdict(app: App, question: string): Promise<string | undefined> {
  const facts = (await readFile(path.join(app.home, "Repa", COURSE_NAME, ".repa", "plugins", "learning", "records.jsonl"), "utf8"))
    .split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; seq: number; question?: string; delivery?: number; verdict?: string });
  const deliveries = new Set(facts.filter((fact) => fact.type === "delivered" && fact.question === question).map((fact) => fact.seq));
  return facts.filter((fact) => fact.type === "graded" && fact.delivery !== undefined && deliveries.has(fact.delivery)).at(-1)?.verdict;
}

/** 这台机器上这个空间的全部备份目录，按时间先后。 */
async function backups(app: App): Promise<string[]> {
  const root = path.join(app.repaHome, "backups");
  const result: string[] = [];
  for (const space of await readdir(root).catch(() => [])) {
    for (const name of await readdir(path.join(root, space)).catch(() => [])) result.push(path.join(root, space, name));
  }
  return result.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

/** 读导出的 zip：按中央目录逐项解压。只为看里面有什么，不核对格式细节。 */
function unzip(buffer: Buffer): Map<string, string> {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const files = new Map<string, string>();
  if (end < 0) return files;
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + compressed);
    files.set(name, (method === 8 ? inflateRawSync(data) : data).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

export const STEPS: Step[] = [
  {
    id: "first-run",
    title: "全新用户的第一屏，起名建课，没有模型时学习页的提示",
    async run({ app, page }, checks) {
      await app.startBackend();
      await app.open();
      await page.waitText("创建第一门课", 30_000);
      checks.expect("第一屏是“创建第一门课”", true);
      await page.fill("课程名称", COURSE_NAME);
      const hint = await page.waitText("保存位置：");
      const location = /保存位置：(.*)/u.exec(hint)?.[1]?.trim() ?? "";
      checks.expect("课存在临时 HOME 下的 Repa/<课名>", location === `${app.home}/Repa/${COURSE_NAME}`, location);
      await page.click("创建");
      const text = await page.waitText("想学的内容与目标", 20_000);
      checks.expect("建好后进入学习页的做课起点", true);
      checks.expect("没有模型时提示“还没有可用的模型”", text.includes("还没有可用的模型") && text.includes("连接一个模型提供方后才能做课。"));
      const start = await page.find({ name: "开始", selector: "button" });
      checks.expect("没有模型时“开始”不能点", start.found && start.disabled);
      checks.expect("有“去设置模型”的入口", await page.has({ name: "去设置模型", selector: "a, button" }));
    },
  },
  {
    id: "making",
    title: "接上模型，做课：Agent 写课、检查、核对（假模型独立作答）、换用",
    async run({ app, page, model }, checks) {
      // 学习者接好模型以后重开应用；模型配置在后端启动时读入。
      await app.connectModel();
      await app.reopen();
      await page.waitText("想学的内容与目标", 30_000);
      checks.expect("接上模型后不再提示没有模型", !(await page.text()).includes("还没有可用的模型"));
      const files = await courseFiles();
      model.setAnswers(await confirmationAnswers());
      model.script(REQUEST, [
        { tools: files.map((file) => ({ name: "write", arguments: { path: `course/${file.path}`, content: file.content } })) },
        { tools: [{ name: "course_check", arguments: {} }] },
        { tools: [{ name: "course_confirm", arguments: { topicIds: ["os01", "os02"] } }] },
        { tools: [{ name: "course_use", arguments: {} }] },
        { text: "学习页上已经能看到整门课，第一节可以学了。" },
      ]);
      await page.fill("想学的内容与目标", REQUEST);
      await page.click({ name: "开始", selector: "button" });
      const text = await page.waitFor("整门课和菜单", (current) => current.includes("整门课") && current.includes("接下来"), 90_000);
      const results = model.toolResults;
      const check = results.find((result) => result.tool === "course_check")?.text ?? "";
      const confirm = results.find((result) => result.tool === "course_confirm")?.text ?? "";
      const used = results.find((result) => result.tool === "course_use")?.text ?? "";
      checks.expect("Agent 写的课通过检查", check.includes("通过检查"), check.split("\n")[0]);
      // Linux 上经沙箱运行；建不起沙箱的机器（Windows、macOS、缺 Landlock 的 Linux）交给开着的页面，两条路都算。
      checks.expect("检查运行了课里的 verify 程序", /(Linux 沙箱里|应用页面的 Worker 里)运行了 verify 核对程序/u.test(check), check.split("\n")[1]);
      checks.expect("核对：假模型独立作答，全部一致并记下", confirm.includes("全部一致"), confirm.split("\n")[0]);
      checks.expect("换用成功", used.startsWith("已换用"), used.split("\n")[0]);
      checks.expect("学习页显示整门课两部分", /2 部分/u.test(text), /\d+ 部分[^\n]*/u.exec(text)?.[0]);
      checks.expect("菜单里有第一节新课", /新课\s*进程的三种基本状态/u.test(text));
      checks.expect("Agent 最后一句话显示在做课对话里", (await page.waitText("第一节可以学了", 10_000)).includes("第一节可以学了"));
      checks.known(KNOWN.makingPanel, "课做好以后做课的抽屉收起", (await openDialog(page)) === "", `打开着的是「${await openDialog(page)}」`);
      if ((await openDialog(page)) !== "") await page.press("Escape");
      await until("抽屉关上", async () => (await openDialog(page)) === "");
      checks.expect("右上角是“做课”入口", (await headerAction(page)) === "做课", await headerAction(page));
    },
  },
  {
    id: "lesson",
    title: "上完第一节（答案取自课程文件，从界面作答，故意答错一道填空），回到菜单",
    async run({ page, notes }, checks) {
      const questions = await courseQuestions();
      const before = learnView(await page.text());
      await page.click({ name: "开始", near: "进程的三种基本状态", selector: "button" });
      await page.waitText("看例题");
      // 故意把一道填空答成课程没有收的写法，第 7 条（改正答案后重判）要用它。
      const answered = await work(page, questions, { answers: { "os01.k1.q2": "执行" } });
      const text = await page.waitText("新课结束");
      checks.expect("从界面答完了这一节的练习", answered.length >= 6, answered.join("、"));
      checks.expect("这一节通过了", text.includes("这一节通过了。"));
      const after = learnView(text);
      notes.set("xp", after.xp);
      checks.expect("今日 XP 增加了", (after.xp ?? 0) > (before.xp ?? 0), `${before.xp ?? "?"} → ${after.xp ?? "?"}`);
      checks.expect("下一项任务是第二节新课", after.menu.includes("新课 进程控制块"), after.menu.join("；") || "菜单是空的");
      checks.known(KNOWN.learnedCount, "“整门课”一行立即显示已学 1", after.parts?.learned === 1, `显示 ${/\d+ 部分[^\n]*/u.exec(text)?.[0] ?? "（没有这一行）"}`);
      const action = await headerAction(page);
      checks.known(KNOWN.panelEntry, "右上角回到“做课”入口", action === "做课", `是「${action}」`);
    },
  },
  {
    id: "reopen",
    title: "关闭后端再打开，回到原处",
    async run({ app, page, notes }, checks) {
      const before = learnView(await page.text());
      await app.reopen();
      const text = await page.waitFor("学习页和菜单", (current) => current.includes("接下来") && current.includes("整门课"), 30_000);
      const after = learnView(text);
      checks.expect("回到这门课的学习页", text.includes("进程的基本概念"));
      checks.expect("刚做完的一节仍显示结果", text.includes("新课结束") && text.includes("这一节通过了。"));
      checks.expect("菜单与关闭前相同", after.menu.join("；") === before.menu.join("；"), after.menu.join("；"));
      checks.expect("今日 XP 与关闭前相同", after.xp === notes.get("xp"), `${String(notes.get("xp"))} → ${after.xp ?? "?"}`);
      checks.expect("整门课显示已学 1", after.parts?.learned === 1, /\d+ 部分[^\n]*/u.exec(text)?.[0]);
    },
  },
  {
    id: "regrade",
    title: "改正一道题可接受的答案并换用以后，过去的作答被重判，今日 XP 不减少",
    async run({ app, page, model, notes }, checks) {
      checks.expect("改之前，那份“执行”的作答判为错", await latestVerdict(app, "os01.k1.q2") === "incorrect");
      const xp = learnView(await page.text()).xp;
      const files = await courseFiles();
      const topic = files.find((file) => file.path === "topics/os01.yaml");
      const fixed = topic?.content.replace("key: [运行, 运行态]", "key: [运行, 运行态, 执行]") ?? "";
      checks.expect("走查的课里有要改的那道填空", topic !== undefined && fixed !== topic.content);
      // 核对的标准答案按改过的课算。
      const root = path.join(app.dir, "course-fixed");
      for (const file of files) {
        await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
        await writeFile(path.join(root, file.path), file.path === "topics/os01.yaml" ? fixed : file.content);
      }
      model.setAnswers(await confirmationAnswers(root));
      model.script(FIX_REQUEST, [
        // 改已有文件之前要先读过它，底座拒绝没读过就改；只改这一行，文件末尾核对时记下的 verified 段原样留着。
        { tools: [{ name: "read", arguments: { path: "course/topics/os01.yaml" } }] },
        { tools: [{ name: "edit", arguments: { path: "course/topics/os01.yaml", edits: [{ oldText: "key: [运行, 运行态]", newText: "key: [运行, 运行态, 执行]" }] } }] },
        { tools: [{ name: "course_check", arguments: {} }] },
        { tools: [{ name: "course_confirm", arguments: { topicIds: ["os01"] } }] },
        { tools: [{ name: "course_use", arguments: {} }] },
        { text: "改好了，“执行”现在也算对。" },
      ]);
      const seen = model.toolResults.length;
      // 学习页右上角此时是“问辅导”（见已知问题），做课的对话进不去；学习者在新会话里对通用 Agent 说。
      await page.click({ name: "新会话", selector: "a, button" });
      await page.fill("消息", FIX_REQUEST);
      await page.press("Enter");
      await page.waitText("改好了，“执行”现在也算对。", 30_000);
      const results = model.toolResults.slice(seen);
      const confirm = results.find((result) => result.tool === "course_confirm")?.text ?? "";
      const used = results.find((result) => result.tool === "course_use")?.text ?? "";
      checks.expect("只核对改过的那道题，一致", /这次发请求 1 次.*全部一致/u.test(confirm), confirm.split("\n")[0]);
      checks.expect("改后的课换用成功", used.startsWith("已换用"), used.split("\n")[0]);
      await page.click({ name: "学习", selector: "a, button" });
      const text = await page.waitText("接下来", 15_000);
      await until("那份作答按新答案重判为对", async () => await latestVerdict(app, "os01.k1.q2") === "correct", 10_000)
        .catch(() => undefined);
      checks.expect("那份“执行”的作答重判为对", await latestVerdict(app, "os01.k1.q2") === "correct", await latestVerdict(app, "os01.k1.q2"));
      const after = learnView(await page.text());
      checks.expect("今日 XP 没有减少", (after.xp ?? -1) >= (xp ?? 0), `${xp ?? "?"} → ${after.xp ?? "?"}`);
      notes.set("xp", after.xp);
      checks.expect("学习页仍是这门课", text.includes("进程的基本概念"));
    },
  },
  {
    id: "mid-lesson",
    title: "一节课做到一半时关闭再打开，能接着做，没判出结果的不记为错",
    async run({ app, page, model }, checks) {
      const questions = await courseQuestions();
      await page.click({ name: "开始", near: "进程控制块", selector: "button" });
      await page.waitText("看例题");
      // 做到开放题出现：前两道必做题答完，开放题排在最后一道必做题之前。
      const answered = await work(page, questions, { stopBefore: "os02.k1.q4" });
      checks.expect("开放题出现之前答了这一节的前几道题", answered.length >= 1, answered.join("、"));
      model.holdGrading();
      await page.fill("", "换下时寄存器和程序计数器存进进程控制块，恢复时取回。", { near: "为什么被换下处理机的进程" });
      await page.click({ name: /^提交$/u, selector: "button" });
      await page.waitText("正在判分", 15_000);
      checks.expect("开放题交给模型判分，判分还没有结果", model.heldCount() > 0);
      await app.reopen();
      const text = await page.waitText("进程控制块", 30_000);
      checks.expect("重开后回到这一节，而不是菜单", text.includes("新课") && !text.includes("接下来"));
      // 模型可用时，重开后的第一次调用就在后台补判这份作答，画面停在“正在判分”；补判也失败时才是“没能判出结果，不算错”。
      const pending = await page.waitFor("这份作答还在判分或写明没判出", (current) => current.includes("正在判分") || current.includes("没能判出结果，不算错"), 15_000);
      checks.expect("那道开放题停在等判分的画面，不显示为错", !/答错了|不正确/u.test(pending), pending.includes("正在判分") ? "正在判分（后台补判）" : "没能判出结果，不算错");
      checks.expect("那份作答没有判分记录（不记为错）", await latestVerdict(app, "os02.k1.q4") === undefined, await latestVerdict(app, "os02.k1.q4"));
      model.release();
      if (await page.has({ name: /^再判一次$/u, selector: "button" })) await page.click({ name: "再判一次", selector: "button" });
      await until("开放题判出结果", async () => await latestVerdict(app, "os02.k1.q4") !== undefined, 15_000);
      checks.expect("模型可用以后补判为对", await latestVerdict(app, "os02.k1.q4") === "correct", await latestVerdict(app, "os02.k1.q4"));
      await work(page, questions);
      const done = await page.waitText("新课结束");
      checks.expect("接着把这一节做完并通过", done.includes("这一节通过了。"));
    },
  },
  {
    id: "next-day",
    title: "隔天：时钟拨到第二天，菜单里出现复习，复习能做完",
    async run({ app, page }, checks) {
      const questions = await courseQuestions();
      await app.reopen({ days: 1 });
      const text = await page.waitFor("学习页和菜单", (current) => current.includes("接下来") && current.includes("整门课"), 30_000);
      const view = learnView(text);
      checks.expect("前一天做完的课不再是当前画面", !text.includes("新课结束"));
      checks.expect("今日 XP 从 0 开始", view.xp === 0, String(view.xp));
      const review = view.menu.find((entry) => entry.startsWith("复习"));
      checks.expect("菜单里出现复习", review !== undefined, view.menu.join("；") || "菜单是空的");
      const title = review?.slice("复习 ".length) ?? "";
      await page.click({ name: "开始", near: title, selector: "button" });
      await page.waitText(/^复习$/mu);
      const answered = await work(page, questions);
      const done = await page.waitText("复习结束");
      const outcome = /复习结束\s*\n\s*([^\n]+)/u.exec(done)?.[1] ?? "";
      checks.expect("复习做完并通过", outcome.includes("通过") && !outcome.includes("没有通过"), `${answered.length} 题；${outcome}`);
      checks.expect("复习给了 XP", (learnView(done).xp ?? 0) > 0, String(learnView(done).xp));
    },
  },
  {
    id: "backup-export",
    title: "立即备份，导出学习数据，导出的文件里有作答记录",
    async run({ app, page }, checks) {
      await page.click({ name: "设置", selector: "a, button" });
      await page.waitText(/上一次备份|还没有备份/u, 15_000);
      const before = await backups(app);
      await page.click({ name: "立即备份", selector: "button" });
      // 按钮在备份期间写“正在备份…”并且不能点，做完回到“立即备份”。
      await until("备份做完", async () => {
        const found = await page.find({ name: /^立即备份$/u, selector: "button" });
        return found.found && !found.disabled && (await backups(app)).some((entry) => !before.includes(entry));
      }, 30_000);
      const text = await page.text();
      const after = await backups(app);
      // 备份按保留份数轮换，份数可能不变；新的那份是之前没有的目录。
      const newest = after.find((entry) => !before.includes(entry)) ?? "";
      const copied = await readFile(path.join(newest, "data", "plugins", "learning", "records.jsonl"), "utf8").catch(() => "");
      checks.expect("立即备份做出了一份新备份，界面没有报错", !/无法备份|备份失败/u.test(text), `${path.basename(newest)}；${/上一次备份：[^\n]+/u.exec(text)?.[0] ?? ""}`);
      checks.expect("新备份里有学习记录", copied.includes("\"type\":\"answered\""), path.relative(app.dir, newest));
      await page.click({ name: "导出学习数据", selector: "button" });
      await page.waitText("records.jsonl", 15_000);
      await page.click({ name: /^导出$/u, selector: "button" });
      const exported = await page.waitText("已导出", 30_000);
      const file = /(\/[^\n]*repa-learning-export-[^\n]*\.zip)/u.exec(exported)?.[1];
      checks.expect("页面写出导出文件的位置", file !== undefined, file);
      const entries = unzip(await readFile(file ?? ""));
      const records = [...entries.entries()].find(([name]) => name.endsWith("records.jsonl"))?.[1] ?? "";
      const facts = records.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type?: string });
      checks.expect("导出的文件里有作答记录", facts.some((fact) => fact.type === "answered") && facts.some((fact) => fact.type === "graded"),
        `${[...entries.keys()].join("、")}；records.jsonl ${facts.length} 条`);
      await page.press("Escape");
    },
  },
];
