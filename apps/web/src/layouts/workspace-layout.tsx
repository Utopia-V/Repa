import { Outlet } from "react-router";
import { SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/domain/app-sidebar";
import { useAppStore } from "@/hooks/use-app-store";

function WorkspaceContent() {
  const { isMobile } = useSidebar();
  return <>
    {/* 桌面折叠栏常驻 56px，自带展开入口；仅移动端需要在工作区提供打开入口。 */}
    {isMobile && <div className="fixed top-3 left-3 z-10"><SidebarTrigger /></div>}
    <main className="min-w-0 flex-1 overflow-auto" aria-label="工作区"><Outlet /></main>
  </>;
}

export function WorkspaceLayout() {
  const sidebar = useAppStore((state) => state.sidebar);
  const setSidebarOpen = useAppStore((state) => state.setSidebarOpen);
  const setSidebarWidth = useAppStore((state) => state.setSidebarWidth);
  // 桌面的展开状态和宽度刷新后保留；移动端抽屉每次都从关闭开始，不保存。
  return <SidebarProvider open={sidebar.open} onOpenChange={setSidebarOpen} width={sidebar.width} onWidthChange={setSidebarWidth}>
    <AppSidebar />
    <WorkspaceContent />
  </SidebarProvider>;
}
