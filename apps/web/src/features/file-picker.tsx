import { useEffect, useId, useRef, useState } from "react";
import { ArrowUp, Folder, HardDrive } from "lucide-react";
import type { Result } from "@repa/base/protocol";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RowButton } from "@/components/ui/row-button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorNotice } from "@/components/domain/error-notice";
import { OptionRow } from "@/components/domain/item-parts";
import { useAppStore } from "@/hooks/use-app-store";
import { fileSize } from "@/lib/format";
import { t } from "@/lib/strings";

type Listing = Result<"space.browse">;
type Roots = Result<"space.roots">;
type View = { kind: "folder"; listing: Listing } | { kind: "roots"; roots: Roots };

/**
 * 选本机的文件。浏览器和桌面端的页面都拿不到本机路径，所以和选文件夹一样由后端列目录、在页面里一层层点进去。
 * 可以在几个文件夹里各勾几个；onPick 收到绝对路径，成功后关闭，失败时对话框留着并显示原因，已勾的不丢。
 */
export function FilePickerDialog({ open, onOpenChange, onPick }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onPick(paths: string[]): Promise<void>;
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t("filePicker.dialog.title")}</DialogTitle>
      </DialogHeader>
      {/* 内容随对话框打开挂载，每次打开都从用户目录重新开始。 */}
      <FileBrowser onPick={async (paths) => {
        await onPick(paths);
        onOpenChange(false);
      }} />
    </DialogContent>
  </Dialog>;
}

function FileBrowser({ onPick }: { onPick(paths: string[]): Promise<void> }) {
  const browseFolder = useAppStore((state) => state.browseFolder);
  const listRoots = useAppStore((state) => state.listRoots);
  const [view, setView] = useState<View>();
  const [roots, setRoots] = useState<Roots>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<{ title: string; error: unknown }>();
  const location = useRef<HTMLHeadingElement>(null);
  const request = useRef(0);
  const base = useId();

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
      if (id === request.current) setError({ title: t("folderPicker.list.error"), error: failure });
    } finally {
      if (id === request.current) setLoading(false);
    }
  }

  const browse = (path?: string) => show(async () => ({ kind: "folder", listing: await browseFolder(path, { files: true }) }));

  useEffect(() => {
    void browse();
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

  async function add() {
    setAdding(true);
    setError(undefined);
    try {
      await onPick(picked);
    } catch (failure) {
      setError({ title: t("filePicker.add.error"), error: failure });
      setAdding(false);
    }
  }

  const toggle = (path: string, checked: boolean) =>
    setPicked((current) => checked ? [...current.filter((item) => item !== path), path] : current.filter((item) => item !== path));

  return <>
    <div className="grid min-w-0 gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <Button variant="tertiary" disabled={!canGoUp || loading || adding} onClick={goUp} leadingIcon={ArrowUp}>{t("folderPicker.parent.action")}
        </Button>
        <h3 ref={location} tabIndex={-1} className="min-w-0 text-body weight-semibold break-all outline-none">
          {view?.kind === "roots" ? t("folderPicker.computer.label") : listing?.path ?? t("folderPicker.home.label")}
        </h3>
      </div>

      {loading && <p role="status" className="text-body text-muted-foreground">{t("common.loading.status")}</p>}
      {error && <ErrorNotice title={error.title} error={error.error} />}

      {view?.kind === "roots" && <ul aria-label={t("folderPicker.drives.label")} className="m-0 grid list-none gap-1 p-0">
        {view.roots.map((root) => <li key={root.path}>
          <RowButton disabled={loading} onClick={() => { void browse(root.path); }}><HardDrive aria-hidden="true" />{root.label}
          </RowButton>
        </li>)}
      </ul>}

      {listing && (listing.entries.length === 0
        ? <p className="text-body text-muted-foreground">{t("filePicker.entries.empty")}</p>
        : <ul aria-label={t("filePicker.entries.label")} className="m-0 grid max-h-80 list-none gap-1 overflow-y-auto p-0">
          {listing.entries.map((entry, index) => entry.file
            // 选中的文件整行换底色，不只靠勾：Checkbox 选中后不悬停时没有边框，单靠它看不出哪几行选了。
            ? <li key={entry.path}><OptionRow selected={picked.includes(entry.path)}>
              <Checkbox
                id={`${base}-${index}`}
                checked={picked.includes(entry.path)}
                disabled={adding}
                onCheckedChange={(checked) => toggle(entry.path, checked)}
              />
              <label htmlFor={`${base}-${index}`} className="min-w-0 flex-1 cursor-pointer text-body break-all">{entry.name}</label>
              {entry.size !== undefined && <span className="shrink-0 text-caption text-muted-foreground tabular-nums">{fileSize(entry.size)}</span>}
            </OptionRow></li>
            : <li key={entry.path}>
              <RowButton disabled={loading || adding} onClick={() => { void browse(entry.path); }}>
                <Folder aria-hidden="true" />
                <span className="min-w-0 text-left break-all">{entry.name}</span>
              </RowButton>
            </li>)}
        </ul>)}

      {listing?.truncated && <p className="text-body text-muted-foreground">{t("filePicker.truncated.hint")}</p>}
    </div>

    <DialogFooter>
      <DialogClose asChild>
        <Button variant="tertiary">{t("common.cancel.action")}</Button>
      </DialogClose>
      <Button disabled={picked.length === 0 || adding} onClick={() => { void add(); }}>
        {t("filePicker.add.action", { count: picked.length })}
      </Button>
    </DialogFooter>
  </>;
}
