import { LoaderCircle, Network, RefreshCw, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardContent, CardFooter } from "@/components/ui/card";
import { ErrorNotice } from "@/components/domain/error-notice";
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
          <ErrorNotice title={t("connection.startup.error.title")} error={failure.error} />
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
