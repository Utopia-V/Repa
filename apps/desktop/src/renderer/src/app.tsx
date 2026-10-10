import { useEffect, useMemo, useState } from "react";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { RepaClient, type ClientConnection } from "@repa/base/client";

import { routes } from "./routes";
import { StartupPanel, ReconnectionNotice } from "@/components/domain/connection-state";

type BootstrapState =
  | { status: "starting" }
  | { status: "failed"; message: string }
  | { status: "ready"; connected: boolean };

export type LoadConnection = () => Promise<ClientConnection>;

export function loadDesktopConnection(): Promise<ClientConnection> {
  return window.repaHost.getConnection();
}

export function App({
  loadConnection = loadDesktopConnection,
}: {
  loadConnection?: LoadConnection;
}) {
  const router = useMemo(() => createMemoryRouter(routes), []);
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
