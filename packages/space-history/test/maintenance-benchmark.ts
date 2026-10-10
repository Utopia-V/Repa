import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { openHistory, type SpaceHistory } from "../src/history.js";
import type { ChangeFeed } from "../src/schema.js";

const execute = promisify(execFile);
const commits = 3_000;
const files = 64;
const lines = 64;
const probes = 7;

async function measured<T>(operation: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await operation();
  return { value, ms: performance.now() - start };
}

async function repositorySize(directory: string): Promise<{ bytes: number; allocatedBytes: number }> {
  const info = await stat(directory);
  let bytes = info.size;
  let allocatedBytes = info.blocks * 512;
  if (info.isDirectory()) {
    for (const child of await readdir(directory)) {
      const size = await repositorySize(path.join(directory, child));
      bytes += size.bytes;
      allocatedBytes += size.allocatedBytes;
    }
  }
  return { bytes, allocatedBytes };
}

function summary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1) };
}

async function inspect(history: SpaceHistory) {
  const gitDir = path.join(history.space, ".repa", "history.git");
  const { stdout } = await execute("git", [`--git-dir=${gitDir}`, "count-objects", "-v"]);
  return { ...await repositorySize(gitDir), objects: stdout.trim() };
}

async function probe(history: SpaceHistory) {
  const revisions = await history.list(commits + 1);
  assert.equal(revisions.length, commits + 1);
  const cursor = revisions[99]?.id;
  const newest = revisions[0];
  assert.ok(cursor && newest);
  const noops: number[] = [];
  const recent: number[] = [];
  const full: number[] = [];
  for (let i = 0; i < probes; i++) {
    const noop = await measured(() => history.snapshot());
    assert.equal(noop.value.committed, false);
    noops.push(noop.ms);
    const changes = await measured((): Promise<ChangeFeed> => history.changesSince(cursor));
    assert.equal(changes.value.revisions.length, 99);
    recent.push(changes.ms);
    const all = await measured(() => history.changesSince(null));
    assert.equal(all.value.revisions.length, commits + 1);
    assert.equal(all.value.revisions[0]?.changes.length, files);
    assert.ok(all.value.revisions.slice(1).every(revision => revision.changes.length === 1));
    full.push(all.ms);
  }
  const changed: number[] = [];
  const undo: number[] = [];
  const file = path.join(history.space, "note-0.md");
  const original = await readFile(file, "utf8");
  for (let i = 0; i < probes; i++) {
    await writeFile(file, `${original}测量追加 ${i}\n`);
    const snapshot = await measured(() => history.snapshot());
    assert.equal(snapshot.value.committed, true);
    changed.push(snapshot.ms);
    const reverted = await measured(() => history.undo(snapshot.value.revision));
    assert.deepEqual(reverted.value.restored, ["note-0.md"]);
    assert.deepEqual(reverted.value.conflicts, []);
    assert.equal(await readFile(file, "utf8"), original);
    undo.push(reverted.ms);
  }
  // 最旧一次改动后来已被重复触碰；维护不能改变冲突判断。
  const oldest = revisions.at(-2);
  assert.ok(oldest);
  const conflicted = await history.undo(oldest.id);
  assert.deepEqual(conflicted.restored, []);
  assert.deepEqual(conflicted.conflicts, ["note-0.md"]);
  return {
    noopSnapshot: summary(noops), modifiedSnapshot: summary(changed),
    undoIncludingSnapshots: summary(undo), changesLast99: summary(recent),
    changesAll3001: summary(full),
  };
}

const temporaryDirectory = await realpath(os.tmpdir());
const filesystem = await statfs(temporaryDirectory);
const { stdout: gitVersion } = await execute("git", ["--version"]);
console.log(JSON.stringify({
  environment: {
    node: process.version, git: gitVersion.trim(), platform: `${process.platform}/${process.arch}`,
    temporaryDirectory, filesystemType: `0x${filesystem.type.toString(16)}`,
  },
  workload: { commits, files, linesPerFile: lines, changedLinesPerCommit: 1, probes, maintenanceCheckEvery: 100 },
}));

// 两份独立仓库交替写入同一文本轨迹，避免把先后运行时的机器负载差异当作维护收益。
const directory = await mkdtemp(path.join(temporaryDirectory, "repa-history-maintenance-benchmark-"));
try {
  const contents = Array.from({ length: files }, (_, file) => Array.from({ length: lines }, (_, line) =>
    `笔记 ${file} 第 ${line} 行：长期状态保留原始内容，revision 000000。\n`));
  const modes: { name: string; history: SpaceHistory; maintenance: number[]; checks: number[]; snapshots: number[] }[] = [];
  for (const name of ["unmaintained", "maintained"]) {
    const space = path.join(directory, name);
    await mkdir(space);
    for (const [i, text] of contents.entries()) await writeFile(path.join(space, `note-${i}.md`), text.join(""));
    modes.push({ name, history: await openHistory(space), maintenance: [], checks: [], snapshots: [] });
  }
  for (let commit = 1; commit <= commits; commit++) {
    const file = (commit - 1) % files;
    const line = Math.floor((commit - 1) / files) % lines;
    const text = contents[file];
    assert.ok(text);
    text[line] = `笔记 ${file} 第 ${line} 行：长期状态保留原始内容，revision ${String(commit).padStart(6, "0")}。\n`;
    for (const mode of commit % 2 === 0 ? modes : [...modes].reverse()) {
      await writeFile(path.join(mode.history.space, `note-${file}.md`), text.join(""));
      const snapshot = await measured(() => mode.history.snapshot({ kind: "plugin", pluginId: "benchmark" }));
      assert.equal(snapshot.value.committed, true);
      mode.snapshots.push(snapshot.ms);
      if (mode.name === "maintained" && commit % 100 === 0) {
        const maintenance = await measured(() => mode.history.maintain());
        (maintenance.value ? mode.maintenance : mode.checks).push(maintenance.ms);
      }
    }
    if (commit % 500 === 0) {
      console.log(JSON.stringify({ progress: commit, repositories: await Promise.all(modes.map(async mode => ({ name: mode.name, ...await inspect(mode.history) }))) }));
    }
  }
  for (const mode of modes) {
    // 先读取大小，再做读写探针；探针产生的 revision 不混入 3,000 次修改的大小统计。
    const repository = await inspect(mode.history);
    const latency = await probe(mode.history);
    const before = await mode.history.changesSince(null);
    const maintenance = await measured(() => mode.history.maintain({ force: true }));
    assert.equal(maintenance.value, true);
    assert.deepEqual(await mode.history.changesSince(null), before);
    for (const [i, text] of contents.entries()) {
      assert.equal(await readFile(path.join(mode.history.space, `note-${i}.md`), "utf8"), text.join(""));
    }
    console.log(JSON.stringify({
      mode: mode.name, repository, latency,
      workloadSnapshots: summary(mode.snapshots),
      scheduledMaintenance: { count: mode.maintenance.length, totalMs: mode.maintenance.reduce((a, b) => a + b, 0), ...summary(mode.maintenance) },
      skippedChecks: { count: mode.checks.length, ...summary(mode.checks) },
      finalForcedMaintenanceMs: maintenance.ms, afterForcedMaintenance: await inspect(mode.history),
      verified: { retainedRevisions: before.revisions.length, files, recentUndo: probes, oldestUndoConflict: true },
    }));
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
