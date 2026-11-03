import { createContext, useContext, type ReactNode } from "react";
import type { PythonRunner } from "@repa/python-runner/browser";

/** 学习者试运行自己代码用的运行器。 */
export type TrialRunner = Pick<PythonRunner, "run">;

const TrialRunnerContext = createContext<TrialRunner | undefined>(undefined);

/**
 * 试运行和判分各用一个运行器：判分的那个由 servePythonRun 按后端的调用排队使用，
 * 试运行另起一个，学习者点“运行”不会排在判分后面，也不会占着判分用的 Worker。
 */
export function TrialRunnerProvider({ runner, children }: { runner: TrialRunner; children: ReactNode }) {
  return <TrialRunnerContext value={runner}>{children}</TrialRunnerContext>;
}

/** 没有提供运行器时为 undefined，界面不显示“运行”。 */
export function useTrialRunner(): TrialRunner | undefined {
  return useContext(TrialRunnerContext);
}
