import { ConversationPage } from "@/pages/conversation";
import { HistoryPage } from "@/pages/history";
import { LearningSpacePage } from "@/pages/learning-space";
import { SettingsPage } from "@/pages/settings";
import { Navigate, type RouteObject } from "react-router";
import { WorkspaceLayout } from "@/layouts/workspace-layout";
import { useAppStore } from "@/hooks/use-app-store";

/** 上次打开的空间还在时直接回到对话，没有时去选空间。 */
function Start() {
  const space = useAppStore((state) => state.space);
  return <Navigate to={space ? "/conversation" : "/learning-space"} replace />;
}

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <WorkspaceLayout />,
    children: [
      { index: true, element: <Start /> },
      { path: "learning-space", element: <LearningSpacePage /> },
      { path: "conversation", element: <ConversationPage /> },
      { path: "history", element: <HistoryPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "*", element: <p className="p-8">未找到页面。</p> },
    ],
  },
];
