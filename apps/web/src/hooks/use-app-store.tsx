import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useStore } from "zustand";

import type { AppState, AppStore } from "@/lib/store";

const StoreContext = createContext<AppStore | null>(null);

export function StoreProvider({ store, children }: { store: AppStore; children: ReactNode }) {
  useEffect(() => {
    // 另一个前端可能改了设置或切换了空间，后端不推送这类变化；切回窗口时重新读取。
    const reload = () => {
      if (document.visibilityState !== "visible" || !store.getState().connected) return;
      void store.getState().reloadLoaded();
    };
    document.addEventListener("visibilitychange", reload);
    return () => document.removeEventListener("visibilitychange", reload);
  }, [store]);
  return <StoreContext value={store}>{children}</StoreContext>;
}

/** 选择器应返回 store 中已有的引用，避免每次渲染生成新对象。 */
export function useAppStore<T>(selector: (state: AppState) => T): T {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useAppStore 需要在 StoreProvider 内使用。");
  return useStore(store, selector);
}
