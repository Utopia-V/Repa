import type { PythonTest } from "../protocol.js";

/** 页面发给 Python Worker 的消息。start 带上页面取好、核对过的 Pyodide 文件；Worker 自己不联网。一个 Worker 只收一次 run。 */
export type WorkerRequest =
  | {
    type: "start";
    indexURL: string;
    packageBaseUrl: string;
    lock: string;
    /** 带的包（含依赖）的 import 名到包名，交给 runner.py 判断测试引入了哪些包。 */
    imports: Record<string, string>;
    /** 启动时就加载的包：上一次调用的测试引入的包，判分时同一门课的下一次提交多半还要它们。 */
    preload: string[];
    /** runner.py 的源码，与 Node 宿主用的是同一份；Worker 用其中的 program_test 运行测试。 */
    runner: string;
    /** 文件名到内容；Pyodide 启动时按文件名取。 */
    files: Record<string, ArrayBuffer>;
  }
  | { type: "run"; tests: PythonTest[] };

/**
 * Worker 发回页面的消息。ready 带上 Pyodide 和 Python 的版本。loading 在加载测试引入的包之前发出，列出这些包；
 * phase 在每个阶段开始前发出，test 是测试的序号；tested 是一个测试的结果，即 runner.py 的 program_test 的返回值。
 * failed 之后这个 Worker 不再可用。
 */
export type WorkerMessage =
  | { type: "ready"; runtime: unknown }
  | { type: "failed"; message: string }
  | { type: "loading"; test: number; packages: string[] }
  | { type: "phase"; test: number; phase: string; index: number | null }
  | { type: "tested"; test: number; response: unknown };
