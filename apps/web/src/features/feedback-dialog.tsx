import { useState } from "react";
import { Copy, FolderOpen } from "lucide-react";
import type { Result } from "@repa/base/protocol";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusNotice } from "@/components/ui/status-notice";
import { Textarea } from "@/components/ui/textarea";
import { ErrorNotice } from "@/components/domain/error-notice";
import { useAppStore } from "@/hooks/use-app-store";
import { revealFile } from "@/lib/host";

/**
 * 反馈问题：用户补一句说明，可选让 Agent 自述，生成脱敏后的反馈包并在文件管理器里选中它。
 * 生成期间由调用方禁止关闭，结果出来前用户不知道包有没有写出来。
 */
export function FeedbackDialog({ onBusyChange, onClose }: { onBusyChange(busy: boolean): void; onClose(): void }) {
  const createFeedback = useAppStore((state) => state.createFeedback);
  const [note, setNote] = useState("");
  const [describe, setDescribe] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<Result<"feedback.create">>();
  const [revealError, setRevealError] = useState<unknown>();

  function reveal(path: string) {
    setRevealError(undefined);
    revealFile(path).catch((failure: unknown) => setRevealError(failure));
  }

  async function create() {
    setCreating(true);
    onBusyChange(true);
    setError(undefined);
    try {
      const created = await createFeedback({ describe, note });
      setResult(created);
      // 生成后直接打开一次，用户不用再点；失败时留下路径和重试按钮。
      reveal(created.path);
    } catch (failure) {
      setError(failure);
    } finally {
      setCreating(false);
      onBusyChange(false);
    }
  }

  if (result) return <FeedbackCreated path={result.path} revealError={revealError} onReveal={() => reveal(result.path)} onClose={onClose} />;

  return <DialogContent>
    <DialogHeader>
      <DialogTitle>反馈问题</DialogTitle>
      <DialogDescription>
        把这次会话整理成一个压缩包，生成后会打开所在的文件夹，你可以直接把它发给开发者。
      </DialogDescription>
    </DialogHeader>
    <div className="grid gap-2">
      <label htmlFor="feedback-note" className="text-sm font-medium">哪里不对？（可选）</label>
      <Textarea
        id="feedback-note"
        value={note}
        maxLength={4000}
        disabled={creating}
        placeholder="例如：它说保存好了，但文件夹是空的"
        onChange={(event) => setNote(event.target.value)}
      />
    </div>
    <div className="grid gap-1">
      <div className="flex items-center gap-3">
        <Checkbox id="feedback-describe" checked={describe} disabled={creating} onCheckedChange={(next) => setDescribe(next === true)} />
        <label htmlFor="feedback-describe" className="text-sm">让 Agent 描述这次的问题</label>
      </div>
      <p className="pl-7 text-sm text-muted-foreground">会用当前模型多调用一次，不使用任何工具。</p>
    </div>
    <div className="grid gap-1 text-sm">
      <p>压缩包里有：这次会话及子 Agent 的完整记录、最近的文件修改历史、最近的错误，以及系统和 Repa 的版本。</p>
      <p className="text-muted-foreground">记录里的文件路径和系统用户名会原样保留；保存的密钥和看起来像密钥的内容会被替换掉。</p>
    </div>
    {error !== undefined && <ErrorNotice title="没有生成反馈包" error={error} />}
    <DialogFooter>
      <Button variant="outline" disabled={creating} onClick={onClose}>取消</Button>
      <Button disabled={creating} aria-busy={creating} onClick={() => { void create(); }}>
        {creating ? "正在生成…" : "生成反馈包"}
      </Button>
    </DialogFooter>
  </DialogContent>;
}

function FeedbackCreated({ path, revealError, onReveal, onClose }: { path: string; revealError: unknown; onReveal(): void; onClose(): void }) {
  const [copied, setCopied] = useState<"done" | "failed">();

  async function copy() {
    try {
      await navigator.clipboard.writeText(path);
      setCopied("done");
    } catch {
      // 浏览器拒绝写剪贴板时路径仍在页面上，提示用户手动选中复制。
      setCopied("failed");
    }
  }

  return <DialogContent>
    <DialogHeader>
      <DialogTitle>反馈包已生成</DialogTitle>
      <DialogDescription>把这个文件发给开发者就可以了。</DialogDescription>
    </DialogHeader>
    <p className="text-sm break-all select-all" aria-label="反馈包路径">{path}</p>
    {copied === "done" && <p role="status" className="text-sm text-muted-foreground">已复制路径。</p>}
    {copied === "failed" && <p role="status" className="text-sm text-muted-foreground">无法写入剪贴板，请手动选中上面的路径复制。</p>}
    {revealError !== undefined && <StatusNotice status="error" title="没能打开所在文件夹">
      <p>{revealError instanceof Error ? revealError.message : "无法打开所在文件夹。"}可以复制路径后手动打开。</p>
    </StatusNotice>}
    <DialogFooter>
      <Button variant="outline" onClick={() => { void copy(); }}><Copy aria-hidden="true" />复制路径</Button>
      <Button variant="outline" onClick={onReveal}><FolderOpen aria-hidden="true" />打开所在文件夹</Button>
      <Button onClick={onClose}>完成</Button>
    </DialogFooter>
  </DialogContent>;
}
