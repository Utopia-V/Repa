import type { SessionInfo } from "@repa/base/protocol";

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";

/** 会话在列表里的名称：用户起的名字，否则是第一条消息的开头。 */
export function sessionTitle(session: SessionInfo): string {
  return session.name ?? session.preview ?? "还没有消息的会话";
}

/** 当前空间的会话列表，最近有消息的在前；current 为正在查看的会话。 */
export function SessionList({ sessions, current, disabled, onOpen }: {
  sessions: SessionInfo[];
  current?: string | undefined;
  /** 运行中不能切换，只保留当前项可见。 */
  disabled: boolean;
  onOpen(session: SessionInfo): void;
}) {
  return <SidebarMenu>
    {sessions.map((session) => {
      const title = sessionTitle(session);
      const active = session.id === current;
      return <SidebarMenuItem key={session.id}>
        <SidebarMenuButton
          isActive={active}
          aria-current={active ? "true" : undefined}
          disabled={disabled && !active}
          title={title}
          onClick={() => onOpen(session)}
        >
          <span>{title}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>;
    })}
  </SidebarMenu>;
}
