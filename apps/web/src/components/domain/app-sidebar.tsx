import { FolderOpen, Settings } from "lucide-react";
import { NavLink } from "react-router";
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarHeader,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem,
  SidebarRail, SidebarTrigger, useSidebar,
} from "@/components/ui/sidebar";
import { useAppStore } from "@/hooks/use-app-store";
import { folderName } from "@/lib/paths";

const collapseLabel = "group-data-[collapsible=icon]:sr-only";

export function AppSidebar() {
  const { state, setOpenMobile } = useSidebar();
  const space = useAppStore((store) => store.space);
  const closeMobileSidebar = () => setOpenMobile(false);
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
    </SidebarContent>
    <SidebarRail />
  </Sidebar>;
}
