/**
 * 空间里自制的课。做课的 Agent 在空间的 course/ 里写课（格式与随包课程相同：course.yaml 加 topics/），
 * 用 course_check 检查，用 course_use 换用。学习从不直接读 course/：换用时把检查过的那一份复制进插件数据目录的
 * courses/<摘要>/，学习只读这份副本，所以写到一半的 course/ 不会进入学习者的课、复习和测验。数据目录的 course.json 记下正在用的副本。
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { move, RepaFault, syncDirectory, syncTree, writeJson } from "@repa/base";
import type { Host } from "@repa/base/plugin";
import { object, parse } from "@repa/base/protocol";
import { Type, type Static } from "typebox";

import { confirmCourse, type ConfirmOptions, type ConfirmResult } from "./check/confirm.js";
import { checkCourse, type CheckOptions, type CheckResult } from "./check/course.js";
import { topicContent } from "./check/items.js";
import { teachesPython } from "./check/rules.js";
import type { ResolvedCourse } from "./course-sources.js";
import { formatDiagnostic, Report, type Diagnostic } from "./format/diagnostics.js";
import { COURSE_FILE, loadCourse, TOPICS_DIRECTORY } from "./format/load.js";

/** 空间里放自制课的文件夹。 */
export const SPACE_COURSE = "course";
/** 数据目录里记下换用状态的文件。 */
export const COURSE_CHOICE_FILE = "course.json";
/** 数据目录里存放换用过的副本的文件夹。 */
const COPIES = "courses";
/** 数据目录里检查用的临时副本，检查完就删；插件打开时清掉上次中断留下的。 */
export const CHECKS = "checks";

const CopyIdSchema = Type.String({ pattern: "^[0-9a-f]{32}$" });
/** course.json：active 是学习正在用的副本的摘要。 */
export const CourseChoiceSchema = object({
  active: Type.Optional(CopyIdSchema),
});
/** 换用状态。 */
export type CourseChoice = Static<typeof CourseChoiceSchema>;

/** 从空间读出的一份课程文件：相对 course/ 的路径与全文。 */
export type CourseFiles = Map<string, string>;

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
}

/** 文件或文件夹不存在时得到 undefined，别的错误照常抛出。 */
async function unlessMissing<T>(work: Promise<T>): Promise<T | undefined> {
  try {
    return await work;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

/** 空间里有没有 course/。读不了的（例如循环的符号链接）也算有：这门课用不了，由 course_check 报出原因。 */
export async function hasSpaceCourse(files: Host["files"]): Promise<boolean> {
  try {
    await files.list(SPACE_COURSE);
    return true;
  } catch (error) {
    return !missing(error);
  }
}

/**
 * 经空间的文件接口读出 course/ 里课程格式会读的文件：course.yaml 与 topics/ 下的 .yaml。别的文件（笔记、核对用的草稿）不读。
 * 没有 course/ 时返回 undefined；缺 course.yaml 时照常返回，由检查报出。
 */
export async function readSpaceCourse(files: Host["files"]): Promise<CourseFiles | undefined> {
  if (await unlessMissing(files.list(SPACE_COURSE)) === undefined) return undefined;
  const result: CourseFiles = new Map();
  const manifest = await unlessMissing(files.read(`${SPACE_COURSE}/${COURSE_FILE}`));
  if (manifest !== undefined) result.set(COURSE_FILE, manifest);
  for (const entry of await unlessMissing(files.list(`${SPACE_COURSE}/${TOPICS_DIRECTORY}`)) ?? []) {
    const name = path.posix.basename(entry);
    if (!name.endsWith(".yaml")) continue;
    const text = await unlessMissing(files.read(`${SPACE_COURSE}/${TOPICS_DIRECTORY}/${name}`));
    if (text !== undefined) result.set(`${TOPICS_DIRECTORY}/${name}`, text);
  }
  return result;
}

/** 一份课程文件的摘要，用作副本的目录名。 */
function copyId(files: CourseFiles): string {
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    hash.update(`${name}\0${files.get(name) ?? ""}\0`);
  }
  return hash.digest("hex").slice(0, 32);
}

/** 检查一份课程的结果，问题里的文件写成空间里的路径（course/topics/x.yaml），Agent 照着就能打开。 */
export interface CourseCheck {
  id: string;
  result: CheckResult;
  passed: boolean;
}

/**
 * 检查用的选项：空间里的课按 question-lesson-v1 核对全部由程序判分的作答位。检查不调用模型，缺记录只记进结果，
 * course_check 照常通过，course_use 看到缺记录时不换用；Python 核对照常运行。
 */
const SPACE_CHECK: CheckOptions = { scope: "question-lesson-v1", confirmations: "reported" };

/** 把问题里的文件写成空间里的路径（course/topics/x.yaml），Agent 照着就能打开。 */
function spacePaths(diagnostics: Diagnostic[]): void {
  for (const diagnostic of diagnostics) {
    if (diagnostic.file !== undefined && !path.isAbsolute(diagnostic.file)) diagnostic.file = `${SPACE_COURSE}/${diagnostic.file}`;
  }
}

/** 插件数据目录里的课程副本与换用状态。由插件保证同一时刻只有一次换用。 */
export class CourseStore {
  constructor(private readonly dataDir: string, private readonly options: CheckOptions = {}) {}

  /** 正在用的副本；没有换用过时为 undefined。 */
  async active(): Promise<string | undefined> {
    const text = await unlessMissing(readFile(path.join(this.dataDir, COURSE_CHOICE_FILE), "utf8"));
    return text === undefined ? undefined : parse(CourseChoiceSchema, JSON.parse(text)).active;
  }

  /**
   * 把一份课程文件写进一个新的临时文件夹，在这份固定的内容上检查，不受之后对 course/ 的写入影响。
   * after 在临时文件夹还在时运行，可以调用 keep() 把检查过的这一份存成副本；之后删掉临时文件夹。
   */
  async check<T>(
    files: CourseFiles,
    after: (checked: CourseCheck, keep: () => Promise<void>, read: () => Promise<ResolvedCourse>) => Promise<T>,
  ): Promise<T> {
    return this.withCopy(files, async (directory) => {
      const result = await checkCourse(directory, { ...SPACE_CHECK, ...this.options, base: directory });
      spacePaths(result.diagnostics);
      const checked = { id: copyId(files), result, passed: !result.diagnostics.some((diagnostic) => diagnostic.severity === "error") };
      return after(checked, () => this.keep(checked.id, directory), () => readCopy(directory));
    });
  }

  /**
   * 在这份课程文件的固定副本上做模型核对（question-lesson-v1），不受核对期间对 course/ 的写入影响。
   * 一致的记录经 options.save 写回空间里的 topic 文件；副本随后删掉。
   */
  confirm(files: CourseFiles, options: Omit<ConfirmOptions, "scope" | "base">): Promise<ConfirmResult> {
    return this.withCopy(files, async (directory) => {
      const result = await confirmCourse(directory, { ...options, scope: "question-lesson-v1", base: directory });
      spacePaths(result.diagnostics);
      return result;
    });
  }

  /** 把一份课程文件写进一个新的临时文件夹，在其上运行 work，之后删掉（work 把它改名搬走了也不要紧）。 */
  private async withCopy<T>(files: CourseFiles, work: (directory: string) => Promise<T>): Promise<T> {
    const directory = path.join(this.dataDir, CHECKS, randomUUID());
    try {
      await mkdir(path.join(directory, TOPICS_DIRECTORY), { recursive: true });
      for (const [name, text] of files) {
        await writeFile(path.join(directory, name), text, { flag: "wx", mode: 0o600 });
      }
      return await work(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * 把检查过的这一份存成副本 courses/<摘要>/。副本只写不改：已有同一摘要、内容也对得上的副本就直接用它，不先删再写，
   * 那一份可能正是学习者在用的。已有的那一份内容对不上（写坏了）时先挪开，新的一份就位以后再删掉它。
   */
  private async keep(id: string, directory: string): Promise<void> {
    const copies = path.join(this.dataDir, COPIES);
    const target = path.join(copies, id);
    const present = await unlessMissing(readdir(target)) !== undefined;
    if (present) {
      const existing = await unlessMissing(readCourseFiles(target));
      if (existing !== undefined && copyId(existing) === id) return;
    }
    await mkdir(copies, { recursive: true });
    // 副本改名就位之前，先把其中的文件和目录逐一落盘：之后发布的 course.json 指向它，掉电以后它下面的文件也得都在。
    await syncTree(directory);
    const stale = path.join(copies, `.${id}.${randomUUID()}.stale`);
    if (present) await move(target, stale);
    await move(directory, target);
    await syncDirectory(copies);
    await rm(stale, { recursive: true, force: true });
  }

  /**
   * 发布换用：把一个已经存好的副本记为正在用的。course.json 先写临时文件再改名，这一步是换用的提交点：中途断电时要么是旧状态，
   * 要么是新状态，副本在此之前已经落盘。
   */
  async publish(id: string): Promise<void> {
    await writeJson(path.join(this.dataDir, COURSE_CHOICE_FILE), { active: id } satisfies CourseChoice);
  }

  /** 发布以后删掉别的副本（包括之前中断留下的、没有发布的）：进行中的任务只能在只增不改时换用，用的就是这一份。 */
  async prune(active: string): Promise<void> {
    for (const entry of await unlessMissing(readdir(path.join(this.dataDir, COPIES))) ?? []) {
      if (entry !== active) await rm(path.join(this.dataDir, COPIES, entry), { recursive: true, force: true });
    }
  }

  /** 读出一个副本。副本在换用前已通过检查，这里只按格式读取；读不出时抛出 invalid_course，带上问题。 */
  load(id: string): Promise<ResolvedCourse> {
    return readCopy(path.join(this.dataDir, COPIES, id));
  }
}

/** 读出一个副本里课程格式会读的文件（course.yaml 与 topics/ 下的 .yaml），与 readSpaceCourse 读空间的 course/ 相同。 */
async function readCourseFiles(directory: string): Promise<CourseFiles> {
  const result: CourseFiles = new Map();
  const manifest = await unlessMissing(readFile(path.join(directory, COURSE_FILE), "utf8"));
  if (manifest !== undefined) result.set(COURSE_FILE, manifest);
  for (const name of await readdir(path.join(directory, TOPICS_DIRECTORY))) {
    if (name.endsWith(".yaml")) result.set(`${TOPICS_DIRECTORY}/${name}`, await readFile(path.join(directory, TOPICS_DIRECTORY, name), "utf8"));
  }
  return result;
}

async function readCopy(directory: string): Promise<ResolvedCourse> {
  const report = new Report();
  const loaded = await loadCourse(directory, report, directory);
  if (!loaded || report.errorCount > 0) {
    throw new RepaFault("invalid_course", `换用的课程副本读不出来：${report.diagnostics.slice(0, 3).map(formatDiagnostic).join("；")}`);
  }
  return {
    course: loaded.course,
    topics: loaded.topics.map(({ topic }) => topic),
    origins: Object.fromEntries(loaded.topics.map(({ topic }) => [topic.id, { source: SPACE_COURSE, basedOn: loaded.course.version }])),
  };
}

/**
 * 新的一版相对旧的一版只增不改：同一门课（id 相同），旧版有学习者的代码要运行时判分运行时相同（只有 verify 的课
 * 判分用不到 runtime：verify 只在检查时运行，所以 runtime 可以新写上、改动或去掉），旧版里每个展开了的 topic 在新版里一字不差；
 * 轮廓可以展开、修改或删去，也可以加新的 topic。学习者进行中的任务只取决于展开了的部分：任务本身的 topic，
 * 以及此前学过的部分（作答按它们重判，决定先修算不算学过、这项任务还有没有资格）。它们不变，新的一版重放出来的就是同一个任务。
 * topic 末尾的核对记录（verified）不在比较之内：它不影响出题和判分，学过的 topic 补写记录以后照样能换用。
 */
export function onlyAdds(before: ResolvedCourse, after: ResolvedCourse): boolean {
  if (before.course.id !== after.course.id) return false;
  if (teachesPython(before.topics) && !isDeepStrictEqual(before.course.runtime, after.course.runtime)) return false;
  return before.topics.every((old) => {
    if (old.status !== "complete") return true;
    const now = after.topics.find((topic) => topic.id === old.id);
    return now !== undefined && isDeepStrictEqual(topicContent(old), topicContent(now));
  });
}
