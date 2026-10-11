import { useEffect, useRef, useState } from "react";
import { ArrowUp, Folder, FolderCheck, HardDrive } from "lucide-react";
import type { Result } from "@repa/base/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorNotice } from "@/components/domain/error-notice";
import { useAppStore } from "@/hooks/use-app-store";

type Listing = Result<"space.browse">;
type Roots = Result<"space.roots">;
type View = { kind: "folder"; listing: Listing } | { kind: "roots"; roots: Roots };

export function FolderPickerDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>选择文件夹</DialogTitle>
        <DialogDescription>选一个文件夹作为学习空间，Repa 会在里面保存学习数据。</DialogDescription>
      </DialogHeader>
      {/* 内容随对话框打开挂载，每次打开都从用户目录重新开始。 */}
      <FolderBrowser onOpened={() => onOpenChange(false)} />
    </DialogContent>
  </Dialog>;
}

function FolderBrowser({ onOpened }: { onOpened(): void }) {
  const browseFolder = useAppStore((state) => state.browseFolder);
  const listRoots = useAppStore((state) => state.listRoots);
  const openSpace = useAppStore((state) => state.openSpace);
  const [view, setView] = useState<View>();
  const [roots, setRoots] = useState<Roots>([]);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<{ title: string; error: unknown }>();
  const location = useRef<HTMLHeadingElement>(null);
  const request = useRef(0);

  async function show(load: () => Promise<View>) {
    const id = ++request.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await load();
      if (id !== request.current) return;
      setView(next);
      // 点击的条目随列表一起消失，焦点移到新的位置标题，键盘用户从这里继续。
      requestAnimationFrame(() => location.current?.focus());
    } catch (failure) {
      if (id === request.current) setError({ title: "无法读取文件夹", error: failure });
    } finally {
      if (id === request.current) setLoading(false);
    }
  }

  const browse = (path?: string) => show(async () => ({ kind: "folder", listing: await browseFolder(path) }));

  useEffect(() => {
    void browse();
    // 盘符列表只在走到盘的根目录时使用；读取失败不影响浏览。
    listRoots().then(setRoots, () => setRoots([]));
    // 只在挂载时从用户目录开始。
  }, []);

  const listing = view?.kind === "folder" ? view.listing : undefined;
  const canGoUp = listing !== undefined && (listing.parent !== null || roots.length > 1);

  function goUp() {
    if (!listing) return;
    if (listing.parent !== null) void browse(listing.parent);
    else void show(async () => ({ kind: "roots", roots }));
  }

  async function openCurrent() {
    if (!listing) return;
    setOpening(true);
    setError(undefined);
    try {
      await openSpace(listing.path);
      onOpened();
    } catch (failure) {
      setError({ title: "无法打开这个文件夹", error: failure });
      setOpening(false);
    }
  }

  return <>
    <div className="grid min-w-0 gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <Button variant="outline" disabled={!canGoUp || loading || opening} onClick={goUp}>
          <ArrowUp aria-hidden="true" />上一级
        </Button>
        <h3 ref={location} tabIndex={-1} className="min-w-0 text-sm font-semibold break-all outline-none">
          {view?.kind === "roots" ? "此电脑" : listing?.path ?? "用户目录"}
        </h3>
      </div>

      {loading && <p role="status" className="text-sm text-muted-foreground">正在读取…</p>}
      {error && <ErrorNotice title={error.title} error={error.error} />}

      {view?.kind === "roots" && <ul aria-label="磁盘" className="m-0 grid list-none gap-1 p-0">
        {view.roots.map((root) => <li key={root.path}>
          <Button variant="ghost" className="w-full justify-start" disabled={loading} onClick={() => { void browse(root.path); }}>
            <HardDrive aria-hidden="true" />{root.label}
          </Button>
        </li>)}
      </ul>}

      {listing && (listing.entries.length === 0
        ? <p className="text-sm text-muted-foreground">这里没有子文件夹。</p>
        : <ul aria-label="子文件夹" className="m-0 grid max-h-80 list-none gap-1 overflow-y-auto p-0">
          {listing.entries.map((entry) => <li key={entry.path}>
            <Button variant="ghost" className="w-full justify-start" disabled={loading || opening} onClick={() => { void browse(entry.path); }}>
              {entry.space ? <FolderCheck aria-hidden="true" /> : <Folder aria-hidden="true" />}
              <span className="min-w-0 text-left break-all">{entry.name}</span>
              {entry.space && <Badge variant="secondary" className="ml-auto">已有空间</Badge>}
            </Button>
          </li>)}
        </ul>)}

      {listing?.truncated && <p className="text-sm text-muted-foreground">子文件夹太多，只显示了其中一部分。</p>}
      {listing && <p className="text-sm text-muted-foreground">
        {listing.space ? "这是已有的学习空间。" : "会在这个文件夹里保存 Repa 的数据。"}
      </p>}
    </div>

    <DialogFooter>
      <DialogClose asChild>
        <Button variant="outline">取消</Button>
      </DialogClose>
      <Button disabled={!listing || loading || opening} onClick={() => { void openCurrent(); }}>
        {opening ? "正在打开…" : "打开"}
      </Button>
    </DialogFooter>
  </>;
}
