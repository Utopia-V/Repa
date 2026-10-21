import type { PythonTest } from "@repa/learning/protocol";

/** 页面发给 Python Worker 的消息。start 带上页面取好、核对过的 Pyodide 文件；Worker 自己不联网。一个 Worker 只收一次 run。 */
export type WorkerRequest =
  | {
    type: "start";
    indexURL: string;
    packageBaseUrl: string;
    lock: string;
    packages: string[];
    /** packages/learning/sandbox/runner.py 的源码，与课程核对用的是同一份。 */
    runner: string;
    /** packages/learning/sandbox/frontend.py 的源码，在 runner.py 之后加载，定义 frontend_test。 */
    frontend: string;
    /** 文件名到内容；Pyodide 启动时按文件名取。 */
    files: Record<string, ArrayBuffer>;
  }
  | { type: "run"; tests: PythonTest[] };

/**
 * Worker 发回页面的消息。ready 带上实际加载的 Pyodide、Python 和包版本。
 * phase 在每个阶段开始前发出，test 是测试的序号；tested 是一个测试的结果，即 frontend.py 的 frontend_test 的返回值。
 * failed 之后这个 Worker 不再可用。
 */
export type WorkerMessage =
  | { type: "ready"; runtime: unknown }
  | { type: "failed"; message: string }
  | { type: "phase"; test: number; phase: string; index: number | null }
  | { type: "tested"; test: number; response: unknown };
