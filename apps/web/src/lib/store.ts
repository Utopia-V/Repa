import { createStore } from "zustand/vanilla";
import { ConnectionError, type RepaClient } from "@repa/base/client";
import type { Method, Params, Result } from "@repa/base/protocol";

/** 一份从后端读取的数据；重新读取期间保留上一次的 data，界面不回到空白。 */
export type Resource<T> = {
  status: "idle" | "loading" | "ready" | "error";
  data?: T | undefined;
  error?: unknown;
};

type ResourceData = {
  /** 最近打开的空间，最新的在前。 */
  spaces: Result<"space.list">;
};

type ResourceName = keyof ResourceData;

export type Resources = { [N in ResourceName]: Resource<ResourceData[N]> };

export type AppState = {
  /** 当前连接；重连后换成新实例，读取函数执行时才取用。 */
  client?: RepaClient;
  connected: boolean;
  /** 本页面打开的空间。后端不提供查询当前空间的方法，换连接后无法确认，因此清空。 */
  space?: string | undefined;
  resources: Resources;
  setClient(client: RepaClient): void;
  setConnected(connected: boolean): void;
  loadSpaces(): Promise<void>;
  /** 重新读取已经读过的数据，用于重连和窗口切回。 */
  reloadLoaded(): Promise<void>;
  openSpace(root: string): Promise<void>;
  /** 浏览结果只属于当次选择，不进入共享状态。 */
  browseFolder(path?: string): Promise<Result<"space.browse">>;
  listRoots(): Promise<Result<"space.roots">>;
};

export type AppStore = ReturnType<typeof createAppStore>;

export function createAppStore() {
  // 同一份数据只保留一个进行中的读取；序号用于丢弃先发后到的旧结果。
  const pending = new Map<ResourceName, Promise<void>>();
  const sequence = new Map<ResourceName, number>();

  return createStore<AppState>()((set, get) => {
    async function call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
      const client = get().client;
      if (!client) throw new ConnectionError("尚未连接后端。");
      return await client.call(method, params);
    }

    function update<N extends ResourceName>(name: N, resource: Resources[N]): void {
      set((state) => ({ resources: { ...state.resources, [name]: resource } }));
    }

    function load<N extends ResourceName>(name: N, read: () => Promise<ResourceData[N]>): Promise<void> {
      const running = pending.get(name);
      if (running) return running;
      const id = (sequence.get(name) ?? 0) + 1;
      sequence.set(name, id);
      update(name, { ...get().resources[name], status: "loading", error: undefined });
      const promise = read().then(
        (data) => {
          if (sequence.get(name) === id) update(name, { status: "ready", data });
        },
        (error: unknown) => {
          if (sequence.get(name) === id) update(name, { status: "error", data: get().resources[name].data, error });
        },
      ).finally(() => {
        if (pending.get(name) === promise) pending.delete(name);
      });
      pending.set(name, promise);
      return promise;
    }

    const loaders: { [N in ResourceName]: () => Promise<void> } = {
      spaces: () => load("spaces", () => call("space.list", {})),
    };

    return {
      connected: false,
      resources: {
        spaces: { status: "idle" },
      },
      setClient(client) {
        set({ client, connected: true, space: undefined });
        // 旧连接上的读取不再等待；它们晚到的结果会被序号丢弃。
        pending.clear();
        void get().reloadLoaded();
      },
      setConnected(connected) {
        set({ connected });
      },
      loadSpaces: loaders.spaces,
      async reloadLoaded() {
        const { resources } = get();
        const names = (Object.keys(loaders) as ResourceName[]).filter((name) => resources[name].status !== "idle");
        await Promise.all(names.map((name) => loaders[name]()));
      },
      async openSpace(root) {
        const opened = await call("space.open", { root });
        // 属于上一个空间的数据以后在这里清空。
        set({ space: opened.root });
        // 打开前发出的读取可能不含这次打开，重新读取。
        pending.delete("spaces");
        await loaders.spaces();
      },
      browseFolder(path) {
        return call("space.browse", path === undefined ? {} : { path });
      },
      listRoots() {
        return call("space.roots", {});
      },
    };
  });
}
