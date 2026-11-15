import { useEffect } from "react";
import { Folder, FolderOpen, GraduationCap, History, Plus, Settings } from "lucide-react";
import { NavLink, useMatch, useNavigate } from "react-router";
import type { SessionInfo } from "@repa/base/protocol";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, SidebarTrigger, useSidebar,
} from "@/components/ui/sidebar";
import { SessionList } from "@/components/domain/session-list";
import { useAppStore, useAppStoreApi } from "@/hooks/use-app-store";
import { homePath } from "@/lib/learning";
import { folderName } from "@/lib/paths";
import { t } from "@/lib/strings";

const collapseLabel = "group-data-[collapsible=icon]:sr-only";

/** 侧栏里列出的最近的空间（一个空间一门课）；更早的经当前空间进选空间页。 */
const RECENT_SPACES = 5;
/** 侧栏只列学习者自己开的通用对话；辅导和做课的对话在学习页右侧，后台任务不是对话。 */
const GENERAL_AGENT = "general";

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
  const makingSession = useAppStore((store) => store.learning.building?.sessionId ?? undefined);
  const spaces = useAppStore((store) => store.resources.spaces);
  const loadSpaces = useAppStore((store) => store.loadSpaces);
  const openSpace = useAppStore((store) => store.openSpace);
  const store = useAppStoreApi();
  const inConversation = useMatch("/conversation") !== null;
  const navigate = useNavigate();
  const closeMobileSidebar = () => setOpenMobile(false);

  useEffect(() => {
    if (space && sessions.status === "idle") void loadSessions();
  }, [space, sessions.status, loadSessions]);

  useEffect(() => {
    if (spaces.status === "idle") void loadSpaces();
  }, [spaces.status, loadSpaces]);

  // 做课的对话由学习插件记下；直接打开设置页等别的页面时学习状态还没读过，读一次，侧栏才认得出它。
  const learningUnread = useAppStore((store) => store.learning.available === undefined && store.learning.status === "idle");
  const loadLearning = useAppStore((store) => store.loadLearning);
  useEffect(() => {
    if (space && learningUnread) void loadLearning();
  }, [space, learningUnread, loadLearning]);

  // 当前空间排在它在最近列表里的位置；列表读到之前或里面还没有它时放在最前。
  const recent = spaces.data ?? [];
  const listed = (space === undefined || recent.includes(space) ? recent : [space, ...recent]).slice(0, RECENT_SPACES);
  if (space !== undefined && !listed.includes(space)) listed.push(space);
  const own = (sessions.data ?? []).filter((session) => session.agent === GENERAL_AGENT && session.id !== makingSession);

  async function switchTo(root: string) {
    closeMobileSidebar();
    await openSpace(root);
    void navigate(homePath(store.getState().learning));
  }

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

  return <Sidebar aria-label={t("sidebar.app.label")} collapsible="icon">
    <SidebarHeader>
      <div className="flex items-center justify-between gap-2 group-data-[collapsible=icon]:justify-center">
        <h1 className={`m-0 text-display ${collapseLabel}`}>{t("sidebar.brand.title")}</h1>
        <SidebarTrigger />
      </div>
    </SidebarHeader>
    {/* 内容区随会话增多滚动，History 和 Settings 留在底部。 */}
    <nav aria-label={t("sidebar.nav.label")} className="flex min-h-0 flex-1 flex-col">
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {/* 一个空间就是一门课。没有打开的空间时只有“学习空间”，进选空间页。
                打开以后列出最近的几门：当前这门进选空间页（在那里关闭或看全部），下面是它的会话；点别的一门就换过去。
                当前项在对话页时标在下面的会话上，在选空间页时标在当前这门上。 */}
            {space === undefined && <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <NavLink to="/learning-space" onClick={closeMobileSidebar} title={collapsedTitle(t("sidebar.learningSpace.label"))}>
                  <FolderOpen aria-hidden="true" /><span className={collapseLabel}>{t("sidebar.learningSpace.label")}</span>
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>}
            {listed.map((root) => root === space
              ? <SidebarMenuItem key={root}>
                <SidebarMenuButton asChild>
                  {/* 当前这门由打开的文件夹图标和挂在它下面的会话标出，不只靠颜色。 */}
                  <NavLink to="/learning-space" onClick={closeMobileSidebar} title={root} data-current-space="">
                    <FolderOpen aria-hidden="true" /><span className={collapseLabel}>{folderName(root)}</span>
                  </NavLink>
                </SidebarMenuButton>
                {/* 会话列表读取失败时不提示，对话页有自己的读取与重试。 */}
                <SessionList
                  sessions={own}
                  current={inConversation ? sessionId ?? (conversationReady ? "new" : undefined) : undefined}
                  disabled={running}
                  onNew={startNew}
                  onOpen={open}
                />
              </SidebarMenuItem>
              : <SidebarMenuItem key={root}>
                {/* 运行中换空间会中止运行，所以不能换；原因放在提示里。 */}
                <SidebarMenuButton disabled={running} title={running ? t("learningSpace.recent.running.hint") : root} onClick={() => { void switchTo(root); }}>
                  <Folder aria-hidden="true" /><span className={collapseLabel}>{folderName(root)}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>)}
            {(space !== undefined || recent.length > 0) && <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <NavLink to="/new-space" onClick={closeMobileSidebar} title={collapsedTitle(t("sidebar.newSpace.action"))}>
                  <Plus aria-hidden="true" /><span className={collapseLabel}>{t("sidebar.newSpace.action")}</span>
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>}
            {/* 后端装了学习插件时才有学习页；它属于当前空间。 */}
            {space && learnable && <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <NavLink to="/learn" onClick={closeMobileSidebar} title={collapsedTitle(t("learn.page.title"))}>
                  <GraduationCap aria-hidden="true" /><span className={collapseLabel}>{t("learn.page.title")}</span>
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
              <NavLink to="/history" onClick={closeMobileSidebar} title={collapsedTitle(t("sidebar.history.label"))}>
                <History aria-hidden="true" /><span className={collapseLabel}>{t("sidebar.history.label")}</span>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>}
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <NavLink to="/settings" onClick={closeMobileSidebar} title={collapsedTitle(t("sidebar.settings.label"))}>
                <Settings aria-hidden="true" /><span className={collapseLabel}>{t("sidebar.settings.label")}</span>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </nav>
    <SidebarRail />
  </Sidebar>;
}
