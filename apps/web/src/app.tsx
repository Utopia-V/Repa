import { useEffect, useMemo, useState } from "react";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { RepaClient, type ClientConnection } from "@repa/base/client";

import { routes } from "./routes";
import { StartupPanel, ReconnectionNotice } from "@/components/domain/connection-state";

type BootstrapState =
  | { status: "starting" }
  | { status: "failed"; message: string }
  | { status: "ready"; connected: boolean };

export type LoadConnection = () => Promise<ClientConnection>;

export async function loadWebConnection(): Promise<ClientConnection> {
  const response = await fetch("/__repa/connection", {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(
      response.ok
        ? "Web 环境返回了无效的后端连接。"
        : "当前 Web 环境没有提供 Repa 后端连接。",
    );
  }
  if (!response.ok) {
    throw new Error(
      value &&
        typeof value === "object" &&
        "error" in value &&
        typeof value.error === "string"
        ? value.error
        : "当前 Web 环境没有提供 Repa 后端连接。",
    );
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("url" in value) ||
    typeof value.url !== "string" ||
    !("token" in value) ||
    typeof value.token !== "string"
  ) {
    throw new Error("Web 开发服务器返回了无效的后端连接。");
  }
  return { url: value.url, token: value.token };
}

export function App({
  loadConnection = loadWebConnection,
}: {
  loadConnection?: LoadConnection;
}) {
  const router = useMemo(() => createBrowserRouter(routes), []);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<BootstrapState>({ status: "starting" });

  useEffect(() => {
    let active = true;
    let client: RepaClient | undefined;
    let removeListener: (() => void) | undefined;
    setState({ status: "starting" });

    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = async (reconnecting: boolean) => {
      try {
        const connection = await loadConnection();
        if (!active) return;
        const next = await RepaClient.connect(connection);
        if (!active) {
          await next.close();
          return;
        }
        client = next;
        removeListener = next.onConnectionChange((connected) => {
          if (!active) return;
          setState({ status: "ready", connected });
          if (!connected) {
            removeListener?.();
            removeListener = undefined;
            void next.close();
            reconnectTimer = setTimeout(() => { void connect(true); }, 1000);
          }
        });
        setState({ status: "ready", connected: true });
      } catch (error) {
        if (!active) return;
        if (reconnecting) {
          reconnectTimer = setTimeout(() => { void connect(true); }, 1000);
        } else {
          setState({
            status: "failed",
            message: error instanceof Error ? error.message : "无法启动 Repa。",
          });
        }
      }
    };
    void connect(false);

    return () => {
      active = false;
      clearTimeout(reconnectTimer);
      removeListener?.();
      void client?.close();
    };
  }, [attempt, loadConnection]);

  if (state.status !== "ready") {
    return (
      <main className="grid min-h-dvh place-items-center p-4 md:p-8">
        <div className="w-full max-w-xl">
          <StartupPanel
            failure={state.status === "failed" ? { message: state.message } : undefined}
            onRetry={() => setAttempt((value) => value + 1)}
          />
        </div>
      </main>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      {!state.connected && (
        <div className="mx-auto w-full max-w-3xl px-4 pt-4 md:px-8">
          <ReconnectionNotice />
        </div>
      )}
      <RouterProvider router={router} />
    </div>
  );
}
