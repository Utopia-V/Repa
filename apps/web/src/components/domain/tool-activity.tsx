import { CircleAlert, CircleCheck, CircleDashed, LoaderCircle } from "lucide-react";
import type { ToolStatus } from "@/lib/conversation";
import { t } from "@/lib/strings";

// Pi 内置工具和底座的 ask_user 用动作描述；插件工具没有中文名称，显示原名。
const toolNames: Record<string, string> = {
  read: t("toolActivity.read.label"),
  write: t("toolActivity.write.label"),
  edit: t("toolActivity.edit.label"),
  bash: t("toolActivity.bash.label"),
  grep: t("toolActivity.grep.label"),
  find: t("toolActivity.find.label"),
  ls: t("toolActivity.ls.label"),
  ask_user: t("toolActivity.askUser.label"),
};

const statusText: Record<ToolStatus, string> = {
  running: t("toolActivity.running.status"),
  done: t("toolActivity.done.status"),
  failed: t("toolActivity.failed.status"),
  incomplete: t("toolActivity.incomplete.status"),
};

const statusIcon = {
  running: LoaderCircle,
  done: CircleCheck,
  failed: CircleAlert,
  incomplete: CircleDashed,
} satisfies Record<ToolStatus, unknown>;

/** Agent 调用工具的一行记录；状态同时用图标和文字表达。 */
export function ToolActivity({ tool, status }: { tool: string; status: ToolStatus }) {
  const Icon = statusIcon[status];
  return <p data-status={status} className="mb-4 flex items-center gap-2 text-body text-muted-foreground">
    <Icon aria-hidden="true" className={status === "running" ? "size-4 animate-spin motion-reduce:animate-none" : "size-4"} />
    <span>{toolNames[tool] ?? tool}</span>
    <span>· {statusText[status]}</span>
  </p>;
}
