import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { openHistory, watchHistory, type ActivitySource, type Revision, type Snapshot } from "@repa/space-history";
import lockfile from "proper-lockfile";

import type { Space, SpaceOptions } from "../space.js";
import { RepaFault } from "../schema.js";
import { directory, existingPath, within } from "./paths.js";

export async function createSpace(root: string, options: SpaceOptions = {}): Promise<Space> {
  await mkdir(root, { recursive: true });
  return openSpace(root, options);
}

export async function openSpace(input: string, options: SpaceOptions = {}): Promise<Space> {
  const root = await realpath(input);
  const dataDir = path.join(root, ".repa");
  await directory(dataDir);
  const onError = options.onError ?? ((error: unknown) => { process.emitWarning(String(error)); });
  let compromised: unknown;
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(root, {
      lockfilePath: path.join(dataDir, "lock"),
      realpath: true,
      retries: 0,
      stale: 30_000,
      update: 10_000,
      onCompromised(error) {
        compromised = error;
        onError(error);
      },
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOCKED") {
      throw new RepaFault("space_locked", "空间已经由另一个后端打开", { root });
    }
    throw error;
  }
  try {
    const sessionsDir = path.join(dataDir, "sessions");
    await directory(sessionsDir);
    await directory(path.join(dataDir, "plugins"));
    await directory(path.join(dataDir, "history.git"));
    const raw = await openHistory(root);
    const activity = new AsyncLocalStorage<boolean>();
    const owned = new AsyncLocalStorage<boolean>();
    const operations = new Set<Promise<unknown>>();
    const listeners = new Set<(revision: Revision) => void>();
    let notifications: Promise<void> = Promise.resolve();
    let notificationError: unknown;
    let closed = false;
    let closing: Promise<void> | undefined;

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

    function checkHistoryRead(): void {
      checkOpen();
      // record 的动作持有历史队列；先读变化再修改，不能在动作里等待同一队列。
      if (activity.getStore()) throw new RepaFault("history_during_activity", "历史读取必须在 record 动作之前完成");
    }

    const unsubscribe = raw.onRevision((id) => {
      // 在 capture 内只登记后续读取；等当前历史操作结束后再通知使用者。
      const revisions = raw.list();
      notifications = notifications.then(async () => {
        const revision = (await revisions).find((item) => item.id === id);
        if (!revision) throw new RepaFault("history_revision_missing", "历史修订不存在", { id });
        for (const listener of listeners) listener(revision);
      }).catch((error: unknown) => {
        notificationError = error;
        onError(error);
      });
    });

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

    function record<T>(source: ActivitySource, action: () => Promise<T>): Promise<{ value: T; snapshot: Snapshot }> {
      return track(async () => {
        if (activity.getStore()) throw new RepaFault("nested_history_activity", "record 动作不能嵌套；文件写入会加入当前活动");
        try {
          return await raw.record(source, () => activity.run(true, action));
        } finally {
          await settled();
        }
      });
    }

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
            const save = async () => {
              const destination = await checkedPath(file);
              if (destination === root) throw new RepaFault("invalid_file_path", "写入路径必须是文件");
              await mkdir(path.dirname(destination), { recursive: true });
              // 创建父目录后再次解析，避免把已有链接误当作尚未创建的目录。
              const checked = await checkedPath(file);
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
                const parent = await open(path.dirname(checked), "r");
                try {
                  await parent.sync();
                } finally {
                  await parent.close();
                }
              } finally {
                await rm(temporary, { force: true });
              }
            };
            if (activity.getStore()) {
              await save();
            } else if (source) {
              await record(source, save);
            } else {
              await save();
              await raw.snapshot();
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

    const watcher = options.watch === false ? undefined : watchHistory(raw, (notify) => {
      const handle = watch(root, { recursive: true }, (_event, name) => {
        const parts = name?.toString().split(path.sep);
        if (parts?.[0] === ".repa" || parts?.some((part) => part === ".git")) return;
        notify();
      });
      handle.on("error", onError);
      return () => { handle.close(); };
    }, { onError });

    const history: Space["history"] = {
      changes(since) {
        checkHistoryRead();
        return raw.changesSince(since ?? null);
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
        } finally {
          await settled();
        }
      },
    };

    return {
      root, dataDir, sessionsDir, history, files, filesFor, record,
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
      async flush() {
        checkHistoryRead();
        await watcher?.flush();
        await raw.snapshot();
        await settled();
      },
      close() {
        if (activity.getStore()) return Promise.reject(new RepaFault("history_during_activity", "空间关闭必须在 record 动作完成后进行"));
        if (closing === undefined) {
          closing = (async () => {
            try {
              await Promise.allSettled([...operations]);
              await watcher?.close();
              await raw.snapshot();
              await settled();
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
