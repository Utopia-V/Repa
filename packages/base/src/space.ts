import type { ActivitySource, Revision, Snapshot, UndoResult } from "@repa/space-history";
import type { Files, History } from "./plugin.js";

/**
 * Agent 写入工具接入空间的写入路径。只记这次碰到的路径，来源取当前运行；
 * 带命令行的运行持有空间写锁时，其他写入等它结束，它窗口里的写入直接落盘、算在它的快照里。
 */
export interface SpaceWrites {
  /** 一次写入工具调用的全过程，在拿同一文件的写入队列之前调用；等待期间 signal 取消就不再执行。 */
  lock<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** 一次文件写入：file 为解析后的绝对路径。action 在历史队列里执行，写入前的基线核对放在这里。 */
  commit<T>(file: string, action: () => Promise<T>): Promise<T>;
}

export interface Space {
  root: string;
  dataDir: string;
  sessionsDir: string;
  history: History & {
    undo(revision: string): Promise<UndoResult>;
    /** 撤回这个运行及其全部子孙运行的写入。 */
    undoRun(runId: string): Promise<UndoResult>;
  };
  files: Files;
  filesFor(source: ActivitySource): Files;
  pluginDataDir(id: string): Promise<string>;
  /** 不透明写入者：独占空间写锁，动作前后各扫描一次整个空间。 */
  record<T>(source: ActivitySource, action: () => Promise<T>): Promise<{ value: T; snapshot: Snapshot }>;
  writes: SpaceWrites;
  onRevision(listener: (revision: Revision) => void): () => void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface SpaceOptions {
  watch?: boolean;
  onError?(error: unknown): void;
  /**
   * 同一文件的写入排队。装配时传入 Agent 写入工具使用的同一条队列（Pi 的 withFileMutationQueue），
   * 插件写入和 Agent 写入同一个文件时就会依次进行；省略时不另排队，提交仍由历史队列串行。
   */
  fileQueue?<T>(file: string, action: () => Promise<T>): Promise<T>;
}

export { openSpace, createSpace } from "./space/space.js";
