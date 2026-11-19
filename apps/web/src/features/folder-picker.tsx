import { useEffect, useRef, useState } from "react";
import { ArrowUp, Folder, FolderCheck, HardDrive } from "lucide-react";
import type { Result } from "@repa/base/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RowButton } from "@/components/ui/row-button";
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
import { repaFolderIn } from "@/lib/paths";
import { t } from "@/lib/strings";

type Listing = Result<"space.browse">;
type Roots = Result<"space.roots">;
type View = { kind: "folder"; listing: Listing } | { kind: "roots"; roots: Roots };

/** 选定当前浏览到的文件夹以后做什么：两种选择框共用浏览，只在这里不同。 */
interface Choice {
  action: string;
  /** 当前文件夹下面的一句说明。 */
  hint(listing: Listing): string;
  allowed(listing: Listing): boolean;
  /** 选定这个文件夹；失败时抛出，以 errorTitle 为标题显示原因，选择框留着。 */
  choose(path: string): Promise<void>;
  errorTitle: string;
}

/** 选一个文件夹作为学习空间并打开它。 */
export function FolderPickerDialog({ open, onOpenChange, onOpened }: { open: boolean; onOpenChange(open: boolean): void; onOpened?(): void }) {
  const openSpace = useAppStore((state) => state.openSpace);
  const choice: Choice = {
    action: t("common.open.action"),
    hint: (listing) => (listing.space ? t("folderPicker.existing.hint") : t("folderPicker.new.hint")),
    allowed: () => true,
    async choose(path) {
      await openSpace(path);
      onOpenChange(false);
      onOpened?.();
    },
    errorTitle: t("folderPicker.open.error"),
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t("folderPicker.dialog.title")}</DialogTitle>
        <DialogDescription>{t("folderPicker.dialog.description")}</DialogDescription>
      </DialogHeader>
      {/* 内容随对话框打开挂载，每次打开都从用户目录重新开始。 */}
      <FolderBrowser choice={choice} />
    </DialogContent>
  </Dialog>;
}

/**
 * 选新建课程放在哪里，也就是“我的 Repa 文件夹”的位置：选的文件夹叫 Repa 就用它，否则用它下面的 Repa，见 repaFolderIn。
 * 已有的学习空间不能作为位置，否则新课会建在一门课的文件夹里。
 */
export function LocationPickerDialog({ open, onOpenChange, onChosen }: { open: boolean; onOpenChange(open: boolean): void; onChosen(folder: string): void }) {
  const choice: Choice = {
    action: t("folderPicker.location.action"),
    hint: (listing) => (listing.space ? t("folderPicker.existing.hint") : t("folderPicker.location.hint", { path: repaFolderIn(listing.path) })),
    allowed: (listing) => !listing.space,
    choose(path) {
      onChosen(repaFolderIn(path));
      onOpenChange(false);
      return Promise.resolve();
    },
    errorTitle: t("folderPicker.open.error"),
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t("folderPicker.location.title")}</DialogTitle>
        <DialogDescription>{t("folderPicker.location.description")}</DialogDescription>
      </DialogHeader>
      <FolderBrowser choice={choice} />
    </DialogContent>
  </Dialog>;
}

function FolderBrowser({ choice }: { choice: Choice }) {
  const browseFolder = useAppStore((state) => state.browseFolder);
  const listRoots = useAppStore((state) => state.listRoots);
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
      if (id === request.current) setError({ title: t("folderPicker.list.error"), error: failure });
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

  async function chooseCurrent() {
    if (!listing) return;
    setOpening(true);
    setError(undefined);
    try {
      await choice.choose(listing.path);
    } catch (failure) {
      setError({ title: choice.errorTitle, error: failure });
      setOpening(false);
    }
  }

  return <>
    <div className="grid min-w-0 gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <Button variant="tertiary" disabled={!canGoUp || loading || opening} onClick={goUp} leadingIcon={ArrowUp}>{t("folderPicker.parent.action")}
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
        ? <p className="text-body text-muted-foreground">{t("folderPicker.folders.empty")}</p>
        : <ul aria-label={t("folderPicker.folders.label")} className="m-0 grid max-h-80 list-none gap-1 overflow-y-auto p-0">
          {listing.entries.map((entry) => <li key={entry.path}>
            <RowButton disabled={loading || opening} onClick={() => { void browse(entry.path); }}>
              {entry.space ? <FolderCheck aria-hidden="true" /> : <Folder aria-hidden="true" />}
              <span className="min-w-0 text-left break-all">{entry.name}</span>
              {entry.space && <Badge variant="solid" color="gray" className="ml-auto">{t("folderPicker.existing.label")}</Badge>}
            </RowButton>
          </li>)}
        </ul>)}

      {listing?.truncated && <p className="text-body text-muted-foreground">{t("folderPicker.truncated.hint")}</p>}
      {listing && <p className="text-body break-all text-muted-foreground">{choice.hint(listing)}</p>}
    </div>

    <DialogFooter>
      <DialogClose asChild>
        <Button variant="tertiary">{t("common.cancel.action")}</Button>
      </DialogClose>
      <Button disabled={!listing || !choice.allowed(listing) || loading || opening} onClick={() => { void chooseCurrent(); }}>
        {opening ? t("common.opening.status") : choice.action}
      </Button>
    </DialogFooter>
  </>;
}
