import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { RepaFault, syncDirectory } from "@repa/base";
import { parse } from "@repa/base/protocol";
import { FactSchema, type Fact, type FactBody } from "./records-schema.js";

/** 学习记录在插件数据目录中的文件名；打开与导出都用它。 */
export const RECORDS_FILE = "records.jsonl";

function invalid(message: string): never {
  throw new RepaFault("invalid_learning_log", message);
}

/**
 * 学习记录：`records.jsonl` 里只追加的事实。这一层只管格式、序号、引用关系和写入的持久性，
 * 事实的含义（任务进行到哪、学生状态、XP）由重放层计算。
 *
 * 写入经同一条串行入口：调用方在 write 的回调里读当前状态、决定要追加的事实，回调返回后一次写入、
 * 一次同步文件和目录，再按顺序交给监听方。写入失败时请求失败，并停止本实例继续追加；重新打开以后以盘上为准。
 */
export class LearningRecords {
  private readonly list: Fact[] = [];
  private readonly answered = new Set<number>();
  private readonly graded = new Set<number>();
  private readonly listeners: ((fact: Fact) => void)[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private blocked = false;
  private closed = false;
  private constructor(readonly file: string, private readonly clock: () => number) {}

  /** 读入完整的行并逐条核对；末尾没有换行的残缺片段只读不写，之后追加会报 learning_log_blocked。 */
  static async open(file: string, clock = Date.now): Promise<LearningRecords> {
    const log = new LearningRecords(file, clock);
    const bytes = await readLog(file);
    const end = bytes.lastIndexOf(10) + 1;
    log.blocked = end !== bytes.length;
    for (const line of new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)).split("\n").slice(0, -1)) {
      let fact: Fact;
      try {
        const value: unknown = JSON.parse(line);
        // 读取时忽略事实顶层不认识的可选字段，写入仍严格校验。
        const schema = value !== null && typeof value === "object" && "type" in value
          ? FactSchema.anyOf.find((candidate) => candidate.properties.type.const === value.type)
          : undefined;
        const known = schema && value !== null && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).filter(([key]) => Object.hasOwn(schema.properties, key)))
          : value;
        fact = parse(FactSchema, known);
      } catch {
        invalid(`第 ${log.revision + 1} 行不是有效的学习事实`);
      }
      log.check(fact, log.revision + 1);
      log.add(fact);
    }
    return log;
  }

  /** 全部事实，按序号排列；调用方不得修改。 */
  get facts(): readonly Fact[] { return this.list; }
  /** 事实的条数，也是公开的 revision。 */
  get revision(): number { return this.list.length; }
  get incompleteTail(): boolean { return this.blocked; }
  fact(seq: number): Fact | undefined { return this.list[seq - 1]; }

  /** 每追加一条事实就按顺序通知；监听方抛错时本实例停止追加，重新打开以后以盘上为准。 */
  listen(listener: (fact: Fact) => void): void {
    this.listeners.push(listener);
  }

  serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      if (this.closed) throw new RepaFault("learning_closed", "学习记录已关闭");
      return action();
    });
    this.tail = result.catch(() => {});
    return result;
  }

  /** 在串行入口里决定并写入事实；回调返回空数组时不写。同一次写入的事实共用一个时间。 */
  write(build: () => FactBody[] | Promise<FactBody[]>): Promise<Fact[]> {
    return this.serial(async () => this.append(await build()));
  }

  private async append(bodies: FactBody[]): Promise<Fact[]> {
    if (bodies.length === 0) return [];
    if (this.blocked) throw new RepaFault("learning_log_blocked", "日志尾部残缺或写入结果不明，请关闭空间后恢复");
    const at = this.clock();
    const facts = bodies.map((body, index) => parse(FactSchema, { ...body, seq: this.revision + index + 1, at }));
    const answered = new Set(this.answered);
    const graded = new Set(this.graded);
    const pending = (seq: number) => this.list[seq - 1] ?? facts[seq - this.revision - 1];
    for (const fact of facts) this.check(fact, fact.seq, answered, graded, pending);
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      const handle = await open(this.file, "a", 0o600);
      try {
        await handle.writeFile(facts.map((fact) => `${JSON.stringify(fact)}\n`).join(""));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(path.dirname(this.file));
    } catch (error) {
      this.blocked = true;
      throw error;
    }
    try {
      for (const fact of facts) this.add(fact);
    } catch (error) {
      this.blocked = true;
      throw error;
    }
    return facts;
  }

  /** 只核对与课程无关的关系：序号连续，引用指向此前正确类型的事实，一次交付只收一份作答。 */
  private check(
    fact: Fact,
    seq: number,
    answered = this.answered,
    graded = this.graded,
    lookup = (reference: number): Fact | undefined => this.list[reference - 1],
  ): void {
    if (fact.seq !== seq) invalid("事实序号不连续");
    const target = (reference: number, type: Fact["type"]): Fact => {
      const found = reference < seq ? lookup(reference) : undefined;
      if (found?.type !== type) invalid(`第 ${seq} 条事实引用的第 ${reference} 条不是 ${type}`);
      return found;
    };
    switch (fact.type) {
      case "task":
        if (fact.retakes !== undefined) {
          const original = target(fact.retakes, "task");
          if (original.type !== "task" || !["quiz", "retake"].includes(original.kind)) invalid("换题重考只能针对测验");
        }
        break;
      case "viewed":
      case "delivered":
      case "ended":
        target(fact.task, "task");
        break;
      case "help":
        target(fact.delivery, "delivered");
        break;
      case "answered":
        target(fact.delivery, "delivered");
        if (answered.has(fact.delivery)) invalid("一次交付只收一份作答");
        answered.add(fact.delivery);
        break;
      case "graded":
        if (!answered.has(fact.delivery)) invalid("判分必须针对已收下的作答");
        graded.add(fact.delivery);
        break;
      case "appealed":
        if (!graded.has(fact.delivery)) invalid("申诉必须针对已判的作答");
        break;
      case "goal":
        break;
    }
  }

  private add(fact: Fact): void {
    this.list.push(fact);
    if (fact.type === "answered") this.answered.add(fact.delivery);
    if (fact.type === "graded") this.graded.add(fact.delivery);
    for (const listener of this.listeners) listener(fact);
  }

  async close(): Promise<void> {
    await this.tail;
    this.closed = true;
  }
}

async function readLog(file: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return Buffer.alloc(0);
  }
}

/** 核对源日志的完整前缀，再按原始字节写到独占创建的新文件；源文件保持原样。 */
export async function recoverLearningLog(source: string, destination: string): Promise<void> {
  const log = await LearningRecords.open(source);
  await log.close();
  const bytes = await readFile(source);
  const handle = await open(destination, "wx", 0o600);
  try {
    await handle.writeFile(bytes.subarray(0, bytes.lastIndexOf(10) + 1));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(destination));
}
