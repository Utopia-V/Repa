import type { BackupInfo, BackupSettings, BackupStatus } from "../schema.js";
import type { Space } from "../space.js";
import { SerialQueue } from "../storage.js";
import { checkBackup, groupStatus } from "./store.js";

/** 活动空间定期备份的装配：应用配置目录、空间、时钟、当前设置，以及状态变化和后台错误的去处。 */
export interface SpaceBackupsOptions {
  home: string;
  space: Space;
  now(): number;
  settings(): BackupSettings;
  onUpdate(status: BackupStatus): void;
  onError(error: unknown): void;
}

function failureOf(error: unknown, at: number): NonNullable<BackupStatus["failure"]> {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "backup_failed";
  const reason = error instanceof Error ? error.message : String(error);
  return { code, message: `备份没有完成：${reason}`, at: new Date(at).toISOString() };
}

/**
 * 活动空间的定期备份：打开以后、使用期间每隔设定的间隔、关闭之前各检查一次，"立即备份"也走同一条检查。
 * 检查依次进行，不会重叠；失败时记下原因，已有的备份不动，下一次检查再试。
 */
export class SpaceBackups {
  readonly #queue = new SerialQueue();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #failure: BackupStatus["failure"] = null;
  #closed = false;

  constructor(private readonly options: SpaceBackupsOptions) {}

  /** 打开空间以后检查一次，之后按设定的间隔检查。 */
  start(): void {
    this.#tick();
  }

  /** 检查一次：有变化才复制。失败时抛出原错误，原因同时留在状态里。 */
  check(): Promise<{ created: boolean; backup: BackupInfo }> {
    return this.#queue.run(async () => {
      const { home, space } = this.options;
      let result: { created: boolean; backup: BackupInfo };
      try {
        result = await checkBackup(home, space, this.options.settings().keep, this.options.now());
      } catch (error) {
        this.#failure = failureOf(error, this.options.now());
        await this.#notify();
        throw error;
      }
      const recovered = this.#failure !== null;
      this.#failure = null;
      if (result.created || recovered) await this.#notify();
      return result;
    });
  }

  status(): Promise<BackupStatus> {
    return groupStatus(this.options.home, this.options.space.root, this.#failure);
  }

  /** 间隔改了以后，从现在起按新的间隔等下一次检查。 */
  reschedule(): void {
    if (this.#closed) return;
    this.#schedule();
  }

  /** 关闭空间之前：停掉定时器，等进行中的检查结束，再检查最后一次。这次失败只报告，不妨碍关闭。 */
  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    try {
      await this.check();
    } catch (error) {
      this.options.onError(error);
    }
  }

  #schedule(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { this.#tick(); }, this.options.settings().intervalMinutes * 60_000);
    this.#timer.unref();
  }

  // 后台检查：失败已记在状态里，再交给 onError；无论成败都等下一个间隔。
  #tick(): void {
    this.check().catch((error: unknown) => {
      this.options.onError(error);
    }).finally(() => {
      if (!this.#closed) this.#schedule();
    }).catch((error: unknown) => {
      process.emitWarning(String(error));
    });
  }

  async #notify(): Promise<void> {
    try {
      this.options.onUpdate(await this.status());
    } catch (error) {
      this.options.onError(error);
    }
  }
}
