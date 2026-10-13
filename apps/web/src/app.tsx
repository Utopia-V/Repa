import { useEffect, useMemo, useState } from "react";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { RepaClient, type ClientConnection } from "@repa/base/client";
import { useStore } from "zustand";

import { routes } from "./routes";
import { StartupPanel, ReconnectionNotice } from "@/components/domain/connection-state";
import { StoreProvider } from "@/hooks/use-app-store";
import { interactionCapabilities } from "@/lib/ask";
import type { AppStore } from "@/lib/store";

type BootstrapState =
  | { status: "starting" }
  | { status: "failed"; error: unknown }
  | { status: "ready" };

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
  store,
  loadConnection = loadWebConnection,
}: {
  store: AppStore;
  loadConnection?: LoadConnection;
}) {
  const router = useMemo(() => createBrowserRouter(routes), []);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<BootstrapState>({ status: "starting" });
  const connected = useStore(store, (current) => current.connected);

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
        const next = await RepaClient.connect(connection, { capabilities: { interaction: interactionCapabilities } });
        if (!active) {
          await next.close();
          return;
        }
        client = next;
        removeListener = next.onConnectionChange((connected) => {
          if (!active) return;
          store.getState().setConnected(connected);
          if (!connected) {
            removeListener?.();
            removeListener = undefined;
            void next.close();
            reconnectTimer = setTimeout(() => { void connect(true); }, 1000);
          }
        });
        store.getState().setClient(next);
        setState({ status: "ready" });
      } catch (error) {
        if (!active) return;
        if (reconnecting) {
          reconnectTimer = setTimeout(() => { void connect(true); }, 1000);
        } else {
          setState({ status: "failed", error });
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
  }, [attempt, loadConnection, store]);

  if (state.status !== "ready") {
    return (
      <main className="grid min-h-dvh place-items-center p-4 md:p-8">
        <div className="w-full max-w-xl">
          <StartupPanel
            failure={state.status === "failed" ? { error: state.error } : undefined}
            onRetry={() => setAttempt((value) => value + 1)}
          />
        </div>
      </main>
    );
  }

  return (
    <StoreProvider store={store}>
      <div className="flex min-h-dvh flex-col">
        {!connected && (
          <div className="mx-auto w-full max-w-3xl px-4 pt-4 md:px-8">
            <ReconnectionNotice />
          </div>
        )}
        <RouterProvider router={router} />
      </div>
    </StoreProvider>
  );
}
