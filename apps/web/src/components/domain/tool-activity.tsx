import { CircleAlert, CircleCheck, CircleDashed, LoaderCircle } from "lucide-react";
import type { ToolStatus } from "@/lib/conversation";
import { t } from "@/lib/strings";

// Pi 内置工具、底座的 ask_user、做课与辅导用到的插件工具用动作描述；其他插件工具没有中文名称，显示原名。
const toolNames: Record<string, string> = {
  read: t("toolActivity.read.label"),
  write: t("toolActivity.write.label"),
  edit: t("toolActivity.edit.label"),
  bash: t("toolActivity.bash.label"),
  powershell: t("toolActivity.powershell.label"),
  grep: t("toolActivity.grep.label"),
  find: t("toolActivity.find.label"),
  ls: t("toolActivity.ls.label"),
  ask_user: t("toolActivity.askUser.label"),
  materials_list: t("toolActivity.materialsList.label"),
  materials_read: t("toolActivity.materialsRead.label"),
  course_check: t("toolActivity.courseCheck.label"),
  course_use: t("toolActivity.courseUse.label"),
  course_brief: t("toolActivity.courseBrief.label"),
  course_confirm: t("toolActivity.courseConfirm.label"),
  learning_task: t("toolActivity.learningTask.label"),
  learning_search: t("toolActivity.learningSearch.label"),
  learning_read: t("toolActivity.learningRead.label"),
  web_search: t("toolActivity.webSearch.label"),
  web_fetch: t("toolActivity.webFetch.label"),
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

/** Agent 调用工具的一行记录；状态同时用图标和文字表达。count 是合成这一行的连续同名调用的个数，大于 1 时标出。 */
export function ToolActivity({ tool, status, count = 1 }: { tool: string; status: ToolStatus; count?: number }) {
  const Icon = statusIcon[status];
  return <p data-status={status} className="mb-4 flex items-center gap-2 text-body text-muted-foreground">
    <Icon aria-hidden="true" className={status === "running" ? "size-4 animate-spin motion-reduce:animate-none" : "size-4"} />
    <span>{toolNames[tool] ?? tool}</span>
    {count > 1 && <span className="tabular-nums">{t("toolActivity.count.label", { count })}</span>}
    <span>· {statusText[status]}</span>
  </p>;
}
