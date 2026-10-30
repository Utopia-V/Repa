import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, rmdir, symlink, unlink, writeFile, chmod } from "node:fs/promises";
import path from "node:path";

import { Check, Clean } from "typebox/value";

import { Git, GitError, nul } from "./git.js";
import {
  ActivitySourceSchema, HistoryOptionsSchema, SnapshotSourceSchema, SourceSchema,
  type ActivitySource, type Change, type ChangeFeed, type HistoryOptions, type Revision,
  type Snapshot, type SnapshotSource, type Source, type UndoResult,
} from "./schema.js";

const REF = "refs/heads/history";
const NAME = "Repa";
const EMAIL = "history@repa.local";
// 只在宿主调用维护时检查对象布局，不让快照遍历全部历史。
const MAINTENANCE_LOOSE_OBJECTS = 1024;
const MAINTENANCE_PACKS = 32;
// 每次 ls-files 最多带这么多路径，避免大范围撤回超出命令行长度上限。
const PATHSPEC_BATCH = 256;
type Entry = { mode: string; oid: string };
type File = Entry & { data: Buffer };
// previous 是各路径在这次提交之前的条目；按运行撤回由此得到第一次修改前的内容。
type Diff = { change: Change; previous: [string, Entry | undefined][] };
const REVISION = /^[0-9a-f]{40}$/;

/** 调用方可以按 code 分支处理的历史错误。 */
export type HistoryErrorCode =
  // 撤回或查询变化时给的修订不在这份历史里：格式不对、对象不存在或不在历史线上。
  | "revision_not_found"
  // 没有可撤回的改动：运行及其子孙运行没有提交，或目标是空间的初始快照。
  | "nothing_to_undo";

/** 空间历史可由调用方处理的错误，code 区分不存在的修订与不可撤回的操作。 */
export class HistoryError extends Error {
  constructor(readonly code: HistoryErrorCode, message: string) {
    super(message);
    this.name = "HistoryError";
  }
}

async function stat(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    // 某一级上级不是目录时，这个路径同样不存在。
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    throw error;
  }
}

// 只有持有空间锁的宿主才能调用；不进入对象目录，也不沿符号链接清理其他位置。
async function clearStaleLocks(gitDir: string): Promise<void> {
  const names = ["index.lock", "HEAD.lock", "config.lock", "packed-refs.lock", "shallow.lock", "ORIG_HEAD.lock"];
  for (const name of names) {
    const file = path.join(gitDir, name);
    if ((await stat(file))?.isFile()) await unlink(file);
  }
  async function refs(directory: string): Promise<void> {
    if (!(await stat(directory))?.isDirectory()) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await refs(file);
      else if (entry.isFile() && entry.name.endsWith(".lock")) await unlink(file);
    }
  }
  await refs(path.join(gitDir, "refs"));
}

function protectedPath(file: string): boolean {
  const parts = file.split("/");
  return parts[0] === ".repa" || parts.some((part) => part === ".git" || part === ".." || part === "." || part === "");
}

function related(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function changePaths(change: Change): string[] {
  return change.kind === "renamed" ? [change.previousPath, change.path] : [change.path];
}

function same(a: Entry | undefined, b: Entry | undefined): boolean {
  return a?.mode === b?.mode && a?.oid === b?.oid;
}

// Git 自己返回的修订格式不对，说明调用出了问题，不是调用方给错了修订。
function checkedRevision(revision: string): string {
  if (!REVISION.test(revision)) throw new Error("无效的历史 revision");
  return revision;
}

function missingRevision(revision: string): HistoryError {
  return new HistoryError("revision_not_found", `历史中没有这个修订：${revision}`);
}

function checkedPaths(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("路径列表不能为空");
  const items: unknown[] = input;
  const result = new Set<string>();
  for (const file of items) {
    if (typeof file !== "string" || file.includes("\0")
      || file.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`无效的空间路径：${String(file)}`);
    }
    result.add(file);
  }
  return [...result].sort();
}

// a/b/c 的上级是 a 与 a/b。
function parents(file: string): string[] {
  const parts = file.split("/");
  return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

// 历史条目等于某个根、位于某个根之下，或是某个给定路径的上级时，属于本次范围。
function covered(file: string, roots: Set<string>, above: Set<string>): boolean {
  if (roots.has(file) || above.has(file)) return true;
  for (let index = file.indexOf("/"); index >= 0; index = file.indexOf("/", index + 1)) {
    if (roots.has(file.slice(0, index))) return true;
  }
  return false;
}

// 复制来源和祖先链，调用方之后改动数组不影响排队中的保存。根运行的空祖先链不写入提交，同一运行只有一种写法；
// 运行出现在自己的祖先链里说明父子关系成环。
function checkedSource(source: SnapshotSource): SnapshotSource {
  if (source.kind !== "agent") return { ...source };
  const { ancestorRunIds = [], ...rest } = source;
  if (new Set([source.runId, ...ancestorRunIds]).size !== ancestorRunIds.length + 1) {
    throw new Error(`运行不能出现在自己的祖先链里：${source.runId}`);
  }
  return ancestorRunIds.length > 0 ? { ...rest, ancestorRunIds: [...ancestorRunIds] } : rest;
}

// 一条 agent 来源同时给出了这个运行和它各级祖先的祖先链。
function lineage(runId: string, ancestors: string[] = []): [string, string[]][] {
  const chain = [runId, ...ancestors];
  return chain.map((run, index) => [run, chain.slice(index + 1)]);
}

// 记下来源推出的各级祖先链；已有记录的运行保持原样。
function remember(runs: Map<string, string[]>, source: Source): void {
  if (source.kind !== "agent") return;
  for (const [runId, chain] of lineage(source.runId, source.ancestorRunIds)) {
    if (!runs.has(runId)) runs.set(runId, chain);
  }
}

// fast-import 的引号路径只需转义反斜杠、双引号和换行，其余字节原样保留。
function quoted(file: string): string {
  return `"${file.replace(/[\\"\n]/g, (character) => (character === "\n" ? "\\n" : `\\${character}`))}"`;
}

/** 基于 Git 保存文件快照的历史库，提供变化查询、来源记录与选择性撤回。 */
export class SpaceHistory {
  private readonly git: Git;
  private readonly maxFileBytes: number;
  private tail: Promise<unknown> = Promise.resolve();
  private head: string | null = null;
  // head 的完整树，随提交更新，按路径提交时就地修改；按路径记账只比较给定范围，不必每次重新列出整棵树。null 表示需要重新读取。
  private headTree: Map<string, Entry> | null = null;
  // 运行到祖先链的映射，第一次需要时从全部提交来源建立，之后随提交补充；没有提交的运行由子孙的祖先链推出。
  private runs: Map<string, string[]> | null = null;
  // scope 为 null 表示整个空间；保存失败后按同一来源和范围补完。
  private pending: { source: Source; scope: string[] | null } | null = null;
  // 按路径列出时 Git 对单个文件（不是目录）是否忽略的判断，连同当时决定它的忽略规则状态；见 ignoreRules。
  private readonly visibility = new Map<string, { rules: string; listed: boolean }>();
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
    if (options.exclusive) await clearStaleLocks(gitDir);
    if (!(await stat(path.join(gitDir, "config")))) {
      await history.git.run(["init", "--bare", "--object-format=sha1", "--initial-branch=history", gitDir]);
      // 提交由 fast-import 写明提交者，不读这份身份；写入它是为了在影子仓库里手动执行的 Git 命令也有身份可用，只在建库时写一次。
      await history.git.run(["config", "--local", "user.name", NAME]);
      await history.git.run(["config", "--local", "user.email", EMAIL]);
    }
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
      if (this.pending) {
        // 保存失败后先按原范围补完原来源，不能让排队的 watcher 把它重新归为 external。
        const { source, scope } = this.pending;
        const actual = (await this.git.run(["rev-parse", "--verify", REF])).toString().trim();
        if (actual !== this.head) {
          const [saved] = await this.readLog(["-1", REF]);
          if (saved?.parent !== this.head || JSON.stringify(saved.source) !== JSON.stringify(source)) {
            throw new Error("历史引用在保存失败后被其他写入者修改");
          }
          // 引用可能已经更新成功，随后才报告 I/O 错误。
          this.advance(actual, source, null);
        } else if (scope) {
          await this.captureScoped(source, scope);
        } else {
          await this.capture(source);
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

  maintain(options: { force?: boolean; canRun?: () => boolean } = {}): Promise<boolean> {
    const { force = false, canRun } = options;
    if (typeof force !== "boolean" || (canRun !== undefined && typeof canRun !== "function")) {
      throw new Error("无效的维护配置");
    }
    return this.serial(async () => {
      if (!force) {
        const output = (await this.git.run(["count-objects", "-v"])).toString();
        const count = /^count: (\d+)$/m.exec(output)?.[1];
        const packs = /^packs: (\d+)$/m.exec(output)?.[1];
        if (count === undefined || packs === undefined) throw new Error("历史对象计数格式损坏");
        if (Number(count) < MAINTENANCE_LOOSE_OBJECTS && Number(packs) < MAINTENANCE_PACKS) return false;
      }
      // 等待队列及对象检查期间宿主可能已失去空间锁，必须在开始打包前确认许可。
      if (canRun && !canRun()) return false;
      // 保留全部提交与不可达对象；强制检查只跳过阈值，不绕过 Git 的维护锁。
      await this.git.run([
        "-c", "gc.reflogExpire=never",
        "-c", "gc.reflogExpireUnreachable=never",
        "-c", "gc.autoDetach=false",
        "gc", "--quiet", "--cruft", "--prune=never",
      ]);
      return true;
    });
  }

  snapshot(source: SnapshotSource = { kind: "external" }): Promise<Snapshot> {
    if (!Check(SnapshotSourceSchema, source)) throw new Error("无效的快照来源");
    const captured = checkedSource(source);
    return this.serial(async () => {
      await this.checkRun(captured);
      return this.capture(captured);
    });
  }

  // 知道哪些路径变了时只把这些路径记为 external；漏掉的事件由打开历史、record 和撤回前的整空间扫描补上。
  snapshotPaths(paths: string[]): Promise<Snapshot> {
    const scope = checkedPaths(paths);
    return this.serial(() => this.captureScoped({ kind: "external" }, scope));
  }

  record<T>(source: ActivitySource, action: () => Promise<T>): Promise<{ value: T; snapshot: Snapshot }> {
    if (!Check(ActivitySourceSchema, source)) throw new Error("无效的活动来源");
    const captured = checkedSource(source);
    return this.serial(async () => {
      await this.checkRun(captured);
      await this.capture({ kind: "external" });
      return this.captureAfter(captured, action, null);
    });
  }

  recordPaths<T>(source: ActivitySource, paths: string[], action: () => Promise<T>): Promise<{ value: T; snapshot: Snapshot }> {
    if (!Check(ActivitySourceSchema, source)) throw new Error("无效的活动来源");
    const captured = checkedSource(source);
    const scope = checkedPaths(paths);
    return this.serial(async () => {
      await this.checkRun(captured);
      await this.captureScoped({ kind: "external" }, scope);
      return this.captureAfter(captured, action, scope);
    });
  }

  private async captureAfter<T>(
    source: Source,
    action: () => Promise<T>,
    scope: string[] | null,
  ): Promise<{ value: T; snapshot: Snapshot }> {
    const save = () => (scope ? this.captureScoped(source, scope) : this.capture(source));
    let value: T;
    try {
      value = await action();
    } catch (error) {
      try {
        await save();
      } catch (snapshotError) {
        throw new AggregateError([error, snapshotError], "活动与历史保存都失败了");
      }
      throw error;
    }
    return { value, snapshot: await save() };
  }

  list(limit = 100): Promise<Revision[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit 必须是正整数");
    return this.serial(() => this.readLog([`--max-count=${limit}`, REF]));
  }

  changesSince(cursor: string | null): Promise<ChangeFeed> {
    return this.serial(async () => {
      // 插件已经追到当前版本时，没有新的提交，不必启动 Git。
      if (cursor !== null && cursor === this.head) return this.feed([]);
      if (cursor === null) return this.feed(await this.readLog(["--reverse", REF]));
      await this.checkRevision(cursor, false);
      const revisions = await this.readLog(["--reverse", `${cursor}..${REF}`]);
      // 游标不是当前版本时，它在历史线上当且仅当之后的某个提交以它为父提交，不必另用 merge-base 检查。
      if (!revisions.some(({ parent }) => parent?.split(" ").includes(cursor))) throw missingRevision(cursor);
      return this.feed(revisions);
    });
  }

  // 调用方给的修订必须是历史线上的提交；格式不对、对象不存在或不在历史线上都报 revision_not_found，其余 Git 故障照常抛出。
  // ancestry 为假时只检查前两项，由调用方自己确认修订在历史线上。
  private async checkRevision(revision: string, ancestry = true): Promise<void> {
    if (!REVISION.test(revision)) throw missingRevision(revision);
    const checks = [["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]];
    if (ancestry) checks.push(["merge-base", "--is-ancestor", revision, REF]);
    for (const args of checks) {
      try {
        await this.git.run(args);
      } catch (error) {
        if (error instanceof GitError && error.exitCode === 1) throw missingRevision(revision);
        throw error;
      }
    }
  }

  private async readLog(args: string[]): Promise<Revision[]> {
    const fields = nul(await this.git.run(["log", "-z", "--format=%H%x00%P%x00%ct%x00%B", ...args]));
    const result: Revision[] = [];
    for (let i = 0; i < fields.length; i += 4) {
      const [id, parent, time, message] = fields.slice(i, i + 4);
      if (!id || parent === undefined || !time || !message) throw new Error("历史提交格式损坏");
      const source: unknown = Clean(SourceSchema, JSON.parse(message));
      if (!Check(SourceSchema, source)) throw new Error(`历史来源格式损坏：${id}`);
      result.push({ id, parent: parent || null, timestamp: new Date(Number(time) * 1000).toISOString(), source });
    }
    return result;
  }

  private async feed(revisions: Revision[]): Promise<ChangeFeed> {
    const diffs = await this.diffs(revisions);
    if (!this.head) throw new Error("历史尚未初始化");
    return {
      revision: this.head,
      revisions: revisions.map((revision) => ({ ...revision, changes: (diffs.get(revision.id) ?? []).map(({ change }) => change) })),
    };
  }

  private async diffs(revisions: Revision[]): Promise<Map<string, Diff[]>> {
    const result = new Map<string, Diff[]>();
    if (revisions.length === 0) return result;
    const fields = nul(await this.git.run(
      ["diff-tree", "--stdin", "--root", "-r", "-M", "--raw", "--no-abbrev", "-z"],
      revisions.map(({ id }) => id).join("\n") + "\n",
    ));
    let current: Diff[] = [];
    for (let i = 0; i < fields.length;) {
      const field = fields[i++];
      if (!field) throw new Error("历史差异格式损坏");
      if (/^[0-9a-f]{40}$/.test(field)) {
        current = [];
        result.set(field, current);
        continue;
      }
      const [, mode, oid, status] = /^:(\d{6}) \d{6} ([0-9a-f]{40}) [0-9a-f]{40} ([A-Z])\d*$/.exec(field) ?? [];
      const file = fields[i++];
      if (!mode || !oid || !status || !file) throw new Error("历史差异格式损坏");
      const previous = mode === "000000" ? undefined : { mode, oid };
      if (status === "R") {
        const destination = fields[i++];
        if (!destination) throw new Error("历史重命名缺少目标");
        current.push({
          change: { kind: "renamed", previousPath: file, path: destination },
          previous: [[file, previous], [destination, undefined]],
        });
      } else {
        current.push({
          change: { kind: status === "A" ? "added" : status === "D" ? "deleted" : "modified", path: file },
          previous: [[file, previous]],
        });
      }
    }
    return result;
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

  private async headEntries(): Promise<Map<string, Entry>> {
    this.headTree ??= await this.tree(this.head);
    return this.headTree;
  }

  // 同一运行可以多次提交。它自己的提交和子孙提交推出的祖先链都必须一致，运行树才不会分叉或成环。
  private async checkRun(source: Source): Promise<void> {
    if (source.kind !== "agent") return;
    const runs = await this.runIndex();
    for (const [runId, chain] of lineage(source.runId, source.ancestorRunIds)) {
      const known = runs.get(runId);
      if (known && (known.length !== chain.length || known.some((run, index) => run !== chain[index]))) {
        throw new Error(`运行的祖先链与已有提交不一致：${runId}`);
      }
    }
  }

  private async runIndex(): Promise<Map<string, string[]>> {
    if (!this.runs) {
      const revisions = this.head ? await this.readLog(["--reverse", REF]) : [];
      const runs = new Map<string, string[]>();
      for (const { source } of revisions) remember(runs, source);
      this.runs = runs;
    }
    return this.runs;
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

  // 逐个读取 ls-files 列出的候选；越界、过大和特殊文件计入 skipped，其余连同原始字节交给调用方。
  private async *candidates(
    files: string[],
    skipped: Snapshot["skipped"],
    boundaries: Map<string, boolean>,
  ): AsyncGenerator<[string, File]> {
    for (const file of files) {
      if (file.endsWith("/") || await this.boundary(file, boundaries)) {
        // Git for Windows 会列出 junction 里的文件，按路径提交时它可能已经作为给定路径记过一次。
        if (!skipped.some((item) => item.path === file)) skipped.push({ path: file, reason: "repository" });
        continue;
      }
      const info = await stat(path.join(this.space, file));
      if (!info) continue;
      if (info.size > this.maxFileBytes) {
        skipped.push({ path: file, reason: "large" });
        continue;
      }
      const content = await this.read(file);
      if (!content) {
        skipped.push({ path: file, reason: "special" });
        continue;
      }
      if (content.data.length > this.maxFileBytes) {
        skipped.push({ path: file, reason: "large" });
        continue;
      }
      yield [file, content];
    }
  }

  private async capture(source: Source): Promise<Snapshot> {
    this.pending = { source, scope: null };
    const listed = nul(await this.git.run([
      "ls-files", "--others", "--exclude-standard", "-z", "--exclude=/.repa/", "--exclude=.git",
    ]));
    const skipped: Snapshot["skipped"] = [];
    // 整个空间的扫描给 agent 和 undo 留下提交，空运行也有记录；第一次扫描建立基线。
    const always = !this.head || source.kind === "agent" || source.kind === "undo";
    return this.save(source, this.candidates(listed, skipped, new Map()), skipped, () => true, always);
  }

  // 只让给定范围与磁盘一致：路径本身、其下全部内容，以及历史中作为文件出现的上级。范围外的条目保持原样。
  private async captureScoped(source: Source, scope: string[]): Promise<Snapshot> {
    this.pending = { source, scope };
    if (!this.head) throw new Error("历史尚未初始化");
    const roots = new Set(scope);
    const above = new Set(scope.flatMap(parents));
    const boundaries = new Map<string, boolean>();
    const skipped: Snapshot["skipped"] = [];
    // 要列出的路径及其是否为目录。磁盘上没有的路径列不出任何文件，不必交给 Git；它在历史中的条目照样按范围删除。
    const specs = new Map<string, boolean>();
    for (const file of scope) {
      const info = await stat(path.join(this.space, file));
      if (await this.boundary(file, boundaries)) {
        if (info) skipped.push({ path: file, reason: "repository" });
      } else if (info) {
        specs.set(file, info.isDirectory());
      }
    }
    for (const directory of above) {
      const info = await stat(path.join(this.space, directory));
      if (!info || info.isDirectory()) continue;
      // 上级在磁盘上已不是目录，下面不可能还有内容；这一层以下的历史条目都按范围处理。
      roots.add(directory);
      if (!(await this.boundary(directory, boundaries))) specs.set(directory, false);
    }
    const files = this.candidates([...await this.listScope(specs)], skipped, boundaries);
    return this.save(source, files, skipped, (file) => covered(file, roots, above), source.kind === "undo");
  }

  // 列出给定路径中没有被忽略的文件。单个文件沿用 visibility 中仍然有效的判断，其余路径交给 ls-files，
  // 同一文件反复写入、写入后监听又报告它时都不必再启动 Git。
  private async listScope(specs: Map<string, boolean>): Promise<Set<string>> {
    const listed = new Set<string>();
    const rules = new Map<string, string | null>();
    const entries = new Map<string, Set<string> | null>();
    // 同一次列出只读取一次影子仓库的排除规则；读取失败时交给 Git 判断。
    let exclude: string | null;
    try {
      const content = await readFile(path.join(this.space, ".repa", "history.git", "info", "exclude"));
      exclude = createHash("sha1").update(content).digest("hex");
    } catch (error) {
      exclude = error instanceof Error && "code" in error && error.code === "ENOENT" ? "-" : null;
    }
    // 交给 Git 的路径；单个文件附上列出之前的规则状态，目录和规则读不了的文件为 null。
    const asked = new Map<string, string | null>();
    for (const [file, directory] of specs) {
      const state = directory ? null : await this.ignoreRules(file, rules, exclude);
      const known = this.visibility.get(file);
      if (state !== null && known?.rules === state) {
        const parent = path.dirname(file);
        let names = entries.get(parent);
        if (names === undefined) {
          try {
            names = new Set(await readdir(path.join(this.space, parent)));
          } catch {
            // 目录读不了时不沿用判断，由 Git 列出实际名称。
            names = null;
          }
          entries.set(parent, names);
        }
        // 大小写不敏感的文件系统上，旧名字仍能通过 lstat，须核对目录中的实际名称。
        if (names?.has(path.basename(file))) {
          if (known.listed) listed.add(file);
          continue;
        }
      }
      asked.set(file, state);
    }
    const output = new Set<string>();
    const batches = [...asked.keys()];
    for (let index = 0; index < batches.length; index += PATHSPEC_BATCH) {
      const result = await this.git.run([
        "--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--exclude=/.repa/", "--exclude=.git",
        "--", ...batches.slice(index, index + PATHSPEC_BATCH),
      ]);
      for (const file of nul(result)) output.add(file);
    }
    for (const file of output) listed.add(file);
    // Git 列出的每个名字都对得上给定的文件或目录时才记下判断；大小写不敏感的文件系统上，名字可能与给定路径大小写不同。
    const directories = [...asked.keys()].filter((file) => specs.get(file));
    const matched = (name: string) => (asked.has(name) && !specs.get(name))
      || directories.some((directory) => name.startsWith(`${directory}/`));
    if (![...output].every(matched)) return listed;
    // 列出之后文件仍在、规则状态也没变，才说明判断出自这份规则。
    const after = new Map<string, string | null>();
    for (const [file, state] of asked) {
      if (state === null) continue;
      const info = await stat(path.join(this.space, file));
      if (info && !info.isDirectory() && await this.ignoreRules(file, after, exclude) === state) {
        this.visibility.set(file, { rules: state, listed: output.has(file) });
      }
    }
    return listed;
  }

  // 一个文件（不是目录）是否被忽略，只取决于影子仓库的 info/exclude、空间根目录和它各级上级目录中的 .gitignore：
  // 排除选项与 Git 配置固定，全局忽略文件已关闭。返回 info/exclude 的内容 SHA-1 和各 .gitignore 的类型与对象 ID，
  // 缺失记为 -；有一个读不了时返回 null，由 Git 判断。
  private async ignoreRules(file: string, memo: Map<string, string | null>, exclude: string | null): Promise<string | null> {
    if (exclude === null) return null;
    const states: string[] = [exclude];
    for (const directory of ["", ...parents(file)]) {
      let state = memo.get(directory);
      if (state === undefined) {
        try {
          const content = await this.read(directory ? `${directory}/.gitignore` : ".gitignore");
          state = content ? `${content.mode}:${content.oid}` : "-";
        } catch {
          // 读取失败不当作没有规则；不缓存这次判断，Git 自己读取时照常处理或报错。
          state = null;
        }
        memo.set(directory, state);
      }
      if (state === null) return null;
      states.push(state);
    }
    return states.join(" ");
  }

  // 让历史中 inScope 的条目与 files 一致，用一个 fast-import 写入变了的内容、树和提交。内容随读随写，不在内存中积攒；
  // 哪些条目消失要读完才知道，所以提交命令写在最后。没有变化且 always 为假时不提交，也不启动 fast-import。
  private async save(
    source: Source,
    files: AsyncGenerator<[string, File]>,
    skipped: Snapshot["skipped"],
    inScope: (file: string) => boolean,
    always: boolean,
  ): Promise<Snapshot> {
    const head = this.head;
    const previous = await this.headEntries();
    const found = new Map<string, Entry>();
    let next = await files.next();
    while (!next.done && same(next.value[1], previous.get(next.value[0]))) {
      found.set(next.value[0], { mode: next.value[1].mode, oid: next.value[1].oid });
      next = await files.next();
    }
    const vanished = () => [...previous.keys()].filter((file) => inScope(file) && !found.has(file));
    if (head && next.done && !always && vanished().length === 0) {
      this.pending = null;
      return { revision: head, committed: false, skipped };
    }
    const message = JSON.stringify(source) + "\n";
    let removed: string[] = [];
    async function* commands(): AsyncGenerator<Buffer | string> {
      for (; !next.done; next = await files.next()) {
        const [file, content] = next.value;
        found.set(file, { mode: content.mode, oid: content.oid });
        if (!same(content, previous.get(file))) {
          yield `blob\ndata ${content.data.length}\n`;
          yield content.data;
          yield "\n";
        }
      }
      removed = vanished();
      yield `commit ${REF}\nmark :1\ncommitter ${NAME} <${EMAIL}> now\ndata ${Buffer.byteLength(message)}\n${message}`;
      if (head) yield `from ${head}\n`;
      // 先删后写：文件与目录互换时，树中不会同时出现同名文件和目录。
      for (const file of removed) yield `D ${quoted(file)}\n`;
      for (const [file, entry] of found) {
        // 内容已在上面以 blob 写入，这里按对象 ID 引用。
        if (!same(entry, previous.get(file))) yield `M ${entry.mode} ${entry.oid} ${quoted(file)}\n`;
      }
      yield "get-mark :1\ndone\n";
    }
    // fast-import 在 head 之上生成树和提交并更新引用；引用若已被移到不是新提交祖先的位置，它拒绝更新并报错。
    const revision = checkedRevision((await this.git.run(
      ["fast-import", "--quiet", "--done", "--date-format=now"], commands(),
    )).toString().trim());
    // previous 是缓存的 head 树，提交成功后才就地更新。
    for (const file of removed) previous.delete(file);
    for (const [file, entry] of found) previous.set(file, entry);
    this.advance(revision, source, previous);
    return { revision, committed: true, skipped };
  }

  private advance(revision: string, source: Source, tree: Map<string, Entry> | null): void {
    this.head = revision;
    this.headTree = tree;
    this.pending = null;
    if (this.runs) remember(this.runs, source);
    for (const listener of this.listeners) {
      try {
        Promise.resolve(listener(revision)).catch((error: unknown) => { process.emitWarning(String(error)); });
      } catch (error) {
        process.emitWarning(String(error));
      }
    }
  }

  undo(revision: string): Promise<UndoResult> {
    if (!REVISION.test(revision)) throw missingRevision(revision);
    return this.serial(async () => {
      await this.checkRevision(revision);
      await this.capture({ kind: "external" });
      // 目标及其后的全部提交；目标是初始快照时没有父提交，--not 不排除任何提交，列表照样从目标开始。
      const revisions = await this.readLog(["--reverse", REF, "--not", `${revision}^@`]);
      const [target] = revisions;
      if (target?.id !== revision) throw new Error("历史线与修订检查的结果不一致");
      if (!target.parent) throw new HistoryError("nothing_to_undo", "初始快照是空间原有的内容，没有可撤回的改动");
      return this.revert({ kind: "undo", revision }, revisions, new Set([revision]));
    });
  }

  undoRun(runId: string): Promise<UndoResult> {
    if (typeof runId !== "string" || runId.length === 0) throw new Error("无效的运行 ID");
    return this.serial(async () => {
      await this.capture({ kind: "external" });
      const revisions = await this.readLog(["--reverse", REF]);
      // 子孙的每个提交都带着完整祖先链，中间运行即使没有提交也能找到。
      const owned = ({ source }: Revision) => source.kind === "agent"
        && (source.runId === runId || (source.ancestorRunIds ?? []).includes(runId));
      const start = revisions.findIndex(owned);
      if (start < 0) throw new HistoryError("nothing_to_undo", `这个运行及其子运行没有写过文件，没有可撤回的改动：${runId}`);
      if (!revisions[start]?.parent) throw new HistoryError("nothing_to_undo", "初始快照是空间原有的内容，没有可撤回的改动");
      const scope = revisions.slice(start);
      return this.revert({ kind: "undo", runId }, scope, new Set(scope.filter(owned).map(({ id }) => id)));
    });
  }

  // revisions 从第一个目标提交开始按时间排列。每个路径恢复到目标提交第一次修改它之前的内容。
  private async revert(source: Source, revisions: Revision[], targets: Set<string>): Promise<UndoResult> {
    const diffs = await this.diffs(revisions);
    // 复制当前树：随后的 undo 提交会就地更新缓存。
    const after = new Map(await this.headEntries());
    const first = new Map<string, number>();
    const before = new Map<string, Entry>();
    const groups: string[][] = [];
    const others: { index: number; changed: string[] }[] = [];
    for (const [index, { id }] of revisions.entries()) {
      const changes = diffs.get(id) ?? [];
      if (!targets.has(id)) {
        others.push({ index, changed: changes.flatMap(({ change }) => changePaths(change)) });
        continue;
      }
      for (const { change, previous } of changes) {
        groups.push(changePaths(change));
        for (const [file, entry] of previous) {
          if (first.has(file)) continue;
          first.set(file, index);
          if (entry) before.set(file, entry);
        }
      }
    }
    // 目标第一次修改某路径之后，其他来源碰过它或相关的父子路径就不能恢复；夹在目标两次修改之间的改动也算。
    const touched = new Set([...first].filter(([file, start]) => others.some(({ index, changed }) =>
      index > start && changed.some((other) => related(file, other)))).map(([file]) => file));
    // 没有被其他来源碰过、且已回到目标之前内容的路径无需恢复。
    const files = [...first.keys()].filter((file) => touched.has(file) || !same(before.get(file), after.get(file))).sort();
    const conflicts = new Set<string>();
    const removals = new Set(files.filter((file) => !before.has(file)));
    const blocked = new Set(files.filter((file) => [...removals].some((other) =>
      file.startsWith(`${other}/`) && after.get(other)?.mode !== "120000")));
    for (const file of files) {
      if (touched.has(file) || (!blocked.has(file) && await this.boundary(file))) {
        conflicts.add(file);
      }
    }
    // 撤回前的整空间扫描刚列出 after 中的路径，它们没有被忽略，只需检查其余路径。
    const ignored = await this.ignored(files.filter((file) => !conflicts.has(file) && !after.has(file)));
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
    // undo 提交只记录本次恢复的路径，同一时刻的其他改动留给之后的快照。
    const { snapshot: result } = await this.captureAfter(source, async () => {
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
    }, restored);
    return { revision: result.revision, restored, conflicts: [...conflicts] };
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

/** 打开指定目录的空间历史并建立当前基线，供空间模块管理快照与撤回。 */
export const openHistory = (space: string, options?: HistoryOptions): Promise<SpaceHistory> => SpaceHistory.open(space, options);
