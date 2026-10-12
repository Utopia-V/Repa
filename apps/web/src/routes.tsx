import { ConversationPage } from "@/pages/conversation";
import { HistoryPage } from "@/pages/history";
import { LearningSpacePage } from "@/pages/learning-space";
import { SettingsPage } from "@/pages/settings";
import { Navigate, type RouteObject } from "react-router";
import { WorkspaceLayout } from "@/layouts/workspace-layout";

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <WorkspaceLayout />,
    children: [
      { index: true, element: <Navigate to="/learning-space" replace /> },
      { path: "learning-space", element: <LearningSpacePage /> },
      { path: "conversation", element: <ConversationPage /> },
      { path: "history", element: <HistoryPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "*", element: <p className="p-8">未找到页面。</p> },
    ],
  },
];
