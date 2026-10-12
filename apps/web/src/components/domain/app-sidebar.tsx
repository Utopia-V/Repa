import { useEffect, useState } from "react";
import { ArrowLeftRight, FolderOpen, History, Settings, X } from "lucide-react";
import { Link, NavLink, useMatch, useNavigate } from "react-router";
import type { SessionInfo } from "@repa/base/protocol";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, SidebarTrigger, useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/domain/error-notice";
import { SessionList } from "@/components/domain/session-list";
import { useAppStore } from "@/hooks/use-app-store";
import { folderName } from "@/lib/paths";

const collapseLabel = "group-data-[collapsible=icon]:sr-only";

export function AppSidebar() {
  const { state, setOpenMobile } = useSidebar();
  const space = useAppStore((store) => store.space);
  const sessions = useAppStore((store) => store.resources.sessions);
  const loadSessions = useAppStore((store) => store.loadSessions);
  const openSession = useAppStore((store) => store.openSession);
  const closeSpace = useAppStore((store) => store.closeSpace);
  const sessionId = useAppStore((store) => store.conversation.sessionId);
  const running = useAppStore((store) => store.conversation.run !== "idle");
  const conversationReady = useAppStore((store) => store.conversation.status === "ready");
  const newConversation = useAppStore((store) => store.newConversation);
  const inConversation = useMatch("/conversation") !== null;
  const navigate = useNavigate();
  const [closing, setClosing] = useState(false);
  const [closeFailure, setCloseFailure] = useState<{ space: string; error: unknown }>();
  const closeMobileSidebar = () => setOpenMobile(false);

  useEffect(() => {
    if (space && sessions.status === "idle") void loadSessions();
  }, [space, sessions.status, loadSessions]);

  function open(session: SessionInfo) {
    closeMobileSidebar();
    void openSession(session);
    void navigate("/conversation");
  }

  function startNew() {
    closeMobileSidebar();
    newConversation();
    void navigate("/conversation");
  }

  async function close(root: string) {
    setClosing(true);
    setCloseFailure(undefined);
    try {
      await closeSpace();
      closeMobileSidebar();
      void navigate("/learning-space");
    } catch (error) {
      // 失败时保留抽屉和这一项，原因显示在它下面，可以再关一次。
      setCloseFailure({ space: root, error });
    } finally {
      setClosing(false);
    }
  }
  const collapsedTitle = (label: string) => state === "collapsed" ? label : undefined;

  return <Sidebar aria-label="应用侧栏" collapsible="icon">
    <SidebarHeader>
      <div className="flex items-center justify-between gap-2 group-data-[collapsible=icon]:justify-center">
        <h1 className={`m-0 text-xl ${collapseLabel}`}>Repa</h1>
        <SidebarTrigger />
      </div>
    </SidebarHeader>
    {/* 内容区随会话增多滚动，History 和 Settings 留在底部。 */}
    <nav aria-label="主导航" className="flex min-h-0 flex-1 flex-col">
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {/* 打开的空间就是一个 Learning Space，所以合成一项：没打开时进选空间页，打开后显示空间名、进对话页。
                后端一次只持有一个空间，换空间回到选空间页。当前项标在下面的会话上，空间这一行不重复标记。
                运行中不能关闭，后端关闭空间会中止运行。 */}
            <SidebarMenuItem>
              {!space && <SidebarMenuButton asChild>
                <NavLink to="/learning-space" onClick={closeMobileSidebar} title={collapsedTitle("Learning Space")}>
                  <FolderOpen aria-hidden="true" /><span className={collapseLabel}>Learning Space</span>
                </NavLink>
              </SidebarMenuButton>}
              {space && <div className="flex items-center gap-1">
                <SidebarMenuButton asChild>
                  <Link to="/conversation" onClick={closeMobileSidebar} title={space}>
                    <FolderOpen aria-hidden="true" /><span className={collapseLabel}>{folderName(space)}</span>
                  </Link>
                </SidebarMenuButton>
                <span className="flex shrink-0 items-center gap-1 group-data-[collapsible=icon]:hidden">
                  <Button asChild variant="ghost" size="icon">
                    <NavLink to="/learning-space" onClick={closeMobileSidebar} aria-label="换空间" title="换空间">
                      <ArrowLeftRight aria-hidden="true" />
                    </NavLink>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`关闭空间 ${folderName(space)}`}
                    title="关闭空间"
                    disabled={running || closing}
                    onClick={() => { void close(space); }}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </span>
              </div>}
              {space && closeFailure?.space === space && <div className="mt-1 group-data-[collapsible=icon]:hidden">
                <ErrorNotice title="关闭空间时出错" error={closeFailure.error} />
              </div>}
              {/* 会话列表读取失败时不提示，对话页有自己的读取与重试。 */}
              {space && <SessionList
                sessions={sessions.data ?? []}
                current={inConversation ? sessionId ?? (conversationReady ? "new" : undefined) : undefined}
                disabled={running}
                onNew={startNew}
                onOpen={open}
              />}
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          {/* 修改历史属于当前空间，打开空间后才有。 */}
          {space && <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <NavLink to="/history" onClick={closeMobileSidebar} title={collapsedTitle("History")}>
                <History aria-hidden="true" /><span className={collapseLabel}>History</span>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>}
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <NavLink to="/settings" onClick={closeMobileSidebar} title={collapsedTitle("Settings")}>
                <Settings aria-hidden="true" /><span className={collapseLabel}>Settings</span>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </nav>
    <SidebarRail />
  </Sidebar>;
}
