import { Network } from "lucide-react";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function WorkspaceWelcome() {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <Network aria-hidden="true" className="size-5" />
            Repa Web
          </span>
          <Badge variant="outline">学习工作台</Badge>
        </div>
        <h1 className="text-2xl font-semibold">Repa</h1>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          后端已连接，学习工作台将在这里展开。
        </p>
      </CardContent>
    </Card>
  );
}
