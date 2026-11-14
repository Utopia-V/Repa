import { useEffect, useId, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { FolderOpen, FolderSearch, RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectionButton } from "@/components/ui/selection-button";
import { ErrorNotice } from "@/components/domain/error-notice";
import { FolderPickerDialog } from "@/features/folder-picker";
import { useAppStore, useAppStoreApi } from "@/hooks/use-app-store";
import { homePath } from "@/lib/learning";
import type { Resources } from "@/lib/store";
import { folderName, joinPath, validFolderName } from "@/lib/paths";
import { t } from "@/lib/strings";

export function LearningSpacePage() {
  const spaces = useAppStore((state) => state.resources.spaces);
  const active = useAppStore((state) => state.space);
  const loadSpaces = useAppStore((state) => state.loadSpaces);
  const openSpace = useAppStore((state) => state.openSpace);
  const resumeFailure = useAppStore((state) => state.resumeFailure);
  const closeSpace = useAppStore((state) => state.closeSpace);
  const running = useAppStore((state) => state.conversation.run !== "idle");
  const [opening, setOpening] = useState<string>();
  const [failure, setFailure] = useState<{ root: string; error: unknown }>();
  const [picking, setPicking] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeFailure, setCloseFailure] = useState<{ root: string; error: unknown }>();
  const navigate = useNavigate();
  const store = useAppStoreApi();
  const goHome = () => { void navigate(homePath(store.getState().learning)); };

  useEffect(() => {
    void loadSpaces();
  }, [loadSpaces]);

  async function open(root: string) {
    setOpening(root);
    setFailure(undefined);
    try {
      await openSpace(root);
      goHome();
    } catch (error) {
      setFailure({ root, error });
    } finally {
      setOpening(undefined);
    }
  }

  async function close(root: string) {
    setClosing(true);
    setCloseFailure(undefined);
    try {
      await closeSpace();
    } catch (error) {
      // 后端报错时其实已经放下了这个空间，原因显示出来，可以再关一次。
      setCloseFailure({ root, error });
    } finally {
      setClosing(false);
    }
  }

  const recent = spaces.data;
  const loadFailed = spaces.status === "error";
  // 选择框放在两种布局之外：读取完成时布局切换，不会卸载已经打开的选择框。
  return <>
    {!loadFailed && recent?.length === 0
      ? <FirstSpace onPick={() => setPicking(true)} onCreated={goHome} />
      : <RecentSpaces
        spaces={spaces}
        active={active}
        opening={opening}
        failure={failure ?? (resumeFailure && { ...resumeFailure, previous: true })}
        closeFailure={closeFailure?.root === active ? closeFailure : undefined}
        // 后端关闭空间会中止正在进行的运行，所以运行中不能关。
        closeDisabled={running || closing}
        running={running}
        onClose={(root) => { void close(root); }}
        onPick={() => setPicking(true)}
        onOpen={(root) => { void open(root); }}
        onRetry={() => { void loadSpaces(); }}
      />}
    <FolderPickerDialog open={picking} onOpenChange={setPicking} onOpened={goHome} />
  </>;
}

/**
 * 第一次使用时没有可继续的空间：问这门课叫什么，在用户主目录的 Repa/<名称> 新建空间并打开，落到放课件的起点。
 * 主目录取自后端（不带路径的 space.browse 从它开始）；三个系统都放在这里，Windows 的“文档”常被 OneDrive 接管。
 * 名称不能作文件夹名、或那个文件夹已经有别的内容时如实报错，不替他改名。选已有的文件夹作为次要动作保留。
 */
function FirstSpace({ onPick, onCreated }: { onPick(): void; onCreated(): void }) {
  const browseFolder = useAppStore((state) => state.browseFolder);
  const openSpace = useAppStore((state) => state.openSpace);
  const [home, setHome] = useState<string>();
  const [homeError, setHomeError] = useState<unknown>();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const nameId = useId();
  const hintId = useId();
  const errorId = useId();

  useEffect(() => {
    browseFolder().then((listing) => setHome(listing.path), setHomeError);
  }, [browseFolder]);

  const trimmed = name.trim();
  const invalid = trimmed !== "" && !validFolderName(trimmed);
  const root = home !== undefined && trimmed !== "" && !invalid ? joinPath(home, "Repa", trimmed) : undefined;

  async function create(event: FormEvent) {
    event.preventDefault();
    if (root === undefined) return;
    setCreating(true);
    setFailure(undefined);
    try {
      await openSpace(root, { create: true });
      onCreated();
    } catch (error) {
      setFailure(error);
      setCreating(false);
    }
  }

  // 在工作区里垂直居中；底部留白多一些，视觉重心略高于几何中心。
  return <div className="mx-auto grid min-h-dvh w-full max-w-xl content-center gap-6 px-4 pt-16 pb-24 md:px-8">
    <h2 className="text-display weight-semibold">{t("learningSpace.first.title")}</h2>
    <form className="grid gap-3" onSubmit={(event) => { void create(event); }}>
      <label htmlFor={nameId} className="text-body weight-semibold">{t("learningSpace.first.name.label")}</label>
      <Input
        id={nameId}
        value={name}
        disabled={creating}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : root ? hintId : undefined}
        onChange={(event) => setName(event.target.value)}
      />
      {invalid
        ? <p id={errorId} className="m-0 text-body text-destructive">{t("learningSpace.first.name.invalid.error")}</p>
        : root && <p id={hintId} className="m-0 text-caption break-all text-muted-foreground">{t("learningSpace.first.location.hint", { path: root })}</p>}
      {homeError !== undefined && <ErrorNotice title={t("learningSpace.first.home.error")} error={homeError} />}
      {failure !== undefined && <ErrorNotice title={t("learningSpace.first.create.error")} error={failure} />}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={root === undefined || creating}>{creating ? t("common.opening.status") : t("learningSpace.first.create.action")}</Button>
        <Button variant="ghost" disabled={creating} onClick={onPick} leadingIcon={FolderSearch}>{t("learningSpace.chooseFolder.action")}</Button>
      </div>
    </form>
  </div>;
}

function RecentSpaces({ spaces, active, opening, failure, closeFailure, closeDisabled, running, onPick, onOpen, onClose, onRetry }: {
  spaces: Resources["spaces"];
  active: string | undefined;
  opening: string | undefined;
  failure: { root: string; error: unknown; previous?: boolean } | undefined;
  closeFailure: { root: string; error: unknown } | undefined;
  closeDisabled: boolean;
  /** 运行中只能回到当前空间，换到别的空间会中止运行。 */
  running: boolean;
  onPick(): void;
  onOpen(root: string): void;
  onClose(root: string): void;
  onRetry(): void;
}) {
  const recent = spaces.data;
  const loadFailed = spaces.status === "error";
  const hasRecent = recent !== undefined && recent.length > 0;

  return <div className="mx-auto grid w-full max-w-xl gap-8 px-4 py-16 md:px-8">
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="grid gap-2">
        <h2 className="text-display weight-semibold">{t("learningSpace.recent.title")}</h2>
        <p className="text-body text-muted-foreground">
          {hasRecent ? t("learningSpace.recent.description") : t("learningSpace.recent.noRecent.description")}
        </p>
        {running && <p className="text-body text-muted-foreground">{t("learningSpace.recent.running.hint")}</p>}
      </div>
      {/* 最近列表可用时继续学习是主要操作，选择文件夹退为次要；列表读不出来时它是唯一入口。 */}
      <Button
        variant={loadFailed && !hasRecent ? "primary" : "tertiary"}
        className="w-full sm:w-auto"
        disabled={opening !== undefined || running}
        onClick={onPick}
       leadingIcon={FolderSearch}>{hasRecent ? t("learningSpace.chooseOther.action") : t("learningSpace.chooseFolder.action")}
      </Button>
    </header>

    <section aria-labelledby="recent-spaces" className="grid gap-3">
      <h3 id="recent-spaces" className="text-title weight-semibold">{t("learningSpace.recent.list.title")}</h3>

      {/* 读完之前不显示空状态，避免首次引导一闪而过。 */}
      {!loadFailed && recent === undefined && <p role="status" className="text-body text-muted-foreground">{t("common.loading.status")}</p>}

      {loadFailed && <div className="grid gap-3">
        <ErrorNotice title={t("learningSpace.recent.load.error")} error={spaces.error} />
        <div>
          <Button variant="tertiary" onClick={onRetry} leadingIcon={RefreshCw}>{t("common.retry.action")}
          </Button>
        </div>
      </div>}

      {failure && <ErrorNotice title={t("learningSpace.open.error", { value: failure.previous ? t("learningSpace.lastSpace.label") : " ", root: folderName(failure.root) })} error={failure.error} />}
      {closeFailure && <ErrorNotice title={t("learningSpace.close.error", { root: folderName(closeFailure.root) })} error={closeFailure.error} />}

      {hasRecent && <ul aria-labelledby="recent-spaces" className="m-0 grid list-none gap-2 p-0">
        {/* 打开的空间旁边放关闭；它和其他空间一样可以点，继续回到对话。 */}
        {recent.map((root) => <li key={root} className="flex items-center gap-2">
          <SelectionButton
            className="min-w-0 flex-1"
            selected={root === active}
            disabled={opening !== undefined || (running && root !== active)}
            aria-busy={opening === root}
            onClick={() => onOpen(root)}
          >
            <FolderOpen aria-hidden="true" />
            <span className="grid min-w-0 text-left">
              <span>{folderName(root)}</span>
              <span className="text-caption weight-normal break-all text-muted-foreground">
                {opening === root ? t("common.opening.status") : root}
              </span>
            </span>
          </SelectionButton>
          {root === active && <Button
            variant="tertiary"
            aria-label={t("learningSpace.close.label", { root: folderName(root) })}
            disabled={closeDisabled || opening !== undefined}
            onClick={() => onClose(root)}
           leadingIcon={X}>{t("learningSpace.close.action")}
          </Button>}
        </li>)}
      </ul>}
    </section>
  </div>;
}
