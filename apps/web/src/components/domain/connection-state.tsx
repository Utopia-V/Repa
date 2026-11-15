import { LoaderCircle, Network, RefreshCw, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardContent, CardFooter } from "@/components/ui/card";
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
