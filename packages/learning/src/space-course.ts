/**
 * 空间里自制的课。做课的 Agent 在空间的 course/ 里写课（格式与随包课程相同：course.yaml 加 topics/），
 * 用 course_check 检查，用 course_use 换用。学习从不直接读 course/：换用时把检查过的那一份复制进插件数据目录的
 * courses/<摘要>/，学习只读这份副本，所以写到一半的 course/ 不会被学习页读到。数据目录的 course.json 记下正在用的副本，
 * 以及检查通过、等学习者做完当前任务再换用的副本。
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { RepaFault, syncDirectory } from "@repa/base";
import type { Host } from "@repa/base/plugin";
import { object, parse } from "@repa/base/protocol";
import { Type, type Static } from "typebox";

import { checkCourse, type CheckOptions, type CheckResult } from "./check/course.js";
import type { ResolvedCourse } from "./course-sources.js";
import { formatDiagnostic, Report } from "./format/diagnostics.js";
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
/** course.json：active 是学习正在用的副本，pending 是检查通过、等当前任务结束再换用的副本；都是副本的摘要。 */
export const CourseChoiceSchema = object({
  active: Type.Optional(CopyIdSchema),
  pending: Type.Optional(CopyIdSchema),
});
/** 换用状态。 */
export type CourseChoice = Static<typeof CourseChoiceSchema>;

/** 从空间读出的一份课程文件：相对 course/ 的路径与全文。 */
export type CourseFiles = Map<string, string>;

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
}

/** 空间里有没有 course/ 文件夹。 */
export async function hasSpaceCourse(root: string): Promise<boolean> {
  try {
    return (await stat(path.join(root, SPACE_COURSE))).isDirectory();
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

/**
 * 经空间的文件接口读出 course/ 里课程格式会读的文件：course.yaml 与 topics/ 下的 .yaml。别的文件（笔记、核对用的草稿）不读。
 * 没有 course/ 时返回 undefined；缺 course.yaml 时照常返回，由检查报出。
 */
export async function readSpaceCourse(files: Host["files"]): Promise<CourseFiles | undefined> {
  const read = async (file: string) => {
    try {
      return await files.read(`${SPACE_COURSE}/${file}`);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  };
  let topics: string[];
  try {
    await files.list(SPACE_COURSE);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  try {
    topics = await files.list(`${SPACE_COURSE}/${TOPICS_DIRECTORY}`);
  } catch (error) {
    if (!missing(error)) throw error;
    topics = [];
  }
  const result: CourseFiles = new Map();
  const manifest = await read(COURSE_FILE);
  if (manifest !== undefined) result.set(COURSE_FILE, manifest);
  for (const entry of topics) {
    const name = path.posix.basename(entry);
    if (!name.endsWith(".yaml")) continue;
    const text = await read(`${TOPICS_DIRECTORY}/${name}`);
    if (text !== undefined) result.set(`${TOPICS_DIRECTORY}/${name}`, text);
  }
  return result;
}

/** 一份课程文件的摘要，用作副本的目录名：内容相同的两次换用落在同一个副本上。 */
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

/** 检查用的选项：应用里没有 course:confirm，manual 作答位的模型核对只如实报告；Python 核对照常运行。 */
const SPACE_CHECK: CheckOptions = { confirmations: "reported" };

/**
 * 插件数据目录里的课程副本与换用状态。检查在各自的临时副本上进行，可以同时有几次；改换用状态和副本经 serial 串行。
 * course.json 先写临时文件再改名，中途断电时要么是旧状态、要么是新状态。
 */
export class CourseStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly dataDir: string, private readonly options: CheckOptions = {}) {}

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => {});
    return result;
  }

  async choice(): Promise<CourseChoice> {
    let text: string;
    try {
      text = await readFile(path.join(this.dataDir, COURSE_CHOICE_FILE), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    return parse(CourseChoiceSchema, JSON.parse(text));
  }

  private async writeChoice(choice: CourseChoice): Promise<void> {
    const file = path.join(this.dataDir, COURSE_CHOICE_FILE);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      try {
        await handle.writeFile(`${JSON.stringify(choice)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
      await syncDirectory(this.dataDir);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** 把一份课程文件写进一个新的临时文件夹，检查在这份固定的内容上进行，不受之后对 course/ 的写入影响。 */
  private async stage(files: CourseFiles): Promise<string> {
    const directory = path.join(this.dataDir, CHECKS, randomUUID());
    await mkdir(path.join(directory, TOPICS_DIRECTORY), { recursive: true });
    for (const [name, text] of files) {
      await writeFile(path.join(directory, name), text, { flag: "wx", mode: 0o600 });
    }
    return directory;
  }

  private async checkStaged(directory: string, files: CourseFiles): Promise<CourseCheck> {
    const result = await checkCourse(directory, { ...SPACE_CHECK, ...this.options, base: directory });
    for (const diagnostic of result.diagnostics) {
      if (diagnostic.file !== undefined && !path.isAbsolute(diagnostic.file)) diagnostic.file = `${SPACE_COURSE}/${diagnostic.file}`;
    }
    return { id: copyId(files), result, passed: !result.diagnostics.some((diagnostic) => diagnostic.severity === "error") };
  }

  /** 检查一份课程文件，不留下任何东西。 */
  async check(files: CourseFiles): Promise<CourseCheck> {
    const directory = await this.stage(files);
    try {
      return await this.checkStaged(directory, files);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * 检查一份课程文件；通过时把它存成副本并记为 pending，由插件在学习者没有做到一半的任务时换用。
   * 与正在用的副本相同时只清掉 pending。没通过时什么也不改。
   */
  async propose(files: CourseFiles): Promise<CourseCheck> {
    const directory = await this.stage(files);
    try {
      const checked = await this.checkStaged(directory, files);
      if (!checked.passed) return checked;
      await this.serial(async () => {
        const choice = await this.choice();
        const target = path.join(this.dataDir, COPIES, checked.id);
        // 副本按内容命名，同名的副本内容相同；被改坏的副本换成这次检查过的一份。
        const intact = await sameFiles(target, files);
        if (choice.active === checked.id && intact) {
          await this.writeChoice({ active: choice.active });
        } else {
          if (!intact) {
            await rm(target, { recursive: true, force: true });
            await mkdir(path.join(this.dataDir, COPIES), { recursive: true });
            await rename(directory, target);
            await syncDirectory(path.join(this.dataDir, COPIES));
          }
          await this.writeChoice({ ...choice, pending: checked.id });
        }
        await this.prune();
      });
      return checked;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /** 有 pending 时交给 decide 决定是否换用；decide 返回 true 时把它记为正在用的副本，删掉不再用的副本。 */
  apply(decide: (id: string) => Promise<boolean>): Promise<void> {
    return this.serial(async () => {
      const { pending } = await this.choice();
      if (pending === undefined || !(await decide(pending))) return;
      await this.writeChoice({ active: pending });
      await this.prune();
    });
  }

  /** 删掉换用状态不再指向的副本。 */
  private async prune(): Promise<void> {
    const choice = await this.choice();
    const keep = new Set([choice.active, choice.pending]);
    let entries: string[];
    try {
      entries = await readdir(path.join(this.dataDir, COPIES));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!keep.has(entry)) await rm(path.join(this.dataDir, COPIES, entry), { recursive: true, force: true });
    }
  }

  /** 读出一个副本。副本在换用前已通过检查，这里只按格式读取；读不出时抛出 invalid_course，带上问题。 */
  async load(id: string): Promise<ResolvedCourse> {
    const directory = path.join(this.dataDir, COPIES, id);
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
}

/** 副本文件夹里正好是这些文件、内容相同；文件夹不存在时为 false。 */
async function sameFiles(directory: string, files: CourseFiles): Promise<boolean> {
  const found: CourseFiles = new Map();
  try {
    found.set(COURSE_FILE, await readFile(path.join(directory, COURSE_FILE), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  let names: string[];
  try {
    names = await readdir(path.join(directory, TOPICS_DIRECTORY));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  for (const name of names) {
    found.set(`${TOPICS_DIRECTORY}/${name}`, await readFile(path.join(directory, TOPICS_DIRECTORY, name), "utf8"));
  }
  return found.size === files.size && [...files].every(([name, text]) => found.get(name) === text);
}
