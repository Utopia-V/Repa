import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { HistoryError, openHistory, watchHistory, type ActivitySource, type Revision, type Snapshot } from "@repa/space-history";

import { currentRun } from "../run-context.js";
import type { Space, SpaceOptions } from "../space.js";
import { RepaFault } from "../schema.js";
import { syncDirectory } from "../storage.js";
import { checkFormat } from "./format.js";
import { WriteGate } from "./gate.js";
import { lockSpace } from "./lock.js";
import { directory, existingPath, ignoreDataDir, RESTORE_NAMES, within } from "./paths.js";

// 历史变化的通知在模块加载时的空上下文里分发：插件的变化处理不属于触发这次提交的运行，
// 也不在不透明写入者的窗口里，它的写入记在插件名下。
const detached = AsyncLocalStorage.snapshot();

/** 当前运行作为写入来源；运行之外为 undefined。 */
function runSource(): ActivitySource | undefined {
  const run = currentRun();
  if (run === undefined) return undefined;
  return run.ancestorRunIds.length === 0
    ? { kind: "agent", runId: run.runId }
    : { kind: "agent", runId: run.runId, ancestorRunIds: [...run.ancestorRunIds] };
}

// 历史里调用方能处理的错误（修订不存在、没有可撤回的改动）换成同码的 RepaFault，前端拿到可处理的错误码。
function historyFault(error: unknown, details: unknown): unknown {
  return error instanceof HistoryError ? new RepaFault(error.code, error.message, details) : error;
}

// 没有装配同一文件的写入队列时直接执行；提交仍由历史队列串行。
const unqueued = <T>(_file: string, action: () => Promise<T>): Promise<T> => action();

/** 创建空间目录并按打开空间的同一路径初始化持久数据，供新建空间时使用。 */
export async function createSpace(root: string, options: SpaceOptions = {}): Promise<Space> {
  await mkdir(root, { recursive: true });
  return openSpace(root, options);
}

/** 打开并锁定空间，核对持久格式后接入文件、历史和插件数据目录。 */
export async function openSpace(input: string, options: SpaceOptions = {}): Promise<Space> {
  const root = await realpath(input);
  const dataDir = path.join(root, ".repa");
  // 从备份恢复中断后，.repa/ 可能只换了一半，格式标记也可能已经移走；见到恢复标记就不打开，等学习者重新恢复。
  let interrupted = true;
  try {
    await lstat(path.join(dataDir, RESTORE_NAMES.marker));
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) throw error;
    interrupted = false;
  }
  if (interrupted) throw new RepaFault("restore_incomplete", "上次从备份恢复没有完成，请重新恢复", { root });
  // 先识别已有数据，再创建锁或任何辅助文件；未知和更新格式连锁目录也不写。
  try {
    await mkdir(dataDir);
    const marker = await open(path.join(dataDir, "format.json"), "wx", 0o600);
    try {
      await marker.writeFile(`${JSON.stringify({ version: 1 })}\n`);
      await marker.sync();
    } finally {
      await marker.close();
    }
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    await directory(dataDir);
  }
  await checkFormat(path.join(dataDir, "format.json"), 1);
  const onError = options.onError ?? ((error: unknown) => { process.emitWarning(String(error)); });
  let compromised: unknown;
  const release = await lockSpace(root, (error) => {
    compromised = error;
    onError(error);
  });
  try {
    await checkFormat(path.join(dataDir, "format.json"), 1);
    const sessionsDir = path.join(dataDir, "sessions");
    await directory(sessionsDir);
    await directory(path.join(dataDir, "plugins"));
    await directory(path.join(dataDir, "history.git"));
    await ignoreDataDir(dataDir);
    const raw = await openHistory(root, { exclusive: true });
    // 不透明写入者（record）的窗口：动作结束时关上，此后仍在运行的异步工作按普通写入者处理。
    const activity = new AsyncLocalStorage<{ open: boolean }>();
    const owned = new AsyncLocalStorage<boolean>();
    const gate = new WriteGate();
    const fileQueue = options.fileQueue ?? unqueued;
    const operations = new Set<Promise<unknown>>();
    const listeners = new Set<(revision: Revision) => void>();
    let notifications: Promise<void> = Promise.resolve();
    let notificationError: unknown;
    let closed = false;
    let closing: Promise<void> | undefined;
    let maintenanceTimer: ReturnType<typeof setTimeout> | undefined;

    function clearMaintenanceTimer(): void {
      if (maintenanceTimer !== undefined) clearTimeout(maintenanceTimer);
      maintenanceTimer = undefined;
    }

    function scheduleMaintenance(): void {
      clearMaintenanceTimer();
      if (closing !== undefined || closed || compromised) return;
      // 留出一段无提交的时间；真正的维护仍排在历史队列内，不与活动写入并行。
      maintenanceTimer = setTimeout(() => {
        maintenanceTimer = undefined;
        if (compromised) return;
        void raw.maintain({ canRun: () => !compromised }).catch((error: unknown) => {
          scheduleMaintenance();
          onError(error);
        }).catch((error: unknown) => {
          process.emitWarning(String(error));
        });
      }, 30_000);
      maintenanceTimer.unref();
    }

    function checkOpen(): void {
      if (closed || (closing !== undefined && !owned.getStore())) throw new RepaFault("space_closed", "空间已经关闭");
      if (compromised) throw new RepaFault("space_lock_lost", "空间锁已失效", { root });
    }

    function track<T>(action: () => Promise<T>): Promise<T> {
      checkOpen();
      const operation = owned.run(true, () => Promise.resolve().then(action));
      operations.add(operation);
      operation.then(() => { operations.delete(operation); }, () => { operations.delete(operation); });
      return operation;
    }

    function inWindow(): boolean {
      return activity.getStore()?.open === true;
    }

    function checkHistoryRead(): void {
      checkOpen();
      // record 的动作持有历史队列；先读变化再修改，不能在动作里等待同一队列。
      if (inWindow()) throw new RepaFault("history_during_activity", "历史读取必须在 record 动作之前完成");
    }

    const unsubscribe = raw.onRevision((revision) => detached(() => {
      scheduleMaintenance();
      notifications = notifications.then(() => {
        for (const listener of listeners) listener(revision);
      }).catch((error: unknown) => {
        notificationError = error;
        onError(error);
      });
    }));

    async function settled(): Promise<void> {
      let current: Promise<void>;
      do {
        current = notifications;
        await current;
      } while (current !== notifications);
      if (notificationError !== undefined) {
        const error = notificationError;
        notificationError = undefined;
        throw error;
      }
    }

    /**
     * 不透明写入者：独占空间写锁，前后各扫描一次整个空间，期间的改动都记到 source 名下。
     * 动作里经过底座的写入直接落盘，不另进历史队列，算在这次快照里。
     */
    function record<T>(source: ActivitySource, action: () => Promise<T>): Promise<{ value: T; snapshot: Snapshot }> {
      return track(async () => {
        if (inWindow()) throw new RepaFault("nested_history_activity", "record 动作不能嵌套；文件写入会加入当前活动");
        try {
          return await gate.exclusive(() => {
            const window = { open: true };
            return raw.record(source, () => activity.run(window, async () => {
              try {
                return await action();
              } finally {
                window.open = false;
              }
            }));
          });
        } finally {
          await settled();
        }
      });
    }

    function spacePath(file: string): string {
      return path.relative(root, file).split(path.sep).join("/");
    }

    /**
     * 按路径记一次写入：先把这个路径上尚未记录的改动记成 external，再在历史队列里执行 action，最后只提交这个路径。
     * action 在队列里执行，写入前的基线核对也就在这里做。
     */
    function recordPath<T>(source: ActivitySource, file: string, action: () => Promise<T>): Promise<T> {
      return track(async () => {
        try {
          return (await raw.recordPaths(source, [spacePath(file)], action)).value;
        } finally {
          await settled();
        }
      });
    }

    const writes: Space["writes"] = {
      lock(action, signal) {
        if (inWindow()) return action();
        checkOpen();
        return gate.shared(action, signal);
      },
      commit(file, action) {
        if (inWindow()) return action();
        const source = runSource();
        if (source === undefined) return Promise.reject(new RepaFault("run_required", "Agent 的文件写入只能在运行中进行"));
        return recordPath(source, file, action);
      },
    };

    async function checkedPath(file: string): Promise<string> {
      checkOpen();
      const lexical = path.resolve(root, file);
      if (!within(root, lexical) || within(dataDir, lexical)) {
        throw new RepaFault("file_outside_space", "文件路径超出空间内容范围", { file });
      }
      const canonical = await existingPath(lexical);
      if (!within(root, canonical) || within(dataDir, canonical)) {
        throw new RepaFault("file_outside_space", "符号链接超出空间内容范围", { file });
      }
      return canonical;
    }

    function filesFor(source?: ActivitySource): Space["files"] {
      return {
        read(file: string): Promise<string> {
          return track(async () => readFile(await checkedPath(file), "utf8"));
        },
        write(file: string, text: string): Promise<void> {
          return track(async () => {
            const destination = await checkedPath(file);
            if (destination === root) throw new RepaFault("invalid_file_path", "写入路径必须是文件");
            const save = async () => {
              await mkdir(path.dirname(destination), { recursive: true });
              // 创建父目录后再次解析，避免把已有链接误当作尚未创建的目录；记账的路径也要和实际写入的一致。
              const checked = await checkedPath(file);
              if (checked !== destination) throw new RepaFault("file_outside_space", "写入路径在写入期间指向了别处", { file });
              const temporary = path.join(path.dirname(checked), `.repa-write-${randomUUID()}`);
              let mode = 0o600;
              try {
                mode = (await stat(checked)).mode & 0o777;
              } catch (error) {
                if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
              }
              const handle = await open(temporary, "wx", mode);
              try {
                try {
                  await handle.writeFile(text, "utf8");
                  await handle.chmod(mode);
                  await handle.sync();
                } finally {
                  await handle.close();
                }
                await rename(temporary, checked);
                await syncDirectory(path.dirname(checked));
              } finally {
                await rm(temporary, { force: true });
              }
            };
            // 同一文件的写入与 Agent 的写入工具共用一条队列。不透明写入者的窗口里直接落盘，算在它的快照里。
            if (inWindow()) {
              await fileQueue(destination, save);
              return;
            }
            // 来源取当前运行，运行之外是插件；空间自身的文件接口没有来源，按外部改动记下这个路径。
            const recorded = runSource() ?? source;
            try {
              await gate.shared(() => fileQueue(destination, async () => {
                if (recorded !== undefined) {
                  await raw.recordPaths(recorded, [spacePath(destination)], save);
                } else {
                  await save();
                  await raw.snapshotPaths([spacePath(destination)]);
                }
              }));
            } finally {
              await settled();
            }
          });
        },
        list(inputDirectory = "."): Promise<string[]> {
          return track(async () => {
            const directoryPath = await checkedPath(inputDirectory);
            const entries = await readdir(directoryPath, { withFileTypes: true });
            const result: string[] = [];
            for (const entry of entries) {
              const absolute = path.join(directoryPath, entry.name);
              if (within(dataDir, absolute) || entry.name === ".git") continue;
              const relative = path.relative(root, absolute);
              try {
                await checkedPath(relative);
                result.push(relative.split(path.sep).join("/"));
              } catch (error) {
                if (!(error instanceof RepaFault) || error.code !== "file_outside_space") throw error;
              }
            }
            return result.sort();
          });
        },
      };
    }
    const files = filesFor();

    // watcher 只记变了的路径；拿不到文件名时才扫描整个空间。
    const watcher = options.watch === false ? undefined : watchHistory(raw, (notify) => {
      const handle = watch(root, { recursive: true }, (_event, name) => {
        if (name === null) {
          notify();
          return;
        }
        const parts = name.toString().split(path.sep).filter((part) => part !== "" && part !== ".");
        if (parts[0] === ".repa" || parts.some((part) => part === ".git")) return;
        if (parts.length === 0 || parts.includes("..")) notify();
        else notify(parts.join("/"));
      });
      handle.on("error", onError);
      return () => { handle.close(); };
    }, { onError });

    const history: Space["history"] = {
      async changes(since) {
        checkHistoryRead();
        try {
          return await raw.changesSince(since ?? null);
        } catch (error) {
          throw historyFault(error, { revision: since });
        }
      },
      list(limit) {
        checkHistoryRead();
        return raw.list(limit);
      },
      record,
      async undo(revision) {
        checkHistoryRead();
        try {
          return await raw.undo(revision);
        } catch (error) {
          throw historyFault(error, { revision });
        } finally {
          await settled();
        }
      },
      async undoRun(runId) {
        checkHistoryRead();
        try {
          return await raw.undoRun(runId);
        } catch (error) {
          throw historyFault(error, { runId });
        } finally {
          await settled();
        }
      },
    };

    // 旧库可能已经积累对象；即使本次打开后没有新提交，也安排一次检查。
    scheduleMaintenance();

    return {
      root, dataDir, sessionsDir, history, files, filesFor, record, writes,
      async pluginDataDir(id) {
        checkOpen();
        if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new RepaFault("invalid_plugin_id", "插件 id 格式不正确", { id });
        await directory(path.join(dataDir, "plugins"));
        const result = path.join(dataDir, "plugins", id);
        await directory(result);
        return result;
      },
      onRevision(listener) {
        checkOpen();
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      async withHistory(action) {
        checkHistoryRead();
        return track(() => raw.withRepository(action));
      },
      async flush() {
        checkHistoryRead();
        // 整空间扫描只在打开空间和撤回之前；这里只保存 watcher 已经观察到的路径。
        await watcher?.flush();
        await settled();
      },
      close() {
        if (inWindow()) return Promise.reject(new RepaFault("history_during_activity", "空间关闭必须在 record 动作完成后进行"));
        if (closing === undefined) {
          clearMaintenanceTimer();
          closing = (async () => {
            try {
              await Promise.allSettled([...operations]);
              await watcher?.close();
              await settled();
              if (!compromised) await raw.maintain({ canRun: () => !compromised });
            } finally {
              closed = true;
              unsubscribe();
              listeners.clear();
              await release();
            }
          })();
        }
        return closing;
      },
    };
  } catch (error) {
    await release();
    throw error;
  }
}
