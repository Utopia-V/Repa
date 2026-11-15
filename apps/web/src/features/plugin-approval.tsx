import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppStore } from "@/hooks/use-app-store";
import { t } from "@/lib/strings";

const changeText = {
  added: t("pluginApproval.change.added.label"),
  modified: t("pluginApproval.change.modified.label"),
  removed: t("pluginApproval.change.removed.label"),
} as const;

/**
 * Agent 写好的插件要学习者批准后才加载。挂在工作区布局上，与命令确认并列。
 * 批准回答 true，拒绝回答 false；关掉对话框回答 null，后端记为没有作出决定，不当作拒绝。
 * 批准时插件的代码还没有运行，它带来哪些工具要加载以后才知道，所以这里列的是它的页面和文件。
 */
export function PluginApprovalDialog() {
  const current = useAppStore((state) => state.confirmations.find((item) => item.request.kind === "plugin"));
  const reply = useAppStore((state) => state.replyConfirmation);
  const plugin = current?.request.plugin;

  return <Dialog open={current !== undefined} onOpenChange={(open) => { if (!open && current) void reply(current.id, null); }}>
    {current && plugin && <DialogContent>
      <DialogHeader>
        <DialogTitle>{t("pluginApproval.title", { name: plugin.title ?? plugin.id })}</DialogTitle>
        <DialogDescription>{plugin.base === "none" ? t("pluginApproval.new.description") : t("pluginApproval.update.description")}</DialogDescription>
      </DialogHeader>
      <p className="m-0 text-body text-muted-foreground">
        <span className="font-mono">{plugin.id}</span> · {t("pluginApproval.version.label", { version: plugin.version })}
      </p>
      {plugin.pages.length > 0 && <section aria-labelledby="plugin-approval-pages" className="grid gap-2">
        <h3 id="plugin-approval-pages" className="m-0 text-body weight-semibold">{t("pluginApproval.pages.label")}</h3>
        <ul className="m-0 grid list-none gap-1 p-0">
          {plugin.pages.map((page) => <li key={page.id} className="text-body">{page.title}</li>)}
        </ul>
      </section>}
      <section aria-labelledby="plugin-approval-files" className="grid gap-2">
        <h3 id="plugin-approval-files" className="m-0 text-body weight-semibold">{t("pluginApproval.files.label")}</h3>
        <ul className="m-0 grid max-h-60 list-none gap-1 overflow-y-auto p-0">
          {plugin.files.map((file) => <li key={file.path} className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 font-mono text-[length:var(--type-code-size)] break-all">{file.path}</span>
            <Badge variant="solid" color={file.change === "removed" ? "red" : "gray"}>{changeText[file.change]}</Badge>
          </li>)}
        </ul>
      </section>
      <DialogFooter>
        <Button variant="tertiary" onClick={() => { void reply(current.id, false); }}>{t("pluginApproval.deny.action")}</Button>
        <Button onClick={() => { void reply(current.id, true); }}>{t("pluginApproval.approve.action")}</Button>
      </DialogFooter>
    </DialogContent>}
  </Dialog>;
}
