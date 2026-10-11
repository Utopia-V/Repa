import { useEffect, useState } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SelectionButton } from "@/components/ui/selection-button";
import { ErrorNotice } from "@/components/domain/error-notice";
import { useAppStore } from "@/hooks/use-app-store";

function folderName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).at(-1) ?? root;
}

export function LearningSpacePage() {
  const spaces = useAppStore((state) => state.resources.spaces);
  const active = useAppStore((state) => state.space);
  const loadSpaces = useAppStore((state) => state.loadSpaces);
  const openSpace = useAppStore((state) => state.openSpace);
  const [opening, setOpening] = useState<string>();
  const [failure, setFailure] = useState<{ root: string; error: unknown }>();

  useEffect(() => {
    void loadSpaces();
  }, [loadSpaces]);

  async function open(root: string) {
    setOpening(root);
    setFailure(undefined);
    try {
      await openSpace(root);
    } catch (error) {
      setFailure({ root, error });
    } finally {
      setOpening(undefined);
    }
  }

  return <div className="mx-auto grid w-full max-w-xl gap-6 px-4 py-16 md:px-8">
    <header className="grid gap-2">
      <h2 className="text-2xl font-semibold">学习空间</h2>
      <p className="text-sm text-muted-foreground">选择最近打开过的学习空间。</p>
    </header>

    {spaces.status === "error" && <div className="grid gap-3">
      <ErrorNotice title="无法读取最近空间" error={spaces.error} />
      <div>
        <Button variant="outline" onClick={() => { void loadSpaces(); }}>
          <RefreshCw aria-hidden="true" />重试
        </Button>
      </div>
    </div>}

    {spaces.status === "loading" && !spaces.data && <p role="status" className="text-sm text-muted-foreground">正在读取最近空间…</p>}

    {spaces.data && (spaces.data.length === 0
      ? <p className="text-sm text-muted-foreground">还没有打开过学习空间。从目录选择学习空间的功能正在接入。</p>
      : <ul aria-label="最近空间" className="m-0 grid list-none gap-2 p-0">
        {spaces.data.map((root) => <li key={root}>
          <SelectionButton className="w-full" selected={root === active} disabled={opening !== undefined} onClick={() => { void open(root); }}>
            <FolderOpen aria-hidden="true" />
            <span className="grid min-w-0 text-left">
              <span>{folderName(root)}</span>
              <span className="text-xs font-normal break-all text-muted-foreground">{root}</span>
            </span>
          </SelectionButton>
        </li>)}
      </ul>)}

    {opening !== undefined && <p role="status" className="text-sm text-muted-foreground">正在打开 {folderName(opening)}…</p>}
    {failure && <ErrorNotice title={`无法打开 ${folderName(failure.root)}`} error={failure.error} />}
    {opening === undefined && active !== undefined && <p className="text-sm text-muted-foreground">已打开 {folderName(active)}，会话界面正在接入。</p>}
  </div>;
}
