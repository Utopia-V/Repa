import { CircleAlert, CircleCheck, CircleDashed, LoaderCircle } from "lucide-react";
import type { ToolStatus } from "@/lib/conversation";

// Pi 内置工具和底座的 ask_user 用动作描述；插件工具没有中文名称，显示原名。
const toolNames: Record<string, string> = {
  read: "读取文件",
  write: "写入文件",
  edit: "编辑文件",
  bash: "执行命令",
  grep: "搜索内容",
  find: "查找文件",
  ls: "列出文件",
  ask_user: "向你提问",
};

const statusText: Record<ToolStatus, string> = {
  running: "进行中",
  done: "已完成",
  failed: "失败",
  incomplete: "未完成",
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
  return <p data-status={status} className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
    <Icon aria-hidden="true" className={status === "running" ? "size-4 animate-spin motion-reduce:animate-none" : "size-4"} />
    <span>{toolNames[tool] ?? tool}</span>
    <span>· {statusText[status]}</span>
  </p>;
}
