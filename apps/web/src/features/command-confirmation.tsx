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

/**
 * Agent 执行命令前的授权。挂在工作区布局上，离开对话页时运行也不会卡在没人看见的请求上。
 * 关闭对话框按拒绝处理，后端在回答之前一直等待。
 */
export function CommandConfirmationDialog() {
  const current = useAppStore((state) => state.confirmations[0]);
  const reply = useAppStore((state) => state.replyConfirmation);

  return <Dialog open={current !== undefined} onOpenChange={(open) => { if (!open && current) void reply(current.id, false); }}>
    {current && <DialogContent>
      <DialogHeader>
        <DialogTitle>{current.request.title}</DialogTitle>
        <DialogDescription>Agent 想在学习空间里执行下面的命令，允许后才会运行。</DialogDescription>
      </DialogHeader>
      <pre className="m-0 max-h-60 overflow-auto rounded-md border border-border bg-surface-inset p-3 font-mono text-[length:var(--type-code-size)] leading-[var(--type-code-line)] whitespace-pre-wrap break-all">
        {current.request.message}
      </pre>
      <DialogFooter>
        <Button variant="outline" onClick={() => { void reply(current.id, false); }}>拒绝</Button>
        <Button onClick={() => { void reply(current.id, true); }}>允许</Button>
      </DialogFooter>
    </DialogContent>}
  </Dialog>;
}
