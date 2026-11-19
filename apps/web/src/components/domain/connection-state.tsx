import { useEffect, useState } from "react";
import { LoaderCircle, Network, RefreshCw, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardContent, CardFooter } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { StatusNotice } from "@/components/ui/status-notice";
import { describeError } from "@/lib/errors";
import { t } from "@/lib/strings";

export function StartupPanel({
  failure,
  onRetry,
}: {
  failure: { error: unknown } | undefined;
  onRetry: () => void;
}) {
  return (
    <Card role="region" aria-labelledby="startup-title">
      <CardHeader>
        <div className="flex items-center gap-2 text-body weight-semibold text-muted-foreground">
          <Network aria-hidden="true" className="size-5" />
          {t("connection.startup.brand")}
        </div>
        <h1 id="startup-title" className="text-display weight-semibold">
          {failure ? t("connection.startup.failed.title") : t("connection.startup.preparing.title")}
        </h1>
      </CardHeader>
      <CardContent>
        {failure ? (
          // 宿主交来的原文带着 IPC 通道名和后端的诊断，学习者读不懂；先说一句人话，原文折叠起来，排查时还能看到、复制。
          <StatusNotice status="error" title={t("connection.startup.error.title")}>
            <p>{t("connection.startup.failed.message")}</p>
            <details className="mt-2">
              <summary className="cursor-pointer">{t("common.errorDetails.label")}</summary>
              <p className="mt-2 break-all whitespace-pre-wrap">{describeError(failure.error).message}</p>
            </details>
          </StatusNotice>
        ) : (
          <p role="status" className="flex items-start gap-2 text-body text-muted-foreground">
            <LoaderCircle aria-hidden="true" className="size-5 shrink-0" />
            {t("connection.startup.status")}
          </p>
        )}
      </CardContent>
      {failure && (
        <CardFooter>
          <Button onClick={onRetry} leadingIcon={RefreshCw}>{t("common.retry.action")}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

export function ReconnectionNotice() {
  return (
    <Card role="status">
      <p className="flex items-start gap-2 text-body text-muted-foreground">
        <Unplug aria-hidden="true" className="size-5 shrink-0" />
        {t("connection.reconnecting.status")}
      </p>
    </Card>
  );
}

/**
 * 退出时后端收尾超过这么久才显示说明。Repa 的假设：收尾（停下模型请求、最后备份一次、提交空间历史）平时不到 1 秒，
 * 超过 2 秒才值得打扰学习者。
 */
export const QUIT_NOTICE_DELAY_MS = 2000;

/**
 * 桌面端退出时后端收尾太慢，盖在页面上的说明和“立即退出”。窗口留到收尾完成，等多久由学习者决定。
 * 不能关掉：Esc 和点外面都不收起它，此时页面已不再连接后端，收起来也做不了什么。
 */
export function QuittingNotice({ onQuitNow }: { onQuitNow: () => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => { setShown(true); }, QUIT_NOTICE_DELAY_MS);
    return () => { clearTimeout(timer); };
  }, []);
  return (
    <Dialog open={shown}>
      <DialogContent size="sm" showCloseButton={false}>
        <DialogTitle>{t("connection.quitting.status")}</DialogTitle>
        <DialogFooter>
          <Button onClick={onQuitNow}>{t("connection.quitNow.action")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
