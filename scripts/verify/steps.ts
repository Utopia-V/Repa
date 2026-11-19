/**
 * 走查的步骤。每一步像学习者那样操作界面，再用 expect 写下必须成立的事；已知而尚未修好的界面问题用 known 写，
 * 不成立记为预期失败，修好以后自动翻成“已修好”。步骤按顺序依赖前一步留下的状态，一步不通过，后面的不再运行。
 */
import { access, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { parse, stringify } from "yaml";

import { strings } from "../../apps/web/src/strings/zh-CN.js";
import type { App } from "./app.js";
import type { Page } from "./browser.js";
import { confirmationAnswers, courseFiles, courseQuestions, type QuestionDefinition } from "./course.js";
import type { ModelFailureScript, ScriptedModel } from "./model.js";
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

/** 已知而尚未修好的界面问题，键是 checks.known 引用的名字；修好以后对应的检查会翻成“已修好”。目前没有。 */
export const KNOWN: Record<string, string> = {};

/** 模型请求失败时对话里应当出现的那句话（维护者定的文字），按假模型失败的方式。 */
const FAILURE_TEXT: [ModelFailureScript, string][] = [
  ["disconnect", "无法连接模型服务，请检查网络后重新发送。"],
  ["timeout", "无法连接模型服务，请检查网络后重新发送。"],
  [401, "API key 无效，请在“设置”的“模型提供方”中重新填写。"],
  [402, "模型服务的账户余额不足，充值后重新发送。"],
  [429, "请求过于频繁，请稍后重新发送。"],
  [500, "模型服务暂时不可用，请稍后重新发送。"],
];

/** 开放题判分失败时学习页应当出现的那句话，按假模型失败的方式；第三项为真时是点“再判一次”，否则是提交。 */
const GRADING_FAILURE_TEXT: [ModelFailureScript, string, boolean][] = [
  [402, "模型服务的账户余额不足，这份作答没能判出结果，不算错。充值后可以再判一次，也可以先做下一题，条件具备时会自动补判。", false],
  ["disconnect", "无法连接模型服务，这份作答没能判出结果，不算错。检查网络后可以再判一次，也可以先做下一题，条件具备时会自动补判。", true],
];

/** 学习者请通用 Agent 给课加一部分轮廓；加上以后学过的都已学完，学习页随即在后台展开它。 */
const OUTLINE_REQUEST = "在课的最后加一部分“进程调度”，先只列轮廓。";
const OUTLINE_TOPIC = [
  "id: os03",
  "title: 进程调度",
  "status: outline",
  "minutes: 15",
  "summary: 处理机在就绪进程之间怎样分配。",
  "prerequisites: [os02]",
  "sources: [{ source: notes, where: 第三节, use: reference }]",
  "kps:",
  "  - { id: os03.k1, title: 调度的时机 }",
  "  - { id: os03.k2, title: 调度的算法 }",
  "",
].join("\n");

const COURSE_NAME = "操作系统 走查";
const REQUEST = "想学进程状态和进程控制块，下周考试。";
const TUTOR_REQUEST = "刚做完的最后一道题，为什么这样答？";
const TUTOR_REPLY = "这一节已经结束，最后一道题是这样想的。";
const FIX_REQUEST = "第一节问正在执行的进程是什么状态，我写“执行”被判错了，这个说法也该算对。";
const RESTRUCTURE_REQUEST = "第一节问正在执行的进程是什么状态的那道填空不要了，换一道问只差处理机的题。";

/** 学习页标题栏右边打开面板的按钮的文字，按出现的顺序用“、”连起来（窄屏时面板收在这里）。 */
async function headerActions(page: Page): Promise<string> {
  return page.evaluate<string>("(() => { const header = document.querySelector('main header, header'); return header ? [...header.querySelectorAll('button')].map((button) => button.innerText.trim()).join('、') : ''; })()");
}

/** 打开着的对话框或抽屉的标题；没有时为空串。 */
async function openDialog(page: Page): Promise<string> {
  return page.evaluate<string>("(() => { const dialog = document.querySelector('[role=dialog]'); if (!dialog) return ''; const title = dialog.querySelector('h2, [data-slot=sheet-title], [data-slot=dialog-title]'); return (title ? title.innerText : dialog.innerText).trim().slice(0, 60); })()");
}

/** 一段文字在页面文字里出现了几次。 */
function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
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
    else if (await ready("提交") && await ready("不会")) {
      // 按钮可能先于题面出现：等题面出来再看是不是要停下的那道，否则会把它也答掉。
      const shown = await page.waitFor("题面出现", (current) => currentQuestion(current, questions) !== undefined, 5_000);
      if (options.stopBefore !== undefined && currentQuestion(shown, questions)?.id === options.stopBefore) return answered;
      answered.push(await answer(page, questions, options.answers ?? {}));
    }
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
    // 以点开头的是正在写的备份，写完才改名为正式的目录名。
    for (const name of await readdir(path.join(root, space)).catch(() => [])) if (!name.startsWith(".")) result.push(path.join(root, space, name));
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
      const first = await page.waitText("创建第一门课", 30_000);
      checks.expect("第一屏是“创建第一门课”", true);
      const hinted = first.includes("还没有可用的模型") ? first : await page.waitText("还没有可用的模型", 5_000).catch(() => first);
      checks.expect("没有模型时第一屏就提示“还没有可用的模型”和“去设置模型”", hinted.includes("还没有可用的模型") && await page.has({ name: "去设置模型", selector: "a, button" }));
      await page.shot("first-run-no-model");
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
      // Agent 最后那句话里也有“整门课”，抽屉里也有菜单：等整门课那一行出现。
      const text = await page.waitFor("整门课和菜单", (current) => learnView(current).parts !== undefined && current.includes("接下来"), 90_000);
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
      // 窄屏时做课的抽屉盖住了菜单：课第一次可以学时，抽屉里输入框之上也有菜单，读完 Agent 的话就地点“开始”。
      const drawer = await openDialog(page);
      checks.expect("课做好以后做课的抽屉里就有第一节的“开始”", drawer === "做课" && await page.has({ name: "开始", near: "进程的三种基本状态", selector: "[role=dialog] button" }), `打开着的是「${drawer}」`);
      await page.shot("making-first-lesson");
      checks.expect("右上角是“做课”入口", (await headerActions(page)) === "做课", await headerActions(page));
    },
  },
  {
    id: "lesson",
    title: "上完第一节（答案取自课程文件，从界面作答，故意答错一道填空），回到菜单",
    async run({ page, model, notes }, checks) {
      const questions = await courseQuestions();
      const before = learnView(await page.text());
      // 上一步停在做课的抽屉里，从抽屉里开始第一节。
      await page.click({ name: "开始", near: "进程的三种基本状态", selector: "[role=dialog] button" });
      await page.waitText("看例题");
      await until("抽屉收起", async () => (await openDialog(page)) === "", 5_000).catch(() => undefined);
      checks.expect("在抽屉里点“开始”以后抽屉收起，开始了第一节", (await openDialog(page)) === "", `打开着的是「${await openDialog(page)}」`);
      checks.expect("上课时右上角是“问辅导”", (await headerActions(page)) === "问辅导", await headerActions(page));
      // 故意把一道填空答成课程没有收的写法，第 7 条（改正答案后重判）要用它。
      const answered = await work(page, questions, { answers: { "os01.k1.q2": "执行" } });
      const text = await page.waitText("新课结束");
      checks.expect("从界面答完了这一节的练习", answered.length >= 6, answered.join("、"));
      checks.expect("这一节通过了", /新课结束\s*\n\s*通过了。/u.test(text));
      const after = learnView(text);
      notes.set("xp", after.xp);
      checks.expect("今日 XP 增加了", (after.xp ?? 0) > (before.xp ?? 0), `${before.xp ?? "?"} → ${after.xp ?? "?"}`);
      checks.expect("下一项任务是第二节新课", after.menu.includes("新课 进程控制块"), after.menu.join("；") || "菜单是空的");
      // 整门课一行读的是做课的状态，学完一节以后由插件通知重读，比菜单晚到一点。
      const shown = await page.waitFor("整门课一行显示已学 1", (current) => learnView(current).parts?.learned === 1, 5_000).catch(async () => page.text());
      checks.expect("“整门课”一行立即显示已学 1", learnView(shown).parts?.learned === 1, `显示 ${/\d+ 部分[^\n]*/u.exec(shown)?.[0] ?? "（没有这一行）"}`);
      // 结果画面上辅导和做课都进得去：反馈刚放出时正要问辅导，也可能要回去改课。
      const actions = await headerActions(page);
      checks.expect("结果画面上右上角有“问辅导”和“做课”两个入口", actions === "问辅导、做课", `是「${actions}」`);
      model.script(TUTOR_REQUEST, [{ tools: [{ name: "learning_task", arguments: {} }] }, { text: TUTOR_REPLY }]);
      const seen = model.toolResults.length;
      await page.click({ name: "问辅导", selector: "header button" });
      await until("辅导的抽屉打开", async () => (await openDialog(page)) === "辅导", 5_000);
      await page.fill("消息", TUTOR_REQUEST);
      await page.press("Enter");
      await page.waitText(TUTOR_REPLY, 30_000);
      const seenByTutor = model.toolResults.slice(seen).find((result) => result.tool === "learning_task")?.text ?? "";
      checks.expect("辅导读到的是刚结束的这一节和它的最后一道题", seenByTutor.includes("这项任务已经结束") && seenByTutor.includes("下面是最后一道题"), seenByTutor.split("\n")[0]);
      await page.shot("lesson-result-tutor");
      await page.press("Escape");
      await until("抽屉关上", async () => (await openDialog(page)) === "");
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
      checks.expect("刚做完的一节仍显示结果", /新课结束\s*\n\s*通过了。/u.test(text));
      checks.expect("菜单与关闭前相同", after.menu.join("；") === before.menu.join("；"), after.menu.join("；"));
      checks.expect("今日 XP 与关闭前相同", after.xp === notes.get("xp"), `${String(notes.get("xp"))} → ${after.xp ?? "?"}`);
      checks.expect("整门课显示已学 1", after.parts?.learned === 1, /\d+ 部分[^\n]*/u.exec(text)?.[0]);
    },
  },
  {
    id: "regrade",
    title: "回到做课的对话改正一道题可接受的答案并换用以后，过去的作答被重判，今日 XP 不减少",
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
      // 学过一节、回到菜单以后，从右上角回到原来那段做课的对话，接着说。
      await page.click({ name: "做课", selector: "header button" });
      await until("做课的抽屉打开", async () => (await openDialog(page)) === "做课", 5_000);
      // 右侧原来接着辅导的会话，换到做课时要读回那段对话。
      const earlier = await page.waitText("第一节可以学了", 10_000).catch(async () => page.text());
      checks.expect("抽屉里是原来那段做课的对话", earlier.includes("第一节可以学了"));
      checks.expect("学过一节以后抽屉里不再放菜单", !(await page.has({ name: "开始", selector: "[role=dialog] button" })));
      await page.fill("消息", FIX_REQUEST);
      await page.press("Enter");
      await page.waitText("改好了，“执行”现在也算对。", 30_000);
      const results = model.toolResults.slice(seen);
      const confirm = results.find((result) => result.tool === "course_confirm")?.text ?? "";
      const used = results.find((result) => result.tool === "course_use")?.text ?? "";
      checks.expect("只核对改过的那道题，一致", /这次发请求 1 次.*全部一致/u.test(confirm), confirm.split("\n")[0]);
      checks.expect("改后的课换用成功", used.startsWith("已换用"), used.split("\n")[0]);
      await page.press("Escape");
      await until("抽屉关上", async () => (await openDialog(page)) === "");
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
    id: "abort",
    title: "中止一节：回到菜单，右上角有“问辅导”和“做课”，能回到做课的对话",
    async run({ page }, checks) {
      await page.click({ name: "开始", near: "进程控制块", selector: "button" });
      await page.waitText("看例题");
      checks.expect("上课时右上角只有“问辅导”", (await headerActions(page)) === "问辅导", await headerActions(page));
      await page.click({ name: "中止新课", selector: "button" });
      await page.click({ name: /^中止$/u, selector: "[role=dialog] button" });
      const text = await page.waitText("已中止", 15_000);
      checks.expect("学习者自己中止的只说“已中止。”，不跟理由", /^已中止。$/mu.test(text), /已中止[^\n]*/u.exec(text)?.[0]);
      checks.expect("中止以后回到菜单，第二节仍可开始", learnView(text).menu.includes("新课 进程控制块"), learnView(text).menu.join("；") || "菜单是空的");
      const actions = await headerActions(page);
      checks.expect("中止以后右上角有“问辅导”和“做课”", actions === "问辅导、做课", `是「${actions}」`);
      await page.click({ name: "做课", selector: "header button" });
      await until("做课的抽屉打开", async () => (await openDialog(page)) === "做课", 5_000);
      const resumed = await page.waitText("改好了，“执行”现在也算对。", 10_000).catch(async () => page.text());
      checks.expect("做课的对话接着上一次", resumed.includes("改好了，“执行”现在也算对。"));
      await page.shot("abort-making");
      await page.press("Escape");
      await until("抽屉关上", async () => (await openDialog(page)) === "");
    },
  },
  {
    id: "grading-failures",
    title: "开放题判分时模型请求失败（余额不足、连不上）：按原因说一句，不记为错，可以再判",
    async run({ app, page, model }, checks) {
      const questions = await courseQuestions();
      await page.click({ name: "开始", near: "进程控制块", selector: "button" });
      await page.waitText("看例题");
      // 做到开放题出现：前两道必做题答完，开放题排在最后一道必做题之前。
      const answered = await work(page, questions, { stopBefore: "os02.k1.q4" });
      checks.expect("开放题出现之前答了这一节的前几道题", answered.length >= 1, answered.join("、"));
      for (const [failure, sentence, retry] of GRADING_FAILURE_TEXT) {
        model.failGrading(failure);
        const before = model.log.length;
        if (retry) await page.click({ name: "再判一次", selector: "button" });
        else {
          await page.fill("", "换下时寄存器和程序计数器存进进程控制块，恢复时取回。", { near: "为什么被换下处理机的进程" });
          await page.click({ name: /^提交$/u, selector: "button" });
        }
        const text = await page.waitText(sentence, 15_000);
        await page.shot(`grading-failure-${failure}`);
        const attempts = model.log.slice(before).filter((entry) => entry.kind === "grade").length;
        checks.expect(`${failure}：说“${sentence.slice(0, 24)}…”，只说一次`, occurrences(text, sentence) === 1, `判分请求 ${attempts} 次`);
        checks.expect(`${failure}：有“再判一次”和“先做下一题”`, await page.has({ name: "再判一次", selector: "button" }) && await page.has({ name: "先做下一题", selector: "button" }));
        checks.expect(`${failure}：那份作答没有判分记录（不记为错）`, await latestVerdict(app, "os02.k1.q4") === undefined, await latestVerdict(app, "os02.k1.q4"));
      }
      model.failGrading(undefined);
    },
  },
  {
    id: "mid-lesson",
    title: "一节课做到一半时关闭再打开，能接着做，没判出结果的不记为错",
    async run({ app, page, model }, checks) {
      const questions = await courseQuestions();
      // 上一步停在那道开放题没判出结果的画面；这次判分扣住不答，判分途中关闭。
      model.holdGrading();
      await page.click({ name: "再判一次", selector: "button" });
      await page.waitText("正在判分", 15_000);
      await until("判分请求到达假模型", async () => model.heldCount() > 0);
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
      checks.expect("接着把这一节做完并通过", /新课结束\s*\n\s*通过了。/u.test(done));
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
    id: "restructure",
    title: "让做课的 Agent 删掉一道学过的题、换上一道新题后换用：学过的结论和今日 XP 不变",
    async run({ app, page, model }, checks) {
      const before = learnView(await page.text());
      // 删掉学过并改判过的 os01.k1.q2，换上一道新题 os01.k1.q4：第一节的组成变了，题量照旧够。
      const space = path.join(app.home, "Repa", COURSE_NAME, "course");
      const topic = parse(await readFile(path.join(space, "topics", "os01.yaml"), "utf8")) as Record<string, unknown>;
      delete topic.verified;
      const first = (topic.kps as { practice: Record<string, unknown>[] }[])[0];
      const q1 = first?.practice.find((question) => question.id === "os01.k1.q1");
      if (!first || !q1) throw new Error("走查的课里没有 os01.k1.q1");
      first.practice = [
        ...first.practice.filter((question) => question.id !== "os01.k1.q2"),
        { ...structuredClone(q1), id: "os01.k1.q4", body: "一个进程已经拿到除处理机以外的全部资源，它处于哪种状态？" },
      ];
      const content = stringify(topic, { aliasDuplicateObjects: false });
      const root = path.join(app.dir, "course-restructured");
      await mkdir(path.join(root, "topics"), { recursive: true });
      await writeFile(path.join(root, "course.yaml"), await readFile(path.join(space, "course.yaml"), "utf8"));
      for (const name of await readdir(path.join(space, "topics"))) {
        await writeFile(path.join(root, "topics", name), name === "os01.yaml" ? content : await readFile(path.join(space, "topics", name), "utf8"));
      }
      model.setAnswers(await confirmationAnswers(root));
      model.script(RESTRUCTURE_REQUEST, [
        { tools: [{ name: "read", arguments: { path: "course/topics/os01.yaml" } }] },
        { tools: [{ name: "write", arguments: { path: "course/topics/os01.yaml", content } }] },
        { tools: [{ name: "course_check", arguments: {} }] },
        { tools: [{ name: "course_confirm", arguments: { topicIds: ["os01"] } }] },
        { tools: [{ name: "course_use", arguments: {} }] },
        { text: "换好了，第一节少了一道、多了一道新题。" },
      ]);
      const seen = model.toolResults.length;
      await page.click({ name: "新会话", selector: "a, button" });
      await page.fill("消息", RESTRUCTURE_REQUEST);
      await page.press("Enter");
      await page.waitText("换好了，第一节少了一道、多了一道新题。", 30_000);
      const used = model.toolResults.slice(seen).find((result) => result.tool === "course_use")?.text ?? "";
      checks.expect("删题以后的课换用成功", used.startsWith("已换用"), used.split("\n")[0]);
      await page.waitFor("侧栏列出这段会话", (text) => occurrences(text, RESTRUCTURE_REQUEST) >= 2);
      await page.click({ name: "学习", selector: "a, button" });
      const text = await page.waitFor("学习页和整门课", (current) => current.includes("整门课") && learnView(current).parts !== undefined, 30_000);
      const after = learnView(text);
      checks.expect("今日 XP 不变", after.xp === before.xp, `${before.xp ?? "?"} → ${after.xp ?? "?"}`);
      checks.expect("学过的部分不变", after.parts?.learned === before.parts?.learned, `${before.parts?.learned ?? "?"} → ${after.parts?.learned ?? "?"}`);
      checks.expect("删掉的那道题过去的判分还在、没有重判", await latestVerdict(app, "os01.k1.q2") === "correct", await latestVerdict(app, "os01.k1.q2"));
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
      // 快速勾上又取消“包含会话记录”：两次预览同时在途，后发的那一次（不含会话）是清单上的那份。
      // 经鼠标点两下之间至少隔 80 毫秒（等位置稳定），前一次预览往往已经回来；这里在页面里接连点两下。
      await page.evaluate<null>("(() => { const box = document.getElementById('export-sessions'); box.click(); box.click(); return null; })()");
      await until("清单回来、可以导出", async () => {
        const found = await page.find({ name: /^导出$/u, selector: "button" });
        return found.found && !found.disabled;
      }, 15_000);
      await page.click({ name: /^导出$/u, selector: "button" });
      const exported = await page.waitFor("导出完成或报错", (text) => text.includes("已导出") || text.includes("无法导出"), 30_000);
      checks.expect("快速切换选项以后导出仍然成功", exported.includes("已导出"), /无法导出\s*\n[^\n]*/u.exec(exported)?.[0]);
      const file = /(\/[^\n]*repa-learning-export-[^\n]*\.zip)/u.exec(exported)?.[1];
      checks.expect("页面写出导出文件的位置", file !== undefined, file);
      const entries = unzip(await readFile(file ?? ""));
      const records = [...entries.entries()].find(([name]) => name.endsWith("records.jsonl"))?.[1] ?? "";
      const facts = records.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type?: string });
      checks.expect("导出的文件里有作答记录", facts.some((fact) => fact.type === "answered") && facts.some((fact) => fact.type === "graded"),
        `${[...entries.keys()].join("、")}；records.jsonl ${facts.length} 条`);
      checks.expect("导出的是清单上那份（没有勾选，不含会话记录）", ![...entries.keys()].some((name) => name.includes("sessions/")), [...entries.keys()].join("、"));
      await page.press("Escape");
    },
  },
  {
    id: "expansion-failure",
    title: "后台展开时模型服务的账户余额不足：学习页说明原因，原文折叠，可以重试",
    async run({ page, model }, checks) {
      // 只让后台展开的任务失败；学习者与通用 Agent 的对话照常。
      model.failAgent(402, "在后台展开");
      model.script(OUTLINE_REQUEST, [
        { tools: [{ name: "read", arguments: { path: "course/course.yaml" } }] },
        { tools: [
          { name: "edit", arguments: { path: "course/course.yaml", edits: [{ oldText: "topics: [os01, os02]", newText: "topics: [os01, os02, os03]" }] } },
          { name: "write", arguments: { path: "course/topics/os03.yaml", content: OUTLINE_TOPIC } },
        ] },
        { tools: [{ name: "course_check", arguments: {} }] },
        { tools: [{ name: "course_use", arguments: {} }] },
        { text: "加好了“进程调度”的轮廓。" },
      ]);
      const seen = model.toolResults.length;
      await page.click({ name: "新会话", selector: "a, button" });
      await page.fill("消息", OUTLINE_REQUEST);
      await page.press("Enter");
      await page.waitText("加好了“进程调度”的轮廓。", 30_000);
      const used = model.toolResults.slice(seen).find((result) => result.tool === "course_use")?.text ?? "";
      checks.expect("加了轮廓的课换用成功", used.startsWith("已换用"), used.split("\n")[0]);
      // 这段会话随后列进侧栏，插在“学习”之上；等它出现再点，免得点下去时“学习”已经挪开。
      await page.waitFor("侧栏列出这段会话", (text) => occurrences(text, OUTLINE_REQUEST) >= 2);
      await page.click({ name: "学习", selector: "a, button" });
      const sentence = "模型服务的账户余额不足，充值后重试。";
      const text = await page.waitText(sentence, 30_000);
      // 整门课一节在任务和菜单下面，截图前滚到它。
      await page.evaluate<null>("(() => { document.getElementById('course-outline-title')?.scrollIntoView({ block: 'start' }); return null; })()");
      await page.shot("expansion-failure-402");
      const attempts = model.log.filter((entry) => entry.kind === "agent" && entry.note === "失败：402").length;
      checks.expect("学习页说“未完成：进程调度”和余额不足的那句话", text.includes("未完成：进程调度") && occurrences(text, sentence) === 1, `后台展开的请求 ${attempts} 次`);
      checks.expect("提供方的原文折叠在“原始报错”里，不直接摆在外面", text.includes("原始报错") && !text.includes("Insufficient Balance"));
      checks.expect("有“重试”", await page.has({ name: /^重试$/u, selector: "button" }));
      model.failAgent(undefined);
    },
  },
  {
    id: "model-failures",
    title: "模型请求失败（断开、超时、key 无效、余额不足、限流、服务端出错）：对话里按原因说一句中文，只说一次，重新发送能成功",
    async run({ app, page, model }, checks) {
      // 缩短请求超时和自动重试的间隔，让超时在几秒内发生；Pi 的自动重试照常进行（最多 3 次）。
      await app.reopen({ settings: { retry: { baseDelayMs: 50, provider: { timeoutMs: 2_000 } } } });
      await page.waitText("接下来", 30_000);
      for (const [failure, sentence] of FAILURE_TEXT) {
        await page.click({ name: "新会话", selector: "a, button" });
        const message = `走查：这次模型请求会失败（${failure}）`;
        model.script(message, [{ text: `重新发送以后收到了（${failure}）。` }]);
        model.failAgent(failure);
        const before = model.log.length;
        await page.fill("消息", message);
        await page.press("Enter");
        await page.waitText(sentence, 30_000);
        // 运行结束时页面按会话记录重画；等停止按钮消失后再数。
        await until("运行结束", async () => !(await page.has({ name: /^停止$/u, selector: "button" })), 30_000);
        const text = await page.text();
        const attempts = model.log.slice(before).filter((entry) => entry.kind === "agent").length;
        await page.shot(`model-failure-${failure}`);
        checks.expect(`${failure}：说“${sentence}”，只说一次`, occurrences(text, sentence) === 1, `出现 ${occurrences(text, sentence)} 次，模型请求 ${attempts} 次`);
        checks.expect(`${failure}：没有“运行出错”和提供方的英文原文直接摆在外面`, !text.includes("运行出错") && occurrences(text, "原始报错") === 1);
        if (failure === 401) checks.expect("key 无效时有“去设置模型”的入口", await page.has({ name: "去设置模型", selector: "a, button" }));
        model.failAgent(undefined);
        await page.fill("消息", message);
        await page.press("Enter");
        const after = await page.waitText(`重新发送以后收到了（${failure}）。`, 30_000);
        checks.expect(`${failure}：重新发送同一句话，这次有了回答`, after.includes(`重新发送以后收到了（${failure}）。`));
      }
    },
  },
  {
    id: "key-check",
    title: "在设置里填 API key：填错了不保存；连不上时照样保存并说明没能验证；填对了直接连上",
    async run({ page, model }, checks) {
      await page.click({ name: "设置", selector: "a, button" });
      await page.waitText("模型提供方", 15_000);
      const open = async () => {
        await page.click({ name: "添加提供方", selector: "button" });
        await page.fill("搜索提供方", "走查");
        await page.click({ name: "走查填 key", selector: "button" });
        await page.waitText("连接 走查填 key", 10_000);
      };
      // 已连接的提供方一行写着名称和“API key”。
      const connected = async () => /走查填 key\s*\n\s*API key/u.test(await page.text());
      const checked = () => model.log.filter((entry) => entry.kind === "key").map((entry) => entry.note);

      await open();
      await page.fill("API key", "key-wrong");
      await page.click({ name: /^保存$/u, selector: "button" });
      await page.waitText("这个 API key 无效，请核对后重新填写。", 15_000);
      await page.shot("key-check-rejected");
      checks.expect("填错的 key：对话框留着、说明原因，可以重填", await page.has({ name: /^保存$/u, selector: "button" }));
      checks.expect("填错的 key 先试发了一次请求", checked().at(-1) === "key-wrong：401", checked().join("；"));
      await page.press("Escape");
      await until("对话框关上", async () => (await openDialog(page)) === "");
      checks.expect("填错的 key 没有保存为已连接", !(await connected()));

      await open();
      await page.fill("API key", "key-offline");
      await page.click({ name: /^保存$/u, selector: "button" });
      await page.waitText("完成", 15_000);
      await page.shot("key-check-unverified");
      checks.expect("连不上时说明没能验证，由学习者关掉", (await page.text()).includes("已保存，但未能确认这个 key 是否可用。"));
      await page.click({ name: "完成", selector: "button" });
      await until("对话框关上", async () => (await openDialog(page)) === "");
      checks.expect("连不上时 key 照样保存", await connected());

      await open();
      await page.fill("API key", "key-good");
      await page.click({ name: /^保存$/u, selector: "button" });
      await until("对话框关上", async () => (await openDialog(page)) === "", 15_000);
      checks.expect("填对的 key 验证通过，对话框直接关上，显示已连接", await connected(), checked().join("；"));
    },
  },
  {
    id: "move-space",
    title: "把课程文件夹移到别处：重开后说明上次的课打不开，旧位置不再列出；从新位置选中打开，学习进度、会话和备份照旧",
    async run({ app, page }, checks) {
      await page.click({ name: "学习", selector: "a, button" });
      const before = learnView(await page.waitFor("学习页和菜单", (current) => current.includes("接下来") && current.includes("整门课"), 30_000));
      const sessionsBefore = (await (await app.rpc()).call("session.list", {})).length;
      const from = path.join(app.home, "Repa", COURSE_NAME);
      const to = path.join(app.home, "移动后", COURSE_NAME);
      // 学习者关掉应用，在文件管理器里把课程文件夹移走，再打开应用。关闭时的那份备份还在原位置的一组。
      await app.stopBackend();
      const old = await backups(app);
      await mkdir(path.dirname(to), { recursive: true });
      await rename(from, to);
      await app.startBackend();
      await app.open();
      const missing = await page.waitText("无法打开上次的空间", 30_000);
      await page.shot("move-space-missing");
      checks.expect("说明上次的课打不开和原因", missing.includes(`无法打开上次的空间 ${COURSE_NAME}`) && missing.includes("文件夹不存在，可能已被删除或移走。"),
        /无法打开上次的空间[\s\S]{0,60}/u.exec(missing)?.[0]);
      checks.expect("旧位置不再列在最近打开里", !missing.includes(from));
      await page.click({ name: /^选择(其他)?文件夹$/u, selector: "button" });
      await page.waitText("上一级", 10_000);
      await page.click({ name: "移动后", selector: "button" });
      await page.waitText(path.dirname(to), 10_000);
      await page.click({ name: COURSE_NAME, selector: "button" });
      await page.waitText("这是已有的学习空间。", 10_000);
      await page.click({ name: /^打开$/u, selector: "button" });
      const text = await page.waitFor("学习页和菜单", (current) => current.includes("接下来") && current.includes("整门课"), 30_000);
      await page.shot("move-space-reopened");
      const after = learnView(text);
      checks.expect("学习页与移动前相同：整门课、今日 XP、菜单", JSON.stringify(after) === JSON.stringify(before), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
      const sessionsAfter = (await (await app.rpc()).call("session.list", {})).length;
      checks.expect("会话都还在", sessionsAfter === sessionsBefore, `${sessionsBefore} → ${sessionsAfter}`);

      // 打开了空间时，侧栏里进选空间页的那一项写的是课名。
      await page.click({ name: COURSE_NAME, selector: "a" });
      const list = await page.waitText("最近打开", 15_000);
      checks.expect("最近打开里是新位置，没有旧位置", list.includes(to) && !list.includes(from));

      // 备份按空间的位置分组：新位置另起一组。打开空间以后就检查一次，那时做的就是新位置的第一份，带着移动前的学习记录。
      await until("新位置的第一份备份", async () => (await backups(app)).some((entry) => !old.includes(entry)), 30_000);
      const newest = (await backups(app)).find((entry) => !old.includes(entry)) ?? "";
      const manifest = JSON.parse(await readFile(path.join(newest, "manifest.json"), "utf8")) as { root?: string };
      const copied = await readFile(path.join(newest, "data", "plugins", "learning", "records.jsonl"), "utf8").catch(() => "");
      checks.expect("移动后的备份记的是新位置，带着学习记录", manifest.root === to && copied.includes("\"type\":\"answered\""), manifest.root);
    },
  },
  {
    id: "course-location",
    title: "新建课程时换位置：选另一个文件夹，课建在它下面的 Repa 里；之后新建仍放在那里",
    async run({ app, page }, checks) {
      const change = strings["learningSpace.first.location.change.action"];
      const choose = strings["folderPicker.location.action"];
      const where = (text: string) => /保存位置：([^\n]*)/u.exec(text)?.[1]?.trim() ?? "";
      const other = path.join(app.home, "资料 盘");
      const folder = path.join(other, "Repa");
      await mkdir(other, { recursive: true });
      await page.click({ name: "新建课程", selector: "a" });
      const first = await page.waitText("保存位置：", 15_000);
      checks.expect("起名之前就写出位置：用户目录下的 Repa", where(first) === path.join(app.home, "Repa"), where(first));
      await page.click({ name: change, selector: "button" });
      await page.waitText("上一级", 10_000);
      await page.click({ name: "资料 盘", selector: "button" });
      const picked = await page.waitText(other, 10_000);
      await page.shot("course-location-picker");
      checks.expect("选择框写出课程将放在选定位置下的 Repa", picked.includes(strings["folderPicker.location.hint"].replace("{path}", folder)));
      await page.click({ name: choose, selector: "button", near: "上一级" });
      await until("选择框关上", async () => (await openDialog(page)) === "");
      await page.fill("课程名称", "线性代数");
      const named = await page.waitText(path.join(folder, "线性代数"), 10_000);
      await page.shot("course-location-named");
      checks.expect("位置换成选定的文件夹", where(named) === path.join(folder, "线性代数"), where(named));
      await page.click({ name: /^创建$/u, selector: "button" });
      await page.waitText("想学的内容与目标", 20_000);
      checks.expect("课建在选定位置下", await access(path.join(folder, "线性代数", ".repa", "format.json")).then(() => true, () => false));

      await app.reopen();
      await page.waitText("想学的内容与目标", 30_000);
      await page.click({ name: "新建课程", selector: "a" });
      const again = await page.waitText("保存位置：", 15_000);
      checks.expect("重开以后新建仍放在选过的位置", where(again) === folder, where(again));
    },
  },
];
