import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, rmdir, symlink, unlink, writeFile, chmod } from "node:fs/promises";
import path from "node:path";

import { Check } from "typebox/value";

import { Git, GitError, nul } from "./git.js";
import {
  ActivitySourceSchema, HistoryOptionsSchema, SnapshotSourceSchema, SourceSchema,
  type ActivitySource, type Change, type ChangeFeed, type HistoryOptions, type Revision,
  type Snapshot, type SnapshotSource, type Source, type UndoResult,
} from "./schema.js";

const REF = "refs/heads/history";
const ZERO = "0".repeat(40);
type Entry = { mode: string; oid: string };
type File = Entry & { data: Buffer };

async function stat(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function protectedPath(file: string): boolean {
  const parts = file.split("/");
  return parts[0] === ".repa" || parts.some((part) => part === ".git" || part === ".." || part === "." || part === "");
}

function related(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function paths(change: Change): string[] {
  return change.kind === "renamed" ? [change.previousPath, change.path] : [change.path];
}

function same(a: Entry | undefined, b: Entry | undefined): boolean {
  return a?.mode === b?.mode && a?.oid === b?.oid;
}

function checkedRevision(revision: string): string {
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("无效的历史 revision");
  return revision;
}

export class SpaceHistory {
  private readonly git: Git;
  private readonly maxFileBytes: number;
  private tail: Promise<unknown> = Promise.resolve();
  private head: string | null = null;
  private pendingSource: Source | null = null;
  private readonly listeners = new Set<(revision: string) => void | Promise<void>>();

  private constructor(readonly space: string, options: HistoryOptions) {
    if (!Check(HistoryOptionsSchema, options)) throw new Error("无效的历史配置");
    this.git = new Git(space, path.join(space, ".repa", "history.git"), options.gitPath);
    this.maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024;
  }

  static async open(space: string, options: HistoryOptions = {}): Promise<SpaceHistory> {
    const history = new SpaceHistory(await realpath(space), options);
    const gitDir = path.join(history.space, ".repa", "history.git");
    for (const directory of [path.dirname(gitDir), gitDir]) {
      const info = await stat(directory);
      if (info && !info.isDirectory()) throw new Error(`历史目录必须是普通目录：${directory}`);
      await mkdir(directory, { recursive: true });
    }
    if (!(await stat(path.join(gitDir, "config")))) {
      await history.git.run(["init", "--bare", "--object-format=sha1", "--initial-branch=history", gitDir]);
    }
    await history.git.run(["config", "--local", "user.name", "Repa"]);
    await history.git.run(["config", "--local", "user.email", "history@repa.local"]);
    try {
      history.head = (await history.git.run(["rev-parse", "--verify", "--quiet", REF])).toString().trim();
    } catch (error) {
      if (!(error instanceof GitError) || error.exitCode !== 1) throw error;
    }
    await history.snapshot();
    return history;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.pendingSource) {
        // 保存失败后先补完原来源，不能让排队的 watcher 把它重新归为 external。
        const actual = (await this.git.run(["rev-parse", "--verify", REF])).toString().trim();
        if (actual !== this.head) {
          const [saved] = await this.readLog(["-1", REF]);
          if (saved?.parent !== this.head || JSON.stringify(saved.source) !== JSON.stringify(this.pendingSource)) {
            throw new Error("历史引用在保存失败后被其他写入者修改");
          }
          // update-ref 可能已经成功更新引用，随后才报告 I/O 错误。
          this.advance(actual);
        } else {
          await this.capture(this.pendingSource);
        }
      }
      return operation();
    });
    this.tail = result.catch(() => {});
    return result;
  }

  onRevision(listener: (revision: string) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  snapshot(source: SnapshotSource = { kind: "external" }): Promise<Snapshot> {
    if (!Check(SnapshotSourceSchema, source)) throw new Error("无效的快照来源");
    const captured = { ...source };
    return this.serial(async () => {
      await this.checkRun(captured);
      return this.capture(captured);
    });
  }

  record<T>(source: ActivitySource, action: () => Promise<T>): Promise<{ value: T; snapshot: Snapshot }> {
    if (!Check(ActivitySourceSchema, source)) throw new Error("无效的活动来源");
    const captured = { ...source };
    return this.serial(async () => {
      await this.checkRun(captured);
      await this.capture({ kind: "external" });
      return this.captureAfter(captured, action);
    });
  }

  private async captureAfter<T>(source: Source, action: () => Promise<T>): Promise<{ value: T; snapshot: Snapshot }> {
    let value: T;
    try {
      value = await action();
    } catch (error) {
      try {
        await this.capture(source);
      } catch (snapshotError) {
        throw new AggregateError([error, snapshotError], "活动与历史保存都失败了");
      }
      throw error;
    }
    return { value, snapshot: await this.capture(source) };
  }

  list(limit = 100): Promise<Revision[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit 必须是正整数");
    return this.serial(() => this.readLog([`--max-count=${limit}`, REF]));
  }

  changesSince(cursor: string | null): Promise<ChangeFeed> {
    return this.serial(async () => {
      await this.checkAncestor(cursor);
      return this.feed(cursor);
    });
  }

  private async checkAncestor(revision: string | null): Promise<void> {
    if (revision !== null) {
      await this.git.run(["merge-base", "--is-ancestor", checkedRevision(revision), REF]);
    }
  }

  private async readLog(args: string[]): Promise<Revision[]> {
    const fields = nul(await this.git.run(["log", "-z", "--format=%H%x00%P%x00%ct%x00%B", ...args]));
    const result: Revision[] = [];
    for (let i = 0; i < fields.length; i += 4) {
      const [id, parent, time, message] = fields.slice(i, i + 4);
      if (!id || parent === undefined || !time || !message) throw new Error("历史提交格式损坏");
      const source: unknown = JSON.parse(message);
      if (!Check(SourceSchema, source)) throw new Error(`历史来源格式损坏：${id}`);
      result.push({ id, parent: parent || null, timestamp: new Date(Number(time) * 1000).toISOString(), source });
    }
    return result;
  }

  private async feed(cursor: string | null): Promise<ChangeFeed> {
    const revisions = await this.readLog(["--reverse", cursor ? `${cursor}..${REF}` : REF]);
    const changes = new Map<string, Change[]>();
    if (revisions.length > 0) {
      const fields = nul(await this.git.run(
        ["diff-tree", "--stdin", "--root", "-r", "-M", "--name-status", "-z"],
        revisions.map(({ id }) => id).join("\n") + "\n",
      ));
      let current: Change[] = [];
      for (let i = 0; i < fields.length;) {
        const status = fields[i++];
        if (!status) throw new Error("历史差异格式损坏");
        if (/^[0-9a-f]{40}$/.test(status)) {
          current = [];
          changes.set(status, current);
          continue;
        }
        const file = fields[i++];
        if (!file) throw new Error("历史差异缺少路径");
        if (status.startsWith("R")) {
          const destination = fields[i++];
          if (!destination) throw new Error("历史重命名缺少目标");
          current.push({ kind: "renamed", previousPath: file, path: destination });
        } else {
          current.push({ kind: status === "A" ? "added" : status === "D" ? "deleted" : "modified", path: file });
        }
      }
    }
    if (!this.head) throw new Error("历史尚未初始化");
    return { revision: this.head, revisions: revisions.map((revision) => ({ ...revision, changes: changes.get(revision.id) ?? [] })) };
  }

  private async tree(revision: string | null): Promise<Map<string, Entry>> {
    const entries = new Map<string, Entry>();
    if (revision === null) return entries;
    for (const record of nul(await this.git.run(["ls-tree", "-r", "-z", revision]))) {
      const separator = record.indexOf("\t");
      const [mode, type, oid] = record.slice(0, separator).split(" ");
      const file = record.slice(separator + 1);
      if (!mode || type !== "blob" || !oid || protectedPath(file)) throw new Error("历史树包含无效条目");
      entries.set(file, { mode, oid });
    }
    return entries;
  }

  private async checkRun(source: Source): Promise<void> {
    if (source.kind !== "agent" || !this.head) return;
    const revisions = await this.readLog([REF]);
    if (revisions.some(({ source: previous }) => previous.kind === "agent" && previous.runId === source.runId)) {
      throw new Error(`run 已有历史提交：${source.runId}`);
    }
  }

  // 只检查祖先目录，既不进入嵌套仓库，也不沿符号链接写到空间之外。
  private async boundary(file: string, cache = new Map<string, boolean>()): Promise<boolean> {
    if (protectedPath(file)) return true;
    const parts = file.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const directory = parts.slice(0, i).join("/");
      let excluded = cache.get(directory);
      if (excluded === undefined) {
        const absolute = path.join(this.space, directory);
        const info = await stat(absolute);
        excluded = Boolean(info && !info.isDirectory()) || Boolean(await stat(path.join(absolute, ".git")));
        if (!excluded && await stat(path.join(absolute, "HEAD"))) {
          excluded = Boolean((await stat(path.join(absolute, "objects")))?.isDirectory()
            && (await stat(path.join(absolute, "refs")))?.isDirectory());
        }
        cache.set(directory, excluded);
      }
      if (excluded) return true;
    }
    return false;
  }

  private async read(file: string): Promise<File | undefined> {
    const absolute = path.join(this.space, file);
    const info = await stat(absolute);
    if (!info || (!info.isFile() && !info.isSymbolicLink())) return undefined;
    const data = info.isSymbolicLink() ? await readlink(absolute, { encoding: "buffer" }) : await readFile(absolute);
    const mode = info.isSymbolicLink() ? "120000" : info.mode & 0o111 ? "100755" : "100644";
    const oid = createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
    return { data, mode, oid };
  }

  private async capture(source: Source): Promise<Snapshot> {
    this.pendingSource = source;
    const previous = await this.tree(this.head);
    await this.git.run(["read-tree", "--empty"]);
    const candidates = nul(await this.git.run([
      "ls-files", "--others", "--exclude-standard", "-z", "--exclude=/.repa/", "--exclude=.git",
    ]));
    const entries = new Map<string, Entry>();
    const skipped: Snapshot["skipped"] = [];
    const boundaries = new Map<string, boolean>();
    const history = this;
    async function* blobs(): AsyncGenerator<Buffer | string> {
      for (const file of candidates) {
        if (file.endsWith("/") || await history.boundary(file, boundaries)) {
          skipped.push({ path: file, reason: "repository" });
          continue;
        }
        const info = await stat(path.join(history.space, file));
        if (!info) continue;
        if (info.size > history.maxFileBytes) {
          skipped.push({ path: file, reason: "large" });
          continue;
        }
        const content = await history.read(file);
        if (!content) {
          skipped.push({ path: file, reason: "special" });
          continue;
        }
        if (content.data.length > history.maxFileBytes) {
          skipped.push({ path: file, reason: "large" });
          continue;
        }
        entries.set(file, { mode: content.mode, oid: content.oid });
        if (!same(content, previous.get(file))) {
          yield `blob\ndata ${content.data.length}\n`;
          yield content.data;
          yield "\n";
        }
      }
      yield "done\n";
    }
    await this.git.run(["fast-import", "--quiet", "--done"], blobs());
    await this.git.run(["update-index", "-z", "--index-info"],
      [...entries].map(([file, entry]) => `${entry.mode} ${entry.oid}\t${file}\0`).join(""));
    const tree = (await this.git.run(["write-tree"])).toString().trim();
    const unchanged = entries.size === previous.size && [...entries].every(([file, entry]) => same(entry, previous.get(file)));
    if (this.head && unchanged && source.kind !== "agent" && source.kind !== "undo") {
      this.pendingSource = null;
      return { revision: this.head, committed: false, skipped };
    }
    const args = ["commit-tree", tree];
    if (this.head) args.push("-p", this.head);
    const revision = (await this.git.run(args, JSON.stringify(source) + "\n")).toString().trim();
    await this.git.run(["update-ref", REF, revision, this.head ?? ZERO]);
    this.advance(revision);
    return { revision, committed: true, skipped };
  }

  private advance(revision: string): void {
    this.head = revision;
    this.pendingSource = null;
    for (const listener of this.listeners) {
      try {
        Promise.resolve(listener(revision)).catch((error: unknown) => { process.emitWarning(String(error)); });
      } catch (error) {
        process.emitWarning(String(error));
      }
    }
  }

  undo(revision: string): Promise<UndoResult> {
    checkedRevision(revision);
    return this.serial(async () => {
      await this.checkAncestor(revision);
      await this.capture({ kind: "external" });
      const [target] = await this.readLog(["-1", revision]);
      if (!target?.parent) throw new Error("初始快照不能撤销");
      const before = await this.tree(target.parent);
      const after = await this.tree(revision);
      const feed = await this.feed(target.parent);
      const targetChanges = feed.revisions[0]?.changes ?? [];
      const files = [...new Set(targetChanges.flatMap(paths))].sort();
      const touched = feed.revisions.slice(1).flatMap(({ changes }) => changes.flatMap(paths));
      const conflicts = new Set<string>();
      const removals = new Set(files.filter((file) => !before.has(file)));
      const blocked = new Set(files.filter((file) => [...removals].some((other) =>
        file.startsWith(`${other}/`) && after.get(other)?.mode !== "120000")));
      for (const file of files) {
        if (touched.some((other) => related(file, other)) || (!blocked.has(file) && await this.boundary(file))) {
          conflicts.add(file);
        }
      }
      const ignored = await this.ignored(files.filter((file) => !conflicts.has(file)));
      const directories = new Set<string>();
      for (const file of files) {
        if (ignored.has(file)) conflicts.add(file);
        if (conflicts.has(file) || blocked.has(file)) continue;
        const info = await stat(path.join(this.space, file));
        if (info?.isDirectory() && !after.has(file)) {
          if (!(await this.removableDirectory(file, removals, directories))) conflicts.add(file);
        } else if ((info && !info.isFile() && !info.isSymbolicLink()) || (info && info.size > this.maxFileBytes)
          || !same(await this.read(file), after.get(file))) {
          conflicts.add(file);
        }
      }
      // 重命名两端与目录/文件替换共享恢复结果，不能只恢复其中一端。
      const groups = targetChanges.map(paths);
      let expanded = conflicts.size > 0;
      while (expanded) {
        expanded = false;
        for (const file of files) {
          if (conflicts.has(file)) continue;
          if ([...conflicts].some((other) => related(file, other))
            || groups.some((group) => group.includes(file) && group.some((other) => conflicts.has(other)))) {
            conflicts.add(file);
            expanded = true;
          }
        }
      }
      const restored = files.filter((file) => !conflicts.has(file));
      const blobs = await this.contents(restored.flatMap((file) => {
        const entry = before.get(file);
        return entry ? [entry.oid] : [];
      }));
      const { snapshot: result } = await this.captureAfter({ kind: "undo", revision }, async () => {
        // 先移除运行新增的叶子，再恢复旧叶子，文件与目录互换也遵循这个次序。
        const ordered = [...restored.filter((file) => removals.has(file)), ...restored.filter((file) => before.has(file))];
        for (const file of ordered) {
          const absolute = path.join(this.space, file);
          const current = await stat(absolute);
          const entry = before.get(file);
          if (entry) {
            const data = blobs.get(entry.oid);
            if (!data) throw new Error("历史 blob 缺失");
            if (current?.isDirectory()) {
              for (const directory of [...directories].filter((directory) => related(file, directory)).sort((a, b) => b.length - a.length)) {
                if (await stat(path.join(this.space, directory))) await rmdir(path.join(this.space, directory));
              }
            }
            await mkdir(path.dirname(absolute), { recursive: true });
            const temporary = path.join(path.dirname(absolute), `.repa-undo-${randomUUID()}`);
            try {
              if (entry.mode === "120000") {
                await symlink(data, temporary);
              } else {
                // Git 只保存可执行位；保留现有读写权限，新文件采用仅所有者可读写的权限。
                const access = current?.isFile() ? current.mode & 0o666 : 0o600;
                const mode = entry.mode === "100755" ? access | ((access >> 2) & 0o111) : access;
                await writeFile(temporary, data, { mode, flag: "wx" });
                await chmod(temporary, mode);
              }
              await rename(temporary, absolute);
            } finally {
              await rm(temporary, { force: true });
            }
          } else {
            if (current) await unlink(absolute);
            let directory = path.dirname(absolute);
            while (directory !== this.space) {
              try {
                await rmdir(directory);
              } catch (error) {
                if (error instanceof Error && "code" in error && (error.code === "ENOTEMPTY" || error.code === "ENOENT")) break;
                throw error;
              }
              directory = path.dirname(directory);
            }
          }
        }
      });
      return { revision: result.revision, restored, conflicts: [...conflicts] };
    });
  }

  private async removableDirectory(file: string, removals: Set<string>, directories: Set<string>): Promise<boolean> {
    for (const entry of await readdir(path.join(this.space, file), { withFileTypes: true })) {
      const child = `${file}/${entry.name}`;
      if (protectedPath(child)) return false;
      if (entry.isDirectory()) {
        if (!(await this.removableDirectory(child, removals, directories))) return false;
      } else if (!removals.has(child)) {
        return false;
      }
    }
    directories.add(file);
    return true;
  }

  private async ignored(files: string[]): Promise<Set<string>> {
    if (files.length === 0) return new Set();
    try {
      return new Set(nul(await this.git.run(["check-ignore", "--no-index", "-z", "--stdin"], files.join("\0") + "\0")));
    } catch (error) {
      if (error instanceof GitError && error.exitCode === 1) return new Set();
      throw error;
    }
  }

  private async contents(oids: string[]): Promise<Map<string, Buffer>> {
    const result = new Map<string, Buffer>();
    if (oids.length === 0) return result;
    const output = await this.git.run(["cat-file", "--batch"], [...new Set(oids)].join("\n") + "\n");
    let offset = 0;
    while (offset < output.length) {
      const end = output.indexOf(10, offset);
      const [oid, type, size] = output.subarray(offset, end).toString().split(" ");
      if (!oid || type !== "blob" || !size) throw new Error("历史 blob 格式损坏");
      const length = Number(size);
      result.set(oid, output.subarray(end + 1, end + 1 + length));
      offset = end + length + 2;
    }
    return result;
  }
}

export const openHistory = (space: string, options?: HistoryOptions): Promise<SpaceHistory> => SpaceHistory.open(space, options);
