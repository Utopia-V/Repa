import { LoaderCircle, Network, RefreshCw, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardContent, CardFooter } from "@/components/ui/card";
import { StatusNotice } from "@/components/ui/status-notice";

export function StartupPanel({
  failure,
  onRetry,
}: {
  failure: { message: string } | undefined;
  onRetry: () => void;
}) {
  return (
    <Card role="region" aria-labelledby="startup-title">
      <CardHeader>
        <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <Network aria-hidden="true" className="size-5" />
          Repa Web
        </div>
        <h1 id="startup-title" className="text-2xl font-semibold">
          {failure ? "Repa 启动失败" : "正在准备 Repa"}
        </h1>
      </CardHeader>
      <CardContent>
        {failure ? (
          <StatusNotice status="error" title="暂时无法连接">
            {failure.message}
          </StatusNotice>
        ) : (
          <p role="status" className="flex items-start gap-2 text-sm text-muted-foreground">
            <LoaderCircle aria-hidden="true" className="size-5 shrink-0" />
            正在启动或连接本机学习后端…
          </p>
        )}
      </CardContent>
      {failure && (
        <CardFooter>
          <Button onClick={onRetry}>
            <RefreshCw aria-hidden="true" />
            重试
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

export function ReconnectionNotice() {
  return (
    <Card role="status">
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Unplug aria-hidden="true" className="size-5 shrink-0" />
        后端连接已中断，正在自动重连…
      </p>
    </Card>
  );
}
