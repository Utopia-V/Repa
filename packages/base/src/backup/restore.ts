import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { checkoutLatest } from "@repa/space-history";

import { RepaFault, type BackupInfo } from "../schema.js";
import { lockSpace } from "../space/lock.js";
import { directory, LOCK_NAME, RESTORE_NAMES } from "../space/paths.js";
import { syncDirectory, writeJson } from "../storage.js";
import { copying, copyTree, isCode, move, remove, syncCopies, walk, type CopyMode, type WalkOptions } from "./copy.js";
import { backupInfo, createBackup, findBackup } from "./store.js";

/** 选中的备份；root 与 id 取自备份列表。 */
export interface RestoreOptions {
  home: string;
  /** 备份所属空间的根目录，即清单中记下的真实路径。 */
  root: string;
  id: string;
  /** 写出空间文件时用的 Git 程序，见 SpaceOptions.gitPath。 */
  gitPath?: string;
  /** 只供测试：每一步之前调用，抛错即模拟进程在这一步之前结束。 */
  step?(name: string): void | Promise<void>;
}

// 从备份原样复制。来源中的目录或文件在复制中途消失即报错：消失说明这份备份正被删除，例如原空间仍在使用，
// 定期备份恰好把它轮换掉了；复制出的内容缺了学习记录等数据，不能发布。
const FROM_BACKUP: WalkOptions & { mode(relative: string): CopyMode } = { skip: () => false, mode: () => "plain", vanished: "fail" };

/**
 * 恢复到原位置：用选中的备份替换空间的 .repa/，全程持有空间锁，锁目录留在原处；空间文件保持原样，下次打开时记为外部改动。
 *
 * 先把当前的 .repa/ 存为一份"恢复前"的备份，这一步失败就停下，空间保持原样。再把选中的备份复制到暂存目录，写下恢复标记，
 * 换出原有内容、换入暂存的内容，最后删除换出的内容，再删除标记。中途中断以后，打开空间见到标记即停止；
 * 重新恢复从头做起，先清理上次的暂存与换出的内容：中断前的状态在上一次的"恢复前"备份里，选中的备份也没有改动。
 * 返回这次的"恢复前"备份，学习者用它可以撤回这次恢复。
 */
export async function restoreInPlace(options: RestoreOptions & {
  /** "恢复前"备份记下的时间，Unix 毫秒。 */
  now: number;
}): Promise<BackupInfo> {
  const { home, root, id } = options;
  const backup = await findBackup(home, root, id);
  let found: boolean;
  try {
    found = (await stat(root)).isDirectory();
  } catch (error) {
    if (!isCode(error, "ENOENT", "ENOTDIR")) throw error;
    found = false;
  }
  if (!found) throw new RepaFault("space_not_found", "空间文件夹不存在，可以恢复到新文件夹", { root });
  const dataDir = path.join(root, ".repa");
  // 学习者只删了 .repa/ 时也能恢复：锁放在 .repa/ 里，先把目录建出来。
  await directory(dataDir);
  let lost: Error | undefined;
  const release = await lockSpace(root, (error) => { lost = error; });
  const step = async (name: string) => {
    if (lost !== undefined) throw new RepaFault("space_lock_lost", "空间锁已失效，恢复已停止", { root });
    await options.step?.(name);
  };
  const staging = path.join(dataDir, RESTORE_NAMES.staging);
  const replaced = path.join(dataDir, RESTORE_NAMES.replaced);
  const marker = path.join(dataDir, RESTORE_NAMES.marker);
  try {
    await step("backup");
    // 空间已关闭、由这里持锁，没有写入者：不打开空间，也不提交历史，数据已经损坏时同样可以复制。
    const before = await createBackup(home, { root, dataDir, withHistory: (action) => action() }, "beforeRestore", options.now);
    await step("clean");
    await remove(staging);
    await remove(replaced);
    await step("stage");
    try {
      await mkdir(staging);
      const staged = copying(staging);
      await copyTree(path.join(backup.directory, "data"), staging, FROM_BACKUP, staged);
      await syncCopies(staged);
    } catch (error) {
      // 还没写下标记，空间仍是原样；删掉暂存的部分，磁盘已满时不再占着空间。
      await remove(staging).catch(() => undefined);
      throw error;
    }
    await step("mark");
    await writeJson(marker, { backup: id });
    await mkdir(replaced);
    for (const name of (await readdir(dataDir)).sort()) {
      if (name === LOCK_NAME || name === RESTORE_NAMES.marker || name === RESTORE_NAMES.staging || name === RESTORE_NAMES.replaced) continue;
      await step(`move-out:${name}`);
      await move(path.join(dataDir, name), path.join(replaced, name));
    }
    for (const name of (await readdir(staging)).sort()) {
      await step(`move-in:${name}`);
      await move(path.join(staging, name), path.join(dataDir, name));
    }
    // 换入换出都落盘以后才删除标记，系统崩溃时不会出现换了一半却没有标记的 .repa/。
    for (const changed of [replaced, staging, dataDir]) await syncDirectory(changed);
    await step("remove-replaced");
    await remove(replaced);
    await step("remove-staging");
    await remove(staging);
    await step("unmark");
    await remove(marker);
    await syncDirectory(dataDir);
    return backupInfo(before);
  } finally {
    await release().catch((error: unknown) => {
      if (lost === undefined) throw error;
    });
  }
}

async function absent(target: string): Promise<void> {
  try {
    await lstat(target);
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
  throw new RepaFault("restore_target_exists", "选定的位置已有同名的文件或文件夹", { target });
}

/**
 * 恢复到新文件夹，用于空间文件夹被误删的情形：在同一位置的临时文件夹中准备全部内容，即备份中的 .repa/，
 * 加上按其中历史的最近一次修订写出的空间文件，完成以后再改为选定的名称。中断时只留下临时文件夹，
 * 再次恢复到同一名称时先清理它，选定的名称处不会出现不完整的空间。历史不收的文件（忽略项、嵌套仓库和大文件）不在其中。
 * 返回新空间根目录的真实路径。
 */
export async function restoreToNew(options: RestoreOptions & { target: string }): Promise<string> {
  const backup = await findBackup(options.home, options.root, options.id);
  if (!path.isAbsolute(options.target)) throw new RepaFault("invalid_path", "新空间的位置需要是绝对路径", { target: options.target });
  const target = path.resolve(options.target);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.restoring`);
  await absent(target);
  await options.step?.("clean");
  await remove(temporary);
  try {
    await mkdir(temporary);
  } catch (error) {
    if (isCode(error, "ENOENT", "ENOTDIR")) throw new RepaFault("invalid_path", "新空间所在的文件夹不存在", { target });
    throw error;
  }
  try {
    const dataDir = path.join(temporary, ".repa");
    await mkdir(dataDir);
    await options.step?.("copy");
    const copied = copying(dataDir);
    await copyTree(path.join(backup.directory, "data"), dataDir, FROM_BACKUP, copied);
    await syncCopies(copied);
    await options.step?.("checkout");
    await checkoutLatest(temporary, options.gitPath === undefined ? {} : { gitPath: options.gitPath });
    // 检出的空间文件与新建的目录也在发布之前落盘，自底向上直到临时文件夹本身，与 .repa/ 的做法一致；
    // 否则断电以后，选定的名称处可能已有内容不完整的空间，再次恢复又会因为目标已存在而被拒绝。
    const checkedOut = copying(temporary);
    for await (const item of walk(temporary, { skip: (relative) => relative === ".repa", vanished: "fail" })) {
      const written = path.join(temporary, ...item.relative.split("/"));
      if (item.directory) checkedOut.written.directories.add(written);
      else checkedOut.written.files.push(written);
    }
    await syncCopies(checkedOut);
    await options.step?.("publish");
    await absent(target);
    await move(temporary, target);
  } catch (error) {
    await remove(temporary).catch(() => undefined);
    throw error;
  }
  await syncDirectory(path.dirname(target));
  return realpath(target);
}
