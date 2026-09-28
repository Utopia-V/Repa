import type { ReactNode } from "react";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export function StatusNotice({
  status,
  title,
  children,
}: {
  status: "complete" | "error";
  title: string;
  children?: ReactNode;
}) {
  const Icon = status === "complete" ? CheckCircle2 : CircleAlert;
  return (
    <div
      data-slot="status-notice"
      data-status={status}
      role={status === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-3 rounded-md border p-5 text-sm",
        status === "complete"
          ? "border-border-complete/30 bg-status-complete/5 text-status-complete"
          : "border-border-error/30 bg-destructive/5 text-destructive",
      )}
    >
      <Icon aria-hidden="true" className="size-5 shrink-0" />
      <div>
        <strong>{title}</strong>
        {children && <div className="mt-2">{children}</div>}
      </div>
    </div>
  );
}
