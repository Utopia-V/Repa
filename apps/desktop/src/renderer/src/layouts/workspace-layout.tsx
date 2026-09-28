import { Outlet } from "react-router";
import { SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/domain/app-sidebar";

function WorkspaceContent() {
  const { isMobile } = useSidebar();
  return <>
    {/* 桌面折叠栏常驻 56px，自带展开入口；仅移动端需要在工作区提供打开入口。 */}
    {isMobile && <div className="fixed top-3 left-3 z-10"><SidebarTrigger /></div>}
    <main className="min-w-0 flex-1 overflow-auto" aria-label="工作区"><Outlet /></main>
  </>;
}

export function WorkspaceLayout() {
  return <SidebarProvider>
    <AppSidebar />
    <WorkspaceContent />
  </SidebarProvider>;
}
