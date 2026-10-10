import type { SpaceHistory } from "./history.js";

export function watchHistory(
  history: Pick<SpaceHistory, "snapshot">,
  watch: (notify: () => void) => () => void,
  options: { debounceMs?: number; onError: (error: unknown) => void },
): { flush(): Promise<void>; close(): Promise<void> } {
  let dirty = false;
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
    while (dirty || pending !== undefined) {
      if (pending === undefined) {
        dirty = false;
        clearTimer();
        pending = Promise.resolve()
          .then(() => history.snapshot({ kind: "external" }))
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
  const stop = watch(() => {
    if (closed) return;
    dirty = true;
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
