import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { Archive, FolderOpen, FolderSearch, RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectionButton } from "@/components/ui/selection-button";
import { StatusNotice } from "@/components/ui/status-notice";
import { ErrorNotice } from "@/components/domain/error-notice";
import { FolderPickerDialog, LocationPickerDialog } from "@/features/folder-picker";
import { SpaceBackups } from "@/features/space-backups";
import { useAppStore, useAppStoreApi } from "@/hooks/use-app-store";
import { errorCode } from "@/lib/errors";
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
  // 要带到哪个空间的备份：打开空间报 restore_incomplete 时设置，n 让再点一次也能重新带过去。
  const [showBackups, setShowBackups] = useState<{ root: string; n: number }>();
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
      // 上次的空间打不开（例如课程文件夹被移走了）而没有别的最近空间时，这里也说明原因，“选择文件夹”就在下面。
      ? <FirstSpace title={t("learningSpace.first.title")} previous={resumeFailure} onPick={() => setPicking(true)} onCreated={goHome} />
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
        onShowBackups={(root) => setShowBackups((current) => ({ root, n: (current?.n ?? 0) + 1 }))}
      >
        <SpaceBackups show={showBackups} onRestored={(root) => { void open(root); }} />
      </RecentSpaces>}
    <FolderPickerDialog open={picking} onOpenChange={setPicking} onOpened={goHome} />
  </>;
}

/** 侧栏里“新建一门课”进的页面：与第一屏是同一个组件，选已有的文件夹仍是次要动作。 */
export function NewSpacePage() {
  const [picking, setPicking] = useState(false);
  const space = useAppStore((state) => state.space);
  const navigate = useNavigate();
  const store = useAppStoreApi();
  const goHome = () => { void navigate(homePath(store.getState().learning)); };
  // 打开了空间时，新课建在这个空间里；还没有空间时与第一屏相同。
  if (space !== undefined) return <NewCourse space={space} onCreated={() => { void navigate("/learn"); }} />;
  return <>
    <FirstSpace title={t("learningSpace.new.title")} onPick={() => setPicking(true)} onCreated={goHome} />
    <FolderPickerDialog open={picking} onOpenChange={setPicking} onOpened={goHome} />
  </>;
}

/**
 * 在当前空间里新建一门课：问课叫什么，建在空间的 courses/<名称>/，落到这门课的制作起点。
 * 名称不能作文件夹名时如实报错，不替他改名。
 */
function NewCourse({ space, onCreated }: { space: string; onCreated(): void }) {
  const createCourse = useAppStore((state) => state.createCourse);
  const running = useAppStore((state) => state.conversation.run !== "idle");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const nameId = useId();
  const hintId = useId();
  const errorId = useId();
  const trimmed = name.trim();
  const invalid = trimmed !== "" && !validFolderName(trimmed);
  const location = trimmed !== "" && !invalid ? joinPath(space, "courses", trimmed) : undefined;

  async function create(event: FormEvent) {
    event.preventDefault();
    if (location === undefined) return;
    setCreating(true);
    setFailure(undefined);
    try {
      await createCourse(trimmed);
      onCreated();
    } catch (error) {
      setFailure(error);
      setCreating(false);
    }
  }

  return <div className="mx-auto grid min-h-dvh w-full max-w-xl content-center gap-6 px-4 pt-16 pb-24 md:px-8">
    <h2 className="text-display weight-semibold">{t("learningSpace.new.title")}</h2>
    <form className="grid gap-3" onSubmit={(event) => { void create(event); }}>
      <label htmlFor={nameId} className="text-body weight-semibold">{t("learningSpace.first.name.label")}</label>
      <Input
        id={nameId}
        value={name}
        disabled={creating}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : location !== undefined ? hintId : undefined}
        onChange={(event) => setName(event.target.value)}
      />
      {invalid && <p id={errorId} className="m-0 text-body text-destructive">{t("learningSpace.first.name.invalid.error")}</p>}
      {location !== undefined && <p id={hintId} className="m-0 text-caption break-all text-muted-foreground">{t("learningSpace.first.location.hint", { path: location })}</p>}
      {failure !== undefined && <ErrorNotice title={t("learningSpace.first.create.error")} error={failure} />}
      {running && <p className="m-0 text-body text-muted-foreground">{t("learningSpace.recent.running.hint")}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={location === undefined || creating || running}>{creating ? t("common.opening.status") : t("learningSpace.first.create.action")}</Button>
      </div>
    </form>
  </div>;
}

/**
 * 第一次使用时没有可继续的空间：问这门课叫什么，“我的 Repa 文件夹”本身就是空间（已经是空间就打开它，否则新建），
 * 课建在其中的 courses/<名称>/，落到放课件的起点。
 * Repa 文件夹缺省是用户主目录下的 Repa，主目录取自后端（不带路径的 space.browse 从它开始）；三个系统都放在这里，
 * Windows 的“文档”常被 OneDrive 接管。C 盘小的学习者可以换个位置，选过以后下次新建仍放在那里。
 * 名称不能作文件夹名、或那个文件夹已经有别的内容时如实报错，不替他改名。选已有的文件夹作为次要动作保留。
 */
function FirstSpace({ title, previous, onPick, onCreated }: {
  title: string;
  /** 重新打开上次的空间失败的原因。 */
  previous?: { root: string; error: unknown } | undefined;
  onPick(): void;
  onCreated(): void;
}) {
  const browseFolder = useAppStore((state) => state.browseFolder);
  const defaultModel = useAppStore((state) => state.resources.defaultModel);
  const loadModelSettings = useAppStore((state) => state.loadModelSettings);
  const createFirstCourse = useAppStore((state) => state.createFirstCourse);
  const chosenFolder = useAppStore((state) => state.repaFolder);
  const setRepaFolder = useAppStore((state) => state.setRepaFolder);
  // 换到新建的空间会中止正在进行的运行，所以运行中不能建。
  const running = useAppStore((state) => state.conversation.run !== "idle");
  const [home, setHome] = useState<string>();
  const [homeError, setHomeError] = useState<unknown>();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const [choosingLocation, setChoosingLocation] = useState(false);
  const nameId = useId();
  const hintId = useId();
  const errorId = useId();

  // 选过位置就不再需要主目录。
  useEffect(() => {
    if (chosenFolder === undefined) browseFolder().then((listing) => setHome(listing.path), setHomeError);
  }, [browseFolder, chosenFolder]);

  // 做课要用模型：全新用户在建课之前就看到先去连一个，不必建好课、走到做课那一步才发现。建课本身不需要模型，不拦。
  useEffect(() => {
    void loadModelSettings();
  }, [loadModelSettings]);
  const noModel = defaultModel.status === "ready" && defaultModel.data === null;

  const trimmed = name.trim();
  const invalid = trimmed !== "" && !validFolderName(trimmed);
  const folder = chosenFolder ?? (home === undefined ? undefined : joinPath(home, "Repa"));
  // 课的文件夹：空间（Repa 文件夹）里的 courses/<名称>。
  const root = folder !== undefined && trimmed !== "" && !invalid ? joinPath(folder, "courses", trimmed) : undefined;
  const location = root ?? folder;

  async function create(event: FormEvent) {
    event.preventDefault();
    if (root === undefined || folder === undefined) return;
    setCreating(true);
    setFailure(undefined);
    try {
      await createFirstCourse(folder, trimmed);
      onCreated();
    } catch (error) {
      setFailure(error);
      setCreating(false);
    }
  }

  // 在工作区里垂直居中；底部留白多一些，视觉重心略高于几何中心。
  return <div className="mx-auto grid min-h-dvh w-full max-w-xl content-center gap-6 px-4 pt-16 pb-24 md:px-8">
    <h2 className="text-display weight-semibold">{title}</h2>
    {previous && <ErrorNotice title={t("learningSpace.open.error", { value: t("learningSpace.lastSpace.label"), root: folderName(previous.root) })} error={previous.error} />}
    {noModel && <div className="grid gap-3">
      <StatusNotice status="error" title={t("common.noModel.title")}><p>{t("making.noModel.description")}</p></StatusNotice>
      <div><Button asChild variant="tertiary"><Link to="/settings">{t("common.setupModel.action")}</Link></Button></div>
    </div>}
    <form className="grid gap-3" onSubmit={(event) => { void create(event); }}>
      <label htmlFor={nameId} className="text-body weight-semibold">{t("learningSpace.first.name.label")}</label>
      <Input
        id={nameId}
        value={name}
        disabled={creating}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : location !== undefined ? hintId : undefined}
        onChange={(event) => setName(event.target.value)}
      />
      {invalid && <p id={errorId} className="m-0 text-body text-destructive">{t("learningSpace.first.name.invalid.error")}</p>}
      {/* 位置一直显示，没起名时是 Repa 文件夹本身，C 盘紧张的人在起名之前就看得到放在哪、能换。 */}
      {!invalid && location !== undefined && <div className="flex flex-wrap items-center gap-x-2">
        <p id={hintId} className="m-0 text-caption break-all text-muted-foreground">{t("learningSpace.first.location.hint", { path: location })}</p>
        <Button variant="ghost" size="compact" disabled={creating} onClick={() => setChoosingLocation(true)}>{t("learningSpace.first.location.change.action")}</Button>
      </div>}
      {chosenFolder === undefined && homeError !== undefined && <ErrorNotice title={t("learningSpace.first.home.error")} error={homeError} />}
      {failure !== undefined && <ErrorNotice title={t("learningSpace.first.create.error")} error={failure} />}
      {running && <p className="m-0 text-body text-muted-foreground">{t("learningSpace.recent.running.hint")}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={root === undefined || creating || running}>{creating ? t("common.opening.status") : t("learningSpace.first.create.action")}</Button>
        <Button variant="ghost" disabled={creating || running} onClick={onPick} leadingIcon={FolderSearch}>{t("learningSpace.chooseFolder.action")}</Button>
      </div>
    </form>
    <LocationPickerDialog open={choosingLocation} onOpenChange={setChoosingLocation} onChosen={setRepaFolder} />
  </div>;
}

function RecentSpaces({ spaces, active, opening, failure, closeFailure, closeDisabled, running, onPick, onOpen, onClose, onRetry, onShowBackups, children }: {
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
  /** 上次从备份恢复没有完成：带到这个空间的备份，重新恢复。 */
  onShowBackups(root: string): void;
  /** 放在最近列表下面的备份。 */
  children: ReactNode;
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
      {failure && errorCode(failure.error) === "restore_incomplete" && <div>
        <Button variant="tertiary" leadingIcon={Archive} onClick={() => onShowBackups(failure.root)}>{t("learningSpace.restoreIncomplete.action")}</Button>
      </div>}
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

    {children}
  </div>;
}
