import type { SpaceHistory } from "./history.js";

// notify(path) 报告变化的路径，相对空间根目录、用 / 分隔；不知道具体路径时调用 notify()。
export function watchHistory(
  history: Pick<SpaceHistory, "snapshot" | "snapshotPaths">,
  watch: (notify: (path?: string) => void) => () => void,
  options: { debounceMs?: number; onError: (error: unknown) => void },
): { flush(): Promise<void>; close(): Promise<void> } {
  // 一批通知都带路径时只记这些路径；其中有一次不带路径，就扫描整个空间。
  let paths = new Set<string>();
  let whole = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let closing: Promise<void> | undefined;

  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  async function flush(): Promise<void> {
    clearTimer();
    while (whole || paths.size > 0 || pending !== undefined) {
      if (pending === undefined) {
        const batch = [...paths];
        const scan = whole;
        paths = new Set();
        whole = false;
        clearTimer();
        pending = Promise.resolve()
          .then(() => (scan ? history.snapshot({ kind: "external" }) : history.snapshotPaths(batch)))
          .catch((error: unknown) => options.onError(error))
          .then(() => {})
          .finally(() => {
            pending = undefined;
          });
      }
      await pending;
    }
  }

  // 宿主排除 .repa/ 等控制目录的事件，避免历史写入再次触发快照。
  const stop = watch((path) => {
    if (closed) return;
    if (path === undefined) {
      whole = true;
    } else {
      paths.add(path);
    }
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      // snapshot 错误交给 onError；错误处理器自身抛错仍需留下诊断。
      void flush().catch((error: unknown) => { process.emitWarning(String(error)); });
    }, options.debounceMs ?? 100);
  });

  function close(): Promise<void> {
    if (closing === undefined) {
      closed = true;
      clearTimer();
      closing = (async () => {
        try {
          stop();
        } finally {
          await flush();
        }
      })();
    }
    return closing;
  }

  return { flush, close };
}
