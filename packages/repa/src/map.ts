// 每一轮交给模型的地图与模式，以及它们所依据的一次查询：扫描知识库、读练习记录、算复习。地图不另存，每次现算。
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { cardCount, cardsOf, keptPaths, mocMembers, readOptional, resolvePage, scanKb, within, writeAtomic, type Kb, type Page } from "./kb.js";
import { localTime, readLog, type LogEntry, type Result } from "./log.js";
import { computeReview, dayOf, practicesOf, type CardReview, type Practice, type Suggestions } from "./review.js";

/** 一次查询的结果，地图、首页、卡片页和工具都从它取数。 */
export interface State {
  kb: Kb;
  log: LogEntry[];
  practices: Practice[];
  kept: Set<string>;
  review: Map<string, CardReview>;
  suggestions: Suggestions;
  today: number;
  byId: Map<string, Page>;
}

/** 从盘上读一遍知识库和练习记录，算出今天的复习。limit 是今天建议的张数，只有“今日”用得上，缺省不设上限。 */
export async function loadState(root: string, now = new Date(), limit: number | null = null): Promise<State> {
  const [kb, log] = await Promise.all([scanKb(root), readLog(root)]);
  const kept = keptPaths(kb);
  const cards = cardsOf(kb);
  const today = dayOf(localTime(now));
  const { cards: review, suggestions } = computeReview(
    cards.map((card) => ({
      path: card.path,
      keep: kept.has(card.path),
      requires: card.requires,
      ...(card.id === undefined ? {} : { id: card.id }),
      ...(card.review === undefined ? {} : { review: card.review }),
    })),
    log,
    today,
    limit,
  );
  const byId = new Map(cards.flatMap((card) => (card.id === undefined ? [] : [[card.id, card] as const])));
  return { kb, log, practices: practicesOf(log), kept, review, suggestions, today, byId };
}

/** from 到 to（含）每一天到期的和练过的卡片。到期按下一次到期的那天，已经逾期的算在今天；练过的是那天有过判定的。 */
export function calendarDays(state: State, from: number, to: number): Map<number, { due: string[]; practiced: string[] }> {
  const days = new Map<number, { due: string[]; practiced: string[] }>();
  for (let day = from; day <= to; day += 1) days.set(day, { due: [], practiced: [] });
  for (const [path, review] of state.review) {
    if (review.nextDue !== undefined) days.get(Math.max(review.nextDue, state.today))?.due.push(path);
    for (const day of review.practicedDays) days.get(day)?.practiced.push(path);
  }
  return days;
}

/** 结果的中文说法。 */
export const RESULT_LABEL: Record<Result, string> = { pass: "正确", partial: "部分正确", fail: "错误" };

const FOLDER_LIMIT = 40;
const LINKED_LIMIT = 20;
const CHILD_LIMIT = 20;
const DUE_LIMIT = 20;
const MISSED_LIMIT = 5;

function folderName(folder: string): string {
  return folder === "" ? "知识库" : folder.slice(folder.lastIndexOf("/") + 1);
}

function where(folder: string): string {
  return folder === "" ? "知识库" : folder;
}

/** 某个文件夹的子文件夹。 */
export function childFolders(kb: Kb, folder: string): string[] {
  return kb.folders.filter((item) => item !== folder && within(folder, item) && !item.slice(folder === "" ? 0 : folder.length + 1).includes("/"));
}

/** 一个文件夹的列表：其中的卡片、专题列进来的卡片、先修和子文件夹。kb_browse 和地图共用。 */
export function folderListing(state: State, folder: string): string[] {
  const { kb } = state;
  const own = kb.pages.filter((page) => page.folder === folder);
  const cards = own.filter((page) => !page.moc);
  const shown = cards.length > FOLDER_LIMIT ? [...cards].sort((a, b) => b.mtime - a.mtime).slice(0, FOLDER_LIMIT) : cards;
  const lines = [`【这个文件夹】${cards.length} 张卡片${cards.length > shown.length ? `，下面是最近改过的 ${shown.length} 张` : ""}`];
  for (const card of shown) lines.push(`- ${card.title}：${card.summary}${card.error ? `（${card.error}）` : ""}`);
  const linked: string[] = [];
  for (const moc of own.filter((page) => page.moc)) {
    const { members, broken } = mocMembers(kb, moc);
    for (const member of members.filter((page) => page.folder !== folder)) linked.push(`- ${moc.title} → ${member.title}（${where(member.folder)}）：${member.summary}`);
    for (const target of broken) linked.push(`- ${moc.title} → ${target}（找不到这张卡片）`);
  }
  const listed = new Set([...cards, ...own.filter((page) => page.moc).flatMap((moc) => mocMembers(kb, moc).members)]);
  const prerequisites: string[] = [];
  for (const card of listed) {
    for (const target of card.requires) {
      const page = resolvePage(kb, card.folder, target);
      if (page && listed.has(page)) continue;
      const fading = page && state.kept.has(page.path) && state.review.get(page.path)?.due;
      const line = page ? `- ${page.title}（${where(page.folder)}）${fading ? "：快忘了" : ""}` : `- ${target}（${card.title} 的先修，找不到这张卡片）`;
      if (!prerequisites.includes(line)) prerequisites.push(line);
    }
  }
  const room = Math.max(0, LINKED_LIMIT - linked.length);
  if (linked.length) lines.push("【专题列进来的】", ...linked.slice(0, LINKED_LIMIT));
  if (prerequisites.length && room) lines.push("【先修】", ...prerequisites.slice(0, room));
  const children = childFolders(kb, folder);
  if (children.length) lines.push(`【子文件夹】${children.slice(0, CHILD_LIMIT).map((child) => `${folderName(child)}（${cardCount(kb, child)} 张）`).join(" · ")}`);
  return lines;
}

/** 一个文件夹的地图，分成两个系统提示段落：map 随卡片变化，review 随练习变化，各自只在变了时由 Pi 追加。 */
export function buildMap(state: State, folder: string): { map: string; review: string } {
  const { kb } = state;
  const parts = folder === "" ? [] : folder.split("/");
  const ancestors = ["", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))].slice(0, -1);
  const upper = ancestors.reverse().map((item) => `${folderName(item)} ${cardCount(kb, item)} 张`).join("；");
  const location = ["知识库", ...parts].join(" / ");
  const map = [`【位置】${location}${upper ? `（上级文件夹：${upper}）` : `（${cardCount(kb, "")} 张卡片）`}`, ...folderListing(state, folder)];
  if (folder !== "") map.push(`【顶层的文件夹】${childFolders(kb, "").map((child) => `${folderName(child)} ${cardCount(kb, child)}`).join(" · ")}`);

  const due = kb.pages
    .filter((page) => !page.moc && within(folder, page.folder))
    .flatMap((page) => {
      const item = state.review.get(page.path);
      return item && !item.practicedToday && (item.manualDue || item.due) ? [{ page, item }] : [];
    })
    .sort((a, b) => b.item.overdueDays - a.item.overdueDays);
  const review: string[] = [];
  if (due.length) {
    const shown = due.slice(0, DUE_LIMIT).map(({ page, item }) => `${page.title}（${item.overdueDays ? `逾期 ${item.overdueDays} 天` : "今天"}）`);
    review.push(`【到期的复习】${shown.join("；")}${due.length > shown.length ? `；共 ${due.length} 张` : ""}`);
  }
  const missed = state.practices
    .filter((practice) => practice.grade && practice.grade.result !== "pass" && within(folder, practiceFolder(state, practice) ?? "\u0000"))
    .slice(-MISSED_LIMIT)
    .reverse();
  if (missed.length) {
    review.push("【最近没答好的练习】");
    for (const practice of missed) review.push(`- ${practiceLine(state, practice)}`);
  }
  return { map: map.join("\n"), review: review.length ? review.join("\n") : "没有到期的复习，最近也没有没答好的练习。" };
}

function practiceFolder(state: State, practice: Practice): string | undefined {
  return practice.card === undefined ? practice.folder : state.byId.get(practice.card)?.folder;
}

function practiceLine(state: State, practice: Practice): string {
  const card = practice.card === undefined ? undefined : state.byId.get(practice.card);
  const subject = card ? card.title : `（不属于卡片）${(practice.quiz?.questions[0]?.text ?? "").slice(0, 30)}`;
  const grade = practice.grade;
  return `${practice.t.slice(5, 10)} ${subject}${grade ? `，${RESULT_LABEL[grade.result]}：${grade.note}` : "，未判定"}`;
}

/** 一张卡片以前的练习：题目、作答和结果，最近的在前。practice_history 和复习时附带的材料共用。 */
export function formatPractices(state: State, cardId: string | undefined, limit: number): string {
  const practices = state.practices.filter((practice) => cardId !== undefined && practice.card === cardId).slice(-limit).reverse();
  if (!practices.length) return "这张卡片还没有练习过。";
  return practices.map((practice) => {
    const lines = [`- ${practiceLine(state, practice)}`];
    for (const [index, question] of (practice.quiz?.questions ?? []).entries()) {
      const answer = practice.quiz?.answers?.[index];
      lines.push(`  题 ${index + 1}：${question.text}${question.options?.length ? `（选项：${question.options.join(" / ")}）` : ""}`);
      lines.push(`  答：${answer ?? "没有作答"}`);
    }
    if (practice.grade?.external) lines.push(`  外部评测：${practice.grade.external}`);
    return lines.join("\n");
  }).join("\n");
}

// 模式是 .repa/modes/ 里的 Markdown 文件，首次启动时写入下面三个，之后归学习者修改。
const DEFAULT_MODES: Record<string, string> = {
  学习: "学习者在这个文件夹里学新的内容或讨论问题。先弄清卡在哪里再讲，讲完用 quiz 出一两道具体的题确认真的懂了，不问“懂了吗”。讨论中出现值得长期留下的概念时，提议整理成卡片，同意后再写。\n",
  复习: "这段对话用来复习附带的那张卡片。第一条回复直接出题，不先讲解。出题时参考卡片和以前的练习，换一个角度问，不照搬原题。作答后如实判定，用 grade 记下结果和一句讲评。错误或部分正确时讲清错在哪里，再出一道同类的题。\n",
  整理: "这段对话用来整理知识库。把讨论过的内容整理成卡片：一张卡片一个概念，写上 summary。提议先修（requires）、专题和是否纳入复习（keep）时说明理由，同意后再写。不改写学习者写的段落，要改时先说明改什么。\n",
};

/** 学习是新对话的默认模式，复习是复习对话的模式。 */
export const LEARN_MODE = "学习";
export const REVIEW_MODE = "复习";

function modesDir(root: string): string {
  return path.join(root, ".repa", "modes");
}

/** 首次启动时写入默认的三个模式；目录已经存在就不动。 */
export async function ensureModes(root: string): Promise<void> {
  if ((await readdir(modesDir(root)).catch(() => undefined)) !== undefined) return;
  await mkdir(modesDir(root), { recursive: true });
  for (const [name, text] of Object.entries(DEFAULT_MODES)) await writeFile(path.join(modesDir(root), `${name}.md`), text);
}

/** 现有的模式名。 */
export async function listModes(root: string): Promise<string[]> {
  const names = await readdir(modesDir(root));
  return names.filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)).sort();
}

/** 一个模式的全文，交给 Pi 作为 repa_mode 段落。 */
export async function readMode(root: string, name: string): Promise<string> {
  return `当前模式：${name}\n${(await readOptional(path.join(modesDir(root), `${path.basename(name)}.md`))) ?? "（这个模式的文件不在了。）"}`;
}

/**
 * .repa/settings.json：两个确认开关，新对话的默认模型（provider/id）和 thinking 级别，每天建议的张数（null 是不设上限），
 * 外观，以及界面自己读写的键位表。模型和级别与 Pi 自己的设置分开，不读也不改。
 */
export interface Settings {
  confirmEdits: boolean;
  confirmCommands: boolean;
  model?: string;
  thinking?: string;
  dailyLimit: number | null;
  appearance: "system" | "light" | "dark";
  keys: Record<string, unknown>;
}

const APPEARANCES: ReadonlyArray<Settings["appearance"]> = ["system", "light", "dark"];

function settingsFile(root: string): string {
  return path.join(root, ".repa", "settings.json");
}

/** 读设置，没有文件时都是默认值。 */
export async function readSettings(root: string): Promise<Settings> {
  const text = await readOptional(settingsFile(root));
  const value = (text === undefined ? {} : JSON.parse(text)) as Partial<Settings>;
  return {
    confirmEdits: value.confirmEdits === true,
    confirmCommands: value.confirmCommands === true,
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.thinking === "string" ? { thinking: value.thinking } : {}),
    dailyLimit: value.dailyLimit === null || (typeof value.dailyLimit === "number" && value.dailyLimit >= 0) ? value.dailyLimit : 10,
    appearance: APPEARANCES.includes(value.appearance as Settings["appearance"]) ? (value.appearance as Settings["appearance"]) : "system",
    keys: value.keys !== null && typeof value.keys === "object" && !Array.isArray(value.keys) ? value.keys : {},
  };
}

/** 改几项设置，返回改后的全部设置。 */
export async function updateSettings(root: string, change: Partial<Settings>): Promise<Settings> {
  const next = { ...(await readSettings(root)), ...change };
  await writeAtomic(settingsFile(root), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** 复习一张卡片时附在消息里的材料：卡片全文与最近几次练习，Agent 的第一次回复因此可以直接出题。 */
export async function reviewMaterial(state: State, page: Page): Promise<string> {
  const text = await readFile(path.join(state.kb.root, page.path), "utf8");
  return [`复习的卡片：${page.path}`, "卡片全文：", text, "最近的练习：", formatPractices(state, page.id, 5)].join("\n");
}
