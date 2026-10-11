import { vi } from "vitest";
import type { RepaClient } from "@repa/base/client";
import type { Notification, NotificationParams } from "@repa/base/protocol";

type Call = (method: string, params: never) => Promise<unknown>;

/** 只替换调用与通知订阅的客户端；`emit` 模拟后端推送的通知。 */
export function fakeClient<C extends Call>(call: C) {
  const listeners = new Map<string, Set<(params: unknown) => void>>();
  const on = vi.fn((method: string, listener: (params: unknown) => void) => {
    const set = listeners.get(method) ?? new Set();
    listeners.set(method, set);
    set.add(listener);
    return () => set.delete(listener);
  });
  function emit<N extends Notification>(method: N, params: NotificationParams<N>): void {
    for (const listener of listeners.get(method) ?? []) listener(params);
  }
  return { client: { call, on } as unknown as RepaClient, emit };
}
