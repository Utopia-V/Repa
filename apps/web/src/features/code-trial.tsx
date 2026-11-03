import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Play } from "lucide-react";
import type { PythonPhase, PythonTestResult } from "@repa/python-runner/protocol";

import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/domain/error-notice";
import { useAppStore } from "@/hooks/use-app-store";
import { useTrialRunner } from "@/hooks/use-trial-runner";

const phaseText: Record<PythonPhase, string> = {
  prepare: "准备运行环境（课程的前导代码和题目数据）",
  program: "运行你的代码",
  capture: "检查结果",
  doctest: "检查结果",
  cleanup: "收尾",
};

type Trial =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: PythonTestResult }
  | { status: "error"; error: unknown };

function TrialOutput({ result }: { result: PythonTestResult }) {
  if (result.status === "completed") {
    const { stdout, error } = result.result;
    return <div className="grid gap-2">
      {stdout === "" && error === null && <p className="m-0 text-sm text-muted-foreground">运行完了，没有输出。</p>}
      {stdout !== "" && <pre aria-label="运行输出" className="m-0 max-h-64 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-sm whitespace-pre-wrap">{stdout}</pre>}
      {error !== null && <p className="m-0 text-sm text-destructive">
        {typeof error.line === "number" ? `第 ${error.line} 行出错：` : "出错："}
        <code className="font-mono">{error.type}: {error.message}</code>
      </p>}
    </div>;
  }
  if (result.status === "not_run") return <p className="m-0 text-sm text-muted-foreground">这次没有运行。</p>;
  return <p className="m-0 text-sm text-destructive">
    {result.status === "timeout" ? "运行超时" : "没能运行完"}，停在{phaseText[result.phase]}。
    {result.error && <> <code className="font-mono">{result.error.type}: {result.error.message}</code></>}
  </p>;
}

/**
 * 代码题的“运行”：学习者提交前在本机跑一遍自己的代码，看输出。后端拼好课程前导与题目数据（不带答案），
 * 前端用试运行专用的运行器执行，结果只给学习者看，不交回后端，也不算作答。
 */
export function CodeTrial({ deliveryId, slotId, code, disabled }: { deliveryId: string; slotId: string; code: string; disabled: boolean }) {
  const runner = useTrialRunner();
  const prepareRun = useAppStore((state) => state.prepareRun);
  const [trial, setTrial] = useState<Trial>({ status: "idle" });
  const abort = useRef<AbortController | undefined>(undefined);

  // 离开这道题时取消还没跑完的运行。
  useEffect(() => () => abort.current?.abort(), []);

  if (!runner) return null;

  async function run() {
    if (!runner) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setTrial({ status: "running" });
    try {
      const batch = await prepareRun(deliveryId, slotId, code);
      const { tests } = await runner.run(batch, controller.signal);
      const result = tests[0];
      if (controller.signal.aborted) return;
      setTrial(result ? { status: "done", result } : { status: "error", error: new Error("运行器没有返回结果。") });
    } catch (error) {
      if (!controller.signal.aborted) setTrial({ status: "error", error });
    }
  }

  return <div className="grid gap-2">
    <div>
      <Button variant="outline" disabled={disabled || trial.status === "running"} onClick={() => { void run(); }}>
        {trial.status === "running"
          ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
          : <Play aria-hidden="true" />}
        {trial.status === "running" ? "正在运行…" : "运行"}
      </Button>
    </div>
    <div role="status" className="grid gap-2">
      {trial.status === "done" && <TrialOutput result={trial.result} />}
    </div>
    {trial.status === "error" && <ErrorNotice title="没能运行" error={trial.error} />}
  </div>;
}
