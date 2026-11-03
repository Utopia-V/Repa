import { useEffect } from "react";
import { ConversationPage } from "@/pages/conversation";
import { HistoryPage } from "@/pages/history";
import { LearnPage } from "@/pages/learn";
import { LearningSpacePage } from "@/pages/learning-space";
import { SettingsPage } from "@/pages/settings";
import { Navigate, type RouteObject } from "react-router";
import { WorkspaceLayout } from "@/layouts/workspace-layout";
import { useAppStore } from "@/hooks/use-app-store";
import { homePath } from "@/lib/learning";

/**
 * 上次打开的空间还在时回到它：后端装了学习插件就进学习页，否则进对话。没有空间时去选空间。
 * 学习插件查询失败时按没有处理，进对话页。
 */
function Start() {
  const space = useAppStore((state) => state.space);
  const learning = useAppStore((state) => state.learning);
  const loadLearning = useAppStore((state) => state.loadLearning);
  const unknown = learning.available === undefined && learning.status !== "error";
  useEffect(() => {
    if (space && unknown && learning.status === "idle") void loadLearning();
  }, [space, unknown, learning.status, loadLearning]);
  if (!space) return <Navigate to="/learning-space" replace />;
  if (unknown) return <p role="status" className="p-8 text-sm text-muted-foreground">正在打开…</p>;
  return <Navigate to={homePath(learning)} replace />;
}

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <WorkspaceLayout />,
    children: [
      { index: true, element: <Start /> },
      { path: "learning-space", element: <LearningSpacePage /> },
      { path: "learn", element: <LearnPage /> },
      { path: "conversation", element: <ConversationPage /> },
      { path: "history", element: <HistoryPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "*", element: <p className="p-8">未找到页面。</p> },
    ],
  },
];
