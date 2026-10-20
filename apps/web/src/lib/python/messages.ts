import type { PythonRunInput } from "@repa/learning/protocol";

/** 页面发给 Python Worker 的消息。start 带上页面取好、核对过的 Pyodide 文件；Worker 自己不联网。 */
export type WorkerRequest =
  | {
    type: "start";
    indexURL: string;
    packageBaseUrl: string;
    lock: string;
    packages: string[];
    /** packages/learning/sandbox/runner.py 的源码，与课程核对用的是同一份。 */
    runner: string;
    /** 文件名到内容；Pyodide 启动时按文件名取。 */
    files: Record<string, ArrayBuffer>;
  }
  | { type: "run"; id: number; input: PythonRunInput };

/** Worker 发回页面的消息。failed 之后这个 Worker 不再可用。 */
export type WorkerMessage =
  | { type: "ready" }
  | { type: "failed"; message: string }
  | { type: "result"; id: number; response: unknown };
