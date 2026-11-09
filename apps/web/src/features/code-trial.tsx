import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Play } from "lucide-react";
import type { PythonPhase, PythonTestResult } from "@repa/python-runner/protocol";

import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/domain/error-notice";
import { useAppStore } from "@/hooks/use-app-store";
import { useTrialRunner } from "@/hooks/use-trial-runner";
import { t } from "@/lib/strings";

const phaseText: Record<PythonPhase, string> = {
  prepare: t("codeTrial.stage.prepare.label"),
  program: t("codeTrial.stage.program.label"),
  capture: t("codeTrial.stage.capture.label"),
  doctest: t("codeTrial.stage.capture.label"),
  cleanup: t("codeTrial.stage.cleanup.label"),
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
      {stdout === "" && error === null && <p className="m-0 text-body text-muted-foreground">{t("codeTrial.output.empty")}</p>}
      {stdout !== "" && <pre aria-label={t("codeTrial.output.label")} className="m-0 max-h-64 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-body whitespace-pre-wrap">{stdout}</pre>}
      {error !== null && <p className="m-0 text-body text-destructive">
        {typeof error.line === "number" ? t("codeTrial.output.errorAtLine.label", { line: error.line }) : t("codeTrial.output.error.label")}
        <code className="font-mono">{error.type}: {error.message}</code>
      </p>}
    </div>;
  }
  if (result.status === "not_run") return <p className="m-0 text-body text-muted-foreground">{t("codeTrial.output.notRun.status")}</p>;
  return <p className="m-0 text-body text-destructive">
    {result.status === "timeout" ? t("codeTrial.output.timeout.status") : t("codeTrial.output.incomplete.status")}{t("codeTrial.output.stoppedAt.label")}{phaseText[result.phase]}。
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
      setTrial(result ? { status: "done", result } : { status: "error", error: new Error(t("codeTrial.runner.noResult.error")) });
    } catch (error) {
      if (!controller.signal.aborted) setTrial({ status: "error", error });
    }
  }

  return <div className="grid gap-2">
    <div>
      <Button variant="tertiary" disabled={disabled || trial.status === "running"} onClick={() => { void run(); }}>
        {trial.status === "running"
          ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
          : <Play aria-hidden="true" />}
        {trial.status === "running" ? t("codeTrial.run.running.status") : t("codeTrial.run.action")}
      </Button>
    </div>
    <div role="status" className="grid gap-2">
      {trial.status === "done" && <TrialOutput result={trial.result} />}
    </div>
    {trial.status === "error" && <ErrorNotice title={t("codeTrial.run.error")} error={trial.error} />}
  </div>;
}
