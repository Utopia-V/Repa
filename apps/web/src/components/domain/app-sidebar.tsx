import { useEffect } from "react";
import { FolderOpen, GraduationCap, History, Settings } from "lucide-react";
import { NavLink, useMatch, useNavigate } from "react-router";
import type { SessionInfo } from "@repa/base/protocol";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, SidebarTrigger, useSidebar,
} from "@/components/ui/sidebar";
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
  const sessionId = useAppStore((store) => store.conversation.sessionId);
  const running = useAppStore((store) => store.conversation.run !== "idle");
  const conversationReady = useAppStore((store) => store.conversation.status === "ready");
  const newConversation = useAppStore((store) => store.newConversation);
  const learnable = useAppStore((store) => store.learning.available === true);
  const inConversation = useMatch("/conversation") !== null;
  const navigate = useNavigate();
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
            {/* 打开的空间就是一个 Learning Space，所以合成一项，都进选空间页：没打开时显示 Learning Space，打开后显示空间名。
                换空间和关闭空间都在选空间页。当前项在对话页时标在下面的会话上，在选空间页时标在这一行。 */}
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <NavLink to="/learning-space" onClick={closeMobileSidebar} title={space ?? collapsedTitle("Learning Space")}>
                  <FolderOpen aria-hidden="true" /><span className={collapseLabel}>{space ? folderName(space) : "Learning Space"}</span>
                </NavLink>
              </SidebarMenuButton>
              {/* 会话列表读取失败时不提示，对话页有自己的读取与重试。 */}
              {space && <SessionList
                sessions={sessions.data ?? []}
                current={inConversation ? sessionId ?? (conversationReady ? "new" : undefined) : undefined}
                disabled={running}
                onNew={startNew}
                onOpen={open}
              />}
            </SidebarMenuItem>
            {/* 后端装了学习插件时才有学习页；它属于当前空间。 */}
            {space && learnable && <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <NavLink to="/learn" onClick={closeMobileSidebar} title={collapsedTitle("学习")}>
                  <GraduationCap aria-hidden="true" /><span className={collapseLabel}>学习</span>
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>}
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
