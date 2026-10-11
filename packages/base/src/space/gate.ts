/**
 * 空间写锁。不知道自己会写哪些文件的写入者（带命令行的运行、插件的 history.record）独占它，
 * 前后整体快照之间只有它在写；按路径记账的写入共享它，彼此并行。独占请求排队以后，新的共享请求排在它后面。
 *
 * 加锁次序固定为：空间写锁 → 同一文件的写入队列 → 历史队列。按路径的写入在拿文件队列之前先拿这把锁，
 * 所以独占者持锁期间，不会有共享写入者一边占着某个文件、一边等独占者占着的历史队列。
 */
export class WriteGate {
  private readers = 0;
  private writer = false;
  private readonly waiting: { exclusive: boolean; grant(): void }[] = [];

  /** 共享地执行 action；等待期间 signal 取消时不再执行，按 Pi 工具的习惯以 Operation aborted 结束。 */
  async shared<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(false, signal);
    try {
      return await action();
    } finally {
      this.release(false);
    }
  }

  /** 独占地执行 action：等已经开始的共享写入结束，期间新的写入都排在后面。 */
  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    await this.acquire(true);
    try {
      return await action();
    } finally {
      this.release(true);
    }
  }

  private available(exclusive: boolean): boolean {
    return exclusive ? !this.writer && this.readers === 0 : !this.writer;
  }

  private take(exclusive: boolean): void {
    if (exclusive) this.writer = true;
    else this.readers++;
  }

  private acquire(exclusive: boolean, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error("Operation aborted"));
    if (this.waiting.length === 0 && this.available(exclusive)) {
      this.take(exclusive);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        exclusive,
        grant: () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        },
      };
      const abort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        reject(new Error("Operation aborted"));
        this.pump();
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.waiting.push(waiter);
    });
  }

  private release(exclusive: boolean): void {
    if (exclusive) this.writer = false;
    else this.readers--;
    this.pump();
  }

  // 按到达顺序放行：队首能拿到就拿，独占请求挡住它后面的所有请求。
  private pump(): void {
    for (let next = this.waiting[0]; next !== undefined && this.available(next.exclusive); next = this.waiting[0]) {
      this.waiting.shift();
      this.take(next.exclusive);
      next.grant();
    }
  }
}
