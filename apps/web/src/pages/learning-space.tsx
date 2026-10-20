import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { FolderOpen, FolderSearch, RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SelectionButton } from "@/components/ui/selection-button";
import { ErrorNotice } from "@/components/domain/error-notice";
import { FolderPickerDialog } from "@/features/folder-picker";
import { useAppStore } from "@/hooks/use-app-store";
import type { Resources } from "@/lib/store";
import { folderName } from "@/lib/paths";

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

  useEffect(() => {
    void loadSpaces();
  }, [loadSpaces]);

  async function open(root: string) {
    setOpening(root);
    setFailure(undefined);
    try {
      await openSpace(root);
      void navigate("/conversation");
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
      ? <FirstSpace onPick={() => setPicking(true)} />
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
    <FolderPickerDialog open={picking} onOpenChange={setPicking} onOpened={() => { void navigate("/conversation"); }} />
  </>;
}

/** 第一次使用时没有可继续的空间，页面只引导选择文件夹。 */
function FirstSpace({ onPick }: { onPick(): void }) {
  // 在工作区里垂直居中；底部留白多一些，视觉重心略高于几何中心。
  return <div className="mx-auto grid min-h-dvh w-full max-w-xl content-center justify-items-center gap-4 px-4 pt-16 pb-24 text-center md:px-8">
      <h2 className="text-2xl font-semibold">开始第一个学习空间</h2>
      <p className="text-sm text-balance text-muted-foreground">选一个文件夹作为学习空间，Repa 会在里面保存你的学习记录和进度。</p>
      <Button onClick={onPick}>
        <FolderSearch aria-hidden="true" />选择文件夹
      </Button>
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
        <h2 className="text-2xl font-semibold">学习空间</h2>
        <p className="text-sm text-muted-foreground">
          {hasRecent ? "从最近打开的空间继续，或选择其他文件夹。" : "选择一个文件夹作为学习空间。"}
        </p>
        {running && <p className="text-sm text-muted-foreground">对话正在运行，结束或停止后才能换到别的空间。</p>}
      </div>
      {/* 最近列表可用时继续学习是主要操作，选择文件夹退为次要；列表读不出来时它是唯一入口。 */}
      <Button
        variant={loadFailed && !hasRecent ? "default" : "outline"}
        className="w-full sm:w-auto"
        disabled={opening !== undefined || running}
        onClick={onPick}
      >
        <FolderSearch aria-hidden="true" />{hasRecent ? "选择其他文件夹" : "选择文件夹"}
      </Button>
    </header>

    <section aria-labelledby="recent-spaces" className="grid gap-3">
      <h3 id="recent-spaces" className="text-lg font-semibold">最近打开</h3>

      {/* 读完之前不显示空状态，避免首次引导一闪而过。 */}
      {!loadFailed && recent === undefined && <p role="status" className="text-sm text-muted-foreground">正在读取…</p>}

      {loadFailed && <div className="grid gap-3">
        <ErrorNotice title="无法读取最近空间" error={spaces.error} />
        <div>
          <Button variant="outline" onClick={onRetry}>
            <RefreshCw aria-hidden="true" />重试
          </Button>
        </div>
      </div>}

      {failure && <ErrorNotice title={`无法打开${failure.previous ? "上次的空间 " : " "}${folderName(failure.root)}`} error={failure.error} />}
      {closeFailure && <ErrorNotice title={`关闭 ${folderName(closeFailure.root)} 时出错`} error={closeFailure.error} />}

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
              <span className="text-xs font-normal break-all text-muted-foreground">
                {opening === root ? "正在打开…" : root}
              </span>
            </span>
          </SelectionButton>
          {root === active && <Button
            variant="outline"
            aria-label={`关闭空间 ${folderName(root)}`}
            disabled={closeDisabled || opening !== undefined}
            onClick={() => onClose(root)}
          >
            <X aria-hidden="true" />关闭
          </Button>}
        </li>)}
      </ul>}
    </section>
  </div>;
}
