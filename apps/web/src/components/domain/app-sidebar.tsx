import { useEffect } from "react";
import { FolderOpen, History, Settings } from "lucide-react";
import { NavLink, useMatch, useNavigate } from "react-router";
import type { SessionInfo } from "@repa/base/protocol";
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarHeader,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem,
  SidebarRail, SidebarTrigger, useSidebar,
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
  const collapsedTitle = (label: string) => state === "collapsed" ? label : undefined;

  return <Sidebar aria-label="应用侧栏" collapsible="icon">
    <SidebarHeader>
      <div className="flex items-center justify-between gap-2 group-data-[collapsible=icon]:justify-center">
        <h1 className={`m-0 text-xl ${collapseLabel}`}>Repa</h1>
        <SidebarTrigger />
      </div>
    </SidebarHeader>
    <SidebarContent>
      <SidebarGroup>
        <nav aria-label="主导航">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <NavLink to="/learning-space" onClick={closeMobileSidebar} title={collapsedTitle("Learning Space")}>
                  <FolderOpen aria-hidden="true" /><span className={collapseLabel}>Learning Space</span>
                </NavLink>
              </SidebarMenuButton>
              {/* 后端一次只持有一个空间，这里只列出当前打开的那个，最近空间仍在 Learning Space 页选择。 */}
              {space && <SidebarMenuSub>
                <SidebarMenuSubItem>
                  <SidebarMenuSubButton asChild>
                    <NavLink to="/conversation" onClick={closeMobileSidebar} title={space}>
                      <span>{folderName(space)}</span>
                    </NavLink>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              </SidebarMenuSub>}
            </SidebarMenuItem>
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
        </nav>
      </SidebarGroup>
      {/* 读取失败时不提示，对话页有自己的读取与重试；收起为图标栏时隐藏。 */}
      {space && (sessions.data?.length ?? 0) > 0 && <SidebarGroup className="group-data-[collapsible=icon]:hidden">
        <nav aria-labelledby="sidebar-sessions" className="grid gap-1">
          <h2 id="sidebar-sessions" className="m-0 px-4 text-xs font-medium text-muted-foreground">会话</h2>
          <SessionList sessions={sessions.data ?? []} current={inConversation ? sessionId : undefined} disabled={running} onOpen={open} />
        </nav>
      </SidebarGroup>}
    </SidebarContent>
    <SidebarRail />
  </Sidebar>;
}
