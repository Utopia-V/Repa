import { Plus } from "lucide-react";
import type { SessionInfo } from "@repa/base/protocol";

import { SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from "@/components/ui/sidebar";

/** 会话在列表里的名称：用户起的名字，否则是第一条消息的开头。 */
export function sessionTitle(session: SessionInfo): string {
  return session.name ?? session.preview ?? "还没有消息的会话";
}

/**
 * 当前空间下的二级列表：先是开始新会话，再是会话，最近有消息的在前。
 * current 为正在查看的会话，`"new"` 表示正在查看还没建立的新会话。
 */
export function SessionList({ sessions, current, disabled, onNew, onOpen }: {
  sessions: SessionInfo[];
  current?: string | undefined;
  /** 运行中不能切换，只保留当前项可用。 */
  disabled: boolean;
  onNew(): void;
  onOpen(session: SessionInfo): void;
}) {
  const newActive = current === "new";
  return <SidebarMenuSub>
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={newActive}>
        <button type="button" aria-current={newActive ? "true" : undefined} disabled={disabled && !newActive} onClick={onNew}>
          <Plus aria-hidden="true" /><span>新会话</span>
        </button>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
    {sessions.map((session) => {
      const title = sessionTitle(session);
      const active = session.id === current;
      return <SidebarMenuSubItem key={session.id}>
        <SidebarMenuSubButton asChild isActive={active}>
          <button
            type="button"
            aria-current={active ? "true" : undefined}
            disabled={disabled && !active}
            title={title}
            onClick={() => onOpen(session)}
          >
            <span>{title}</span>
          </button>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>;
    })}
  </SidebarMenuSub>;
}
