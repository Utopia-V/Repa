import { LearningSpacePage } from "@/pages/learning-space";
import { Navigate, type RouteObject } from "react-router";
import { WorkspaceLayout } from "@/layouts/workspace-layout";

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <WorkspaceLayout />,
    children: [
      { index: true, element: <Navigate to="/learning-space" replace /> },
      { path: "learning-space", element: <LearningSpacePage /> },
      { path: "settings", element: null },
      { path: "*", element: <p className="p-8">未找到页面。</p> },
    ],
  },
];
