// 知识库是一个文件夹：其中每个文件夹各有自己的对话，Markdown 文件是卡片，Repa 自己的数据在 .repa/ 里。扫描每次从盘上读，不另存索引。
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { folderOf, resolveLink, titleOf, wikiTargets } from "./links.js";

/** 需要调用方按类别处理的错误：not_found、conflict、bad_request。 */
export class RepaFault extends Error {
  constructor(readonly code: "not_found" | "conflict" | "bad_request", message: string, readonly details?: unknown) {
    super(message);
  }
}

/** 一张卡片或一页 MOC。路径相对知识库、以 / 分隔；文件头读不出来时 error 写明原因，其余字段按没写处理。 */
export interface Page {
  path: string;
  title: string;
  folder: string;
  id?: string;
  summary: string;
  keep?: boolean;
  requires: string[];
  review?: string;
  moc: boolean;
  body: string;
  text: string;
  mtime: number;
  /** 文件的建立时间（毫秒）。知识库的图按它排石头，新卡片落在外沿。 */
  created?: number;
  error?: string;
}

/** 资料：`_` 开头的文件夹、克隆下来的仓库，以及文件夹里的非 Markdown 文件。列在树里，不算卡片。 */
export interface Material {
  path: string;
  kind: "folder" | "repo" | "file";
}

/** 一次扫描的结果。folders 是全部文件夹，按先序排列，根是空字符串；pages 是卡片和 MOC，顺序就是同名链接取“排在最前”时的顺序。 */
export interface Kb {
  root: string;
  folders: string[];
  pages: Page[];
  materials: Material[];
  agentsFiles: string[];
  byPath: Map<string, Page>;
}

const FRONT_MATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/u;
const COLLATOR = new Intl.Collator("zh-CN", { numeric: true });

/** 扫描整个知识库。以点开头的、名为 node_modules 的文件夹不列出；`_` 开头的和含 .git 的（根除外）只列为资料，不算文件夹。 */
export async function scanKb(root: string): Promise<Kb> {
  const kb: Kb = { root, folders: [], pages: [], materials: [], agentsFiles: [], byPath: new Map() };
  await walk(kb, "");
  for (const page of kb.pages) kb.byPath.set(page.path, page);
  return kb;
}

async function walk(kb: Kb, folder: string): Promise<boolean> {
  const entries = await readdir(path.join(kb.root, folder), { withFileTypes: true });
  if (folder !== "" && entries.some((entry) => entry.name === ".git")) return false;
  kb.folders.push(folder);
  entries.sort((a, b) => COLLATOR.compare(a.name, b.name));
  for (const entry of entries) {
    const child = folder === "" ? entry.name : `${folder}/${entry.name}`;
    // 写卡片时旁边短暂存在的 .repa-tmp 不是资料
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name.endsWith(".repa-tmp")) continue;
    if (entry.isDirectory()) {
      if (entry.name.startsWith("_")) kb.materials.push({ path: child, kind: "folder" });
      else if (!(await walk(kb, child))) kb.materials.push({ path: child, kind: "repo" });
    } else if (entry.isFile()) {
      if (entry.name === "AGENTS.md") kb.agentsFiles.push(child);
      else if (entry.name.endsWith(".md")) kb.pages.push(await readPage(kb.root, child));
      else kb.materials.push({ path: child, kind: "file" });
    }
  }
  return true;
}

async function readPage(root: string, rel: string): Promise<Page> {
  const file = path.join(root, rel);
  const [text, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
  // 有的文件系统不记建立时间，birthtime 是 0，这时用 ctime
  return { ...parsePage(rel, text, info.mtimeMs), created: info.birthtimeMs || info.ctimeMs };
}

/** 解析一张页面的文件头与正文。文件头的各项都可以不写；requires 里写成 `[[页表]]` 的也认。 */
export function parsePage(rel: string, text: string, mtime: number): Page {
  const match = FRONT_MATTER.exec(text);
  const body = match ? text.slice(match[0].length) : text;
  let data: Record<string, unknown> = {};
  let error: string | undefined;
  try {
    const value: unknown = match?.[1] ? parse(match[1]) : null;
    if (isRecord(value)) data = value;
    else if (value !== null) error = "文件头不是“名称: 值”的形式";
  } catch (cause) {
    error = `文件头读不出来：${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)}`;
  }
  const requires = Array.isArray(data.requires) ? data.requires : typeof data.requires === "string" ? [data.requires] : [];
  const page: Page = {
    path: rel,
    title: titleOf(rel),
    folder: folderOf(rel),
    summary: typeof data.summary === "string" && data.summary.trim() ? data.summary.trim() : firstLine(body),
    requires: requires.map((item) => String(item).replace(/^\[\[|\]\]$/gu, "").trim()).filter(Boolean),
    moc: data.moc === true,
    body,
    text,
    mtime,
  };
  if (typeof data.id === "string" || typeof data.id === "number") page.id = String(data.id);
  if (typeof data.keep === "boolean") page.keep = data.keep;
  if (data.review instanceof Date) page.review = data.review.toISOString().slice(0, 10);
  else if (typeof data.review === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(data.review)) page.review = data.review;
  if (error) page.error = error;
  return page;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstLine(body: string): string {
  const line = body.split("\n").map((item) => item.replace(/^#+\s*/u, "").trim()).find(Boolean) ?? "";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/** 卡片：除 MOC 以外的页面。 */
export function cardsOf(kb: Kb): Page[] {
  return kb.pages.filter((page) => !page.moc);
}

/** 从某个文件夹出发找 [[链接]] 的目标页面。 */
export function resolvePage(kb: Kb, fromFolder: string, target: string): Page | undefined {
  const found = resolveLink([...kb.byPath.keys()], fromFolder, target);
  return found === undefined ? undefined : kb.byPath.get(found);
}

/** MOC 正文里列出的卡片，以及找不到目标的链接。 */
export function mocMembers(kb: Kb, moc: Page): { members: Page[]; broken: string[] } {
  const members: Page[] = [];
  const broken: string[] = [];
  for (const target of wikiTargets(moc.body)) {
    const page = resolvePage(kb, moc.folder, target);
    if (!page) broken.push(target);
    else if (!page.moc && !members.includes(page)) members.push(page);
  }
  return { members, broken };
}

/** 是否纳入复习：卡片自己写了 keep 就按它；否则看有没有写了 `keep: true` 的 MOC 列出它。 */
export function keptPaths(kb: Kb): Set<string> {
  const kept = new Set<string>();
  for (const page of kb.pages) {
    if (page.moc && page.keep === true) for (const member of mocMembers(kb, page).members) kept.add(member.path);
  }
  for (const page of kb.pages) {
    if (page.keep === true) kept.add(page.path);
    if (page.keep === false) kept.delete(page.path);
  }
  for (const page of kb.pages) if (page.moc) kept.delete(page.path);
  return kept;
}

/** 正文链接与 requires 里找不到目标的项。 */
export function brokenLinks(kb: Kb, page: Page): string[] {
  const targets = [...wikiTargets(page.body), ...page.requires];
  return [...new Set(targets.filter((target) => !resolvePage(kb, page.folder, target)))];
}

/** 正文里链到这张页面的其他页面。 */
export function backlinks(kb: Kb, page: Page): Page[] {
  return kb.pages.filter((other) => other !== page && wikiTargets(other.body).some((target) => resolvePage(kb, other.folder, target) === page));
}

/** 这个文件夹及其下的卡片数。 */
export function cardCount(kb: Kb, folder: string): number {
  return kb.pages.filter((page) => !page.moc && within(folder, page.folder)).length;
}

/** folder 是否就是 ancestor 或在它的下面。 */
export function within(ancestor: string, folder: string): boolean {
  return ancestor === "" || folder === ancestor || folder.startsWith(`${ancestor}/`);
}

/** 把相对知识库的路径换成绝对路径；走出知识库就拒绝。 */
export function resolveIn(root: string, rel: string): string {
  const file = path.resolve(root, rel);
  if (!inside(root, file)) throw new RepaFault("bad_request", `${rel} 不在知识库里。`);
  return file;
}

/** 绝对路径是否在 root 之内（含 root 本身）。 */
export function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 读文件，不存在时返回 undefined；其他错误照常抛出。 */
export async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * 写一张卡片或知识库里的文件：先把全文写进旁边的临时文件，再原地写目标文件，成功后删掉临时文件。
 * 原地写不换名，文件的建立时间不变，知识库的图里石头不挪；先留的临时文件保证写失败时盘上仍有一份完整的内容：
 * 临时文件写不进去（例如磁盘满）时原文件没动，原地写失败时全文留在临时文件里。不写恢复的代码，报错即可。
 */
export async function writeCard(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.repa-tmp`;
  await writeFile(temporary, text);
  await writeFile(file, text);
  await rm(temporary);
}

/** Repa 自己的数据（设置、模式）先写临时文件再改名，写到一半失败时原文件不受影响。 */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.repa-tmp`;
  await writeFile(temporary, text);
  await rename(temporary, file);
}

/** 文件头里的 id，没有时返回 undefined。 */
export function idOf(text: string): string | undefined {
  return parsePage("x.md", text, 0).id;
}

/** 把文件头的一项设为给定的值，值为 undefined 时删去这一行；其余文字原样保留。新加的 id 放在最前，其余加在最后；没有文件头就加一个，删空了就去掉。 */
export function setField(text: string, key: string, value: string | undefined): string {
  const match = FRONT_MATTER.exec(text);
  const body = match ? text.slice(match[0].length) : text;
  const lines = match?.[1] ? match[1].split(/\r?\n/u) : [];
  const at = lines.findIndex((line) => new RegExp(`^${key}\\s*:`, "u").test(line));
  if (value === undefined && at >= 0) lines.splice(at, 1);
  else if (value !== undefined && at >= 0) lines[at] = `${key}: ${value}`;
  else if (value !== undefined && key === "id") lines.unshift(`${key}: ${value}`);
  else if (value !== undefined) lines.push(`${key}: ${value}`);
  if (!match && value === undefined) return text;
  return lines.length ? `---\n${lines.join("\n")}\n---\n${body}` : body;
}

/** 把文件头的 id 设为给定值。 */
export function setId(text: string, id: string): string {
  return setField(text, "id", id);
}

/** 改一张卡片是否纳入复习和手定的复习日期，只动文件头里那一行；null 删去这一行。返回新的修改时间。 */
export async function setCardMeta(root: string, rel: string, change: { keep?: boolean | null; review?: string | null }): Promise<number> {
  if (typeof change.review === "string" && !/^\d{4}-\d{2}-\d{2}$/u.test(change.review)) throw new RepaFault("bad_request", "复习日期要写成 YYYY-MM-DD。");
  const file = resolveIn(root, rel);
  let text = await readFile(file, "utf8");
  if (change.keep !== undefined) text = setField(text, "keep", change.keep === null ? undefined : String(change.keep));
  if (change.review !== undefined) text = setField(text, "review", change.review ?? undefined);
  await writeCard(file, text);
  return (await stat(file)).mtimeMs;
}

/** 卡片第一次被练习时写入 8 位随机 id，已有就直接返回。 */
export async function ensureId(root: string, page: Page): Promise<string> {
  if (page.id) return page.id;
  // 首位用字母：全是数字或形如 12e45678 的 id 会被 YAML 读成数。
  const id = [...randomBytes(8)].map((byte, index) => (index === 0 ? 10 + (byte % 26) : byte % 36).toString(36)).join("");
  const file = resolveIn(root, page.path);
  await writeCard(file, setId(await readFile(file, "utf8"), id));
  page.id = id;
  return id;
}

/** 在 Repa 里保存或新建一张卡片。mtime 是打开时的修改时间：文件此后被别处改过，就拒绝并带回最新内容。 */
export async function saveCard(root: string, rel: string, text: string, mtime: number | undefined): Promise<number> {
  if (!rel.endsWith(".md")) throw new RepaFault("bad_request", "卡片的文件名要以 .md 结尾。");
  const file = resolveIn(root, rel);
  const current = await readOptional(file);
  if (mtime === undefined && current !== undefined) throw new RepaFault("conflict", `${rel} 已经存在。`);
  if (mtime !== undefined) {
    if (current === undefined) throw new RepaFault("not_found", `${rel} 已经不在了。`);
    const now = (await stat(file)).mtimeMs;
    if (now !== mtime) throw new RepaFault("conflict", `${rel} 在打开以后被改过。`, { text: current, mtime: now });
  }
  await writeCard(file, text);
  return (await stat(file)).mtimeMs;
}

/** 新建一个文件夹。 */
export async function createFolder(root: string, rel: string): Promise<void> {
  const folder = resolveIn(root, rel);
  if ((await stat(folder).catch(() => undefined)) !== undefined) throw new RepaFault("conflict", `${rel} 已经存在。`);
  await mkdir(folder, { recursive: true });
}

// 旧版本存在 .repa/versions/<相对路径>/<时间>-<标签><扩展名>；改写前文件不存在时，扩展名是 .absent，撤回它就是删除文件。
const VERSIONS = ".repa/versions";

function versionDir(root: string, rel: string): string {
  return path.join(root, VERSIONS, rel);
}

function safeLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9_-]/gu, "_");
}

/** 把文件此刻的内容留一份旧版本，返回版本名。标签是工具调用编号，或撤回时的 revert。 */
export async function saveVersion(root: string, rel: string, label: string): Promise<string> {
  const text = await readOptional(resolveIn(root, rel));
  const stamp = new Date().toISOString().replace(/[-:.]/gu, "");
  const name = `${stamp}-${safeLabel(label)}${text === undefined ? ".absent" : path.extname(rel) || ".txt"}`;
  await mkdir(versionDir(root, rel), { recursive: true });
  await writeFile(path.join(versionDir(root, rel), name), text ?? "");
  return name;
}

async function versionNames(root: string, rel: string): Promise<string[]> {
  const names = await readdir(versionDir(root, rel)).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  return names.sort();
}

async function readVersion(root: string, rel: string, name: string): Promise<string | undefined> {
  if (name.endsWith(".absent")) return undefined;
  return readFile(path.join(versionDir(root, rel), path.basename(name)), "utf8");
}

/** 一次改动前后的全文：before 是改动前留的版本，after 是下一份版本或当前文件；不存在的一侧是 undefined。 */
export async function changeOf(root: string, rel: string, label: string): Promise<{ version: string; before?: string; after?: string }> {
  const names = await versionNames(root, rel);
  const at = names.findIndex((name) => name.includes(`-${safeLabel(label)}.`));
  const version = names[at];
  if (version === undefined) throw new RepaFault("not_found", `没有找到 ${rel} 的这次改动。`);
  const next = names[at + 1];
  const before = await readVersion(root, rel, version);
  const after = next === undefined ? await readOptional(resolveIn(root, rel)) : await readVersion(root, rel, next);
  return { version, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) };
}

/** 把文件恢复成某个版本。恢复前当前内容留一份，返回它的版本名，所以撤回本身也能撤回。id 归程序所有，恢复时保留当前的 id。 */
export async function revert(root: string, rel: string, name: string): Promise<string> {
  const file = resolveIn(root, rel);
  const current = await readOptional(file);
  const target = await readVersion(root, rel, name);
  const saved = await saveVersion(root, rel, "revert");
  if (target === undefined) {
    await rm(file, { force: true });
    return saved;
  }
  const id = current === undefined ? undefined : idOf(current);
  await writeCard(file, id !== undefined && idOf(target) !== id && rel.endsWith(".md") ? setId(target, id) : target);
  return saved;
}
