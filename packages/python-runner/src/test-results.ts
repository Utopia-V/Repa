/**
 * 两个宿主共用的计时与结果归类：宿主按 runner.py 的 program_test 报告的阶段计时，把超时、崩溃和 program_test 的返回值
 * 写成 python.run 的测试结果。页面运行器和 Node 沙箱用同一套规则，超时停在哪个阶段、算谁的问题两边一致。
 */
import { Value } from "typebox/value";

import { PythonPhaseSchema, PythonTestResultSchema, type PythonPhase, type PythonTestResult } from "./protocol.js";

/** 宿主收到的阶段：协议里的阶段，加上 serialize，即运行器序列化 capture 的值；对外归在 capture 下。 */
export type Step = PythonPhase | "serialize";

/** program_test 产出的阶段名；认不出的返回 undefined，宿主沿用上一个阶段。 */
export function readStep(phase: unknown): Step | undefined {
  return phase === "serialize" ? phase : Value.Check(PythonPhaseSchema, phase) ? phase : undefined;
}

/** 解释器在 step 阶段出了问题（崩溃、回复认不出）：记为这个阶段的 failed，属于执行失败。 */
export function failedAt(id: string, step: Step, message: string): PythonTestResult {
  return { id, status: "failed", phase: step === "serialize" ? "capture" : step, error: { type: "WorkerError", message } };
}

/**
 * 测试在 step 阶段超时。序列化会调用值自己的 __repr__、__len__ 和迭代，这些可能是被测的代码，
 * 所以与求值一样记为 capture 阶段的超时。
 */
export function timedOut(id: string, step: Step): PythonTestResult {
  return { id, status: "timeout", phase: step === "serialize" ? "capture" : step };
}

/** 进入这个阶段时重新计时：准备、被测代码和收尾各有一份时限，超时才能归到真正耗时的那一段。 */
export function restartsTimer(step: Step): boolean {
  return step === "program" || step === "cleanup";
}

/** program_test 的返回值：completed 是运行结果，failed 是前导、夹具或 setup 出错。其他的都当作解释器出了问题。 */
export function readTested(id: string, step: Step, response: unknown): PythonTestResult {
  if (typeof response === "object" && response !== null && "status" in response
    && (response.status === "completed" || response.status === "failed")) {
    const result = { ...response, id };
    if (Value.Check(PythonTestResultSchema, result)) return result;
  }
  return failedAt(id, step, "运行器返回了无法识别的结果");
}
