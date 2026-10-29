// 后端不写日志文件，最近的错误留在内存里，反馈包从这里取。条数上限是 Repa 的假设，按实际反馈调整。
const LIMIT = 100;

export interface RecordedError {
  time: string;
  source: string;
  message: string;
  code?: string;
  stack?: string;
}

export class RecentErrors {
  private readonly entries: RecordedError[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  add(entry: Omit<RecordedError, "time">): void {
    this.entries.push({ time: new Date(this.now()).toISOString(), ...entry });
    if (this.entries.length > LIMIT) this.entries.shift();
  }

  list(): RecordedError[] {
    return [...this.entries];
  }
}
