import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { openHistory, type SpaceHistory } from "../src/history.js";
import type { ActivitySource } from "../src/schema.js";

const execute = promisify(execFile);
const sizes = [64, 1_000, 10_000];
const fileBytes = 1_024;
const scopedWrites = 200;
const externalWrites = 50;
const wholeWrites = 20;

function content(index: number, version: number): Buffer {
  const label = `file-${String(index).padStart(5, "0")} version-${version}\n`;
  return Buffer.from(label.repeat(Math.ceil(fileBytes / label.length)).slice(0, fileBytes));
}

function name(index: number): string {
  // 每个目录放 100 个文件，接近按主题分目录的空间。
  return `topic-${String(Math.floor(index / 100)).padStart(3, "0")}/note-${String(index).padStart(5, "0")}.md`;
}

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (ratio: number) => sorted[Math.min(sorted.length - 1, Math.floor(ratio * sorted.length))] ?? Number.NaN;
  return { count: sorted.length, median: at(0.5), p90: at(0.9), min: sorted[0], max: sorted.at(-1) };
}

async function measured<T>(operation: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await operation();
  return { value, ms: performance.now() - start };
}

const temporaryDirectory = await realpath(os.tmpdir());
const filesystem = await statfs(temporaryDirectory);
const { stdout: gitVersion } = await execute("git", ["--version"]);
console.log(JSON.stringify({
  environment: {
    node: process.version,
    git: gitVersion.trim(),
    platform: `${process.platform}/${process.arch}`,
    cpus: os.cpus().length,
    temporaryDirectory,
    filesystemType: `0x${filesystem.type.toString(16)}`,
  },
  workload: { sizes, fileBytes, scopedWrites, externalWrites, wholeWrites },
}));

for (const size of sizes) {
  const space = await mkdtemp(path.join(temporaryDirectory, "repa-record-paths-benchmark-"));
  try {
    // 数据准备与校验在测量区间之外；每种规模使用全新的空间和真实 Git 仓库。
    for (let index = 0; index < size; index += 1) {
      await mkdir(path.dirname(path.join(space, name(index))), { recursive: true });
      await writeFile(path.join(space, name(index)), content(index, 0));
    }
    const opened = await measured(() => openHistory(space));
    const history = opened.value;
    const lead: ActivitySource = { kind: "agent", runId: "lead" };
    const detail: ActivitySource = { kind: "agent", runId: "detail", ancestorRunIds: ["helper", "lead"] };
    const runs: ActivitySource[] = [lead, { kind: "agent", runId: "helper", ancestorRunIds: ["lead"] }, detail];
    const pick = (step: number) => Math.floor((step * 7919) % size);
    // 计时包括写入动作本身，也就是队列被占住的全部时间。
    const write = (target: SpaceHistory, source: ActivitySource, index: number, version: number) =>
      measured(() => target.recordPaths(source, [name(index)], () => writeFile(path.join(space, name(index)), content(index, version))));

    // 第一次调用还要从提交记录建立运行索引。
    const cold = await write(history, lead, 0, 1);
    assert.equal(cold.value.snapshot.committed, true);

    const scoped: number[] = [];
    for (let step = 1; step <= scopedWrites; step += 1) {
      const index = pick(step);
      const result = await write(history, runs[step % runs.length] ?? lead, index, step + 1);
      assert.equal(result.value.snapshot.committed, true);
      scoped.push(result.ms);
    }

    // 写入前同一路径有未记录的外部改动：先提交 external，再提交运行写入。
    const withExternal: number[] = [];
    for (let step = 1; step <= externalWrites; step += 1) {
      const index = pick(scopedWrites + step);
      await writeFile(path.join(space, name(index)), content(index, 100_000 + step));
      const result = await write(history, lead, index, 200_000 + step);
      assert.equal(result.value.snapshot.committed, true);
      withExternal.push(result.ms);
    }

    // 对照：同样只改一个文件，但用 record 在动作前后各扫描整个空间。
    const whole: number[] = [];
    for (let step = 1; step <= wholeWrites; step += 1) {
      const index = pick(scopedWrites + externalWrites + step);
      const result = await measured(() => history.record({ kind: "agent", runId: `whole-${step}` }, () =>
        writeFile(path.join(space, name(index)), content(index, 300_000 + step))));
      assert.equal(result.value.snapshot.committed, true);
      whole.push(result.ms);
    }

    // 监听报告了一个外部改动的路径：按路径快照只记这个路径。对照为没有变化的整空间扫描。
    const externalPath: number[] = [];
    for (let step = 1; step <= externalWrites; step += 1) {
      const index = pick(scopedWrites + externalWrites + wholeWrites + step);
      await writeFile(path.join(space, name(index)), content(index, 500_000 + step));
      const result = await measured(() => history.snapshotPaths([name(index)]));
      assert.equal(result.value.committed, true);
      externalPath.push(result.ms);
    }
    const wholeSnapshot: number[] = [];
    for (let step = 1; step <= wholeWrites; step += 1) {
      const result = await measured(() => history.snapshot());
      assert.equal(result.value.committed, false);
      wholeSnapshot.push(result.ms);
    }

    const commits = (await history.list(100_000)).length;
    const reopened = await openHistory(space);
    const coldAfterHistory = await write(reopened, detail, 1, 400_000);
    const undo = await measured(() => reopened.undoRun("helper"));
    assert.equal((await reopened.snapshot()).committed, false);

    // 校验：每条按路径提交只含一个文件，且来源与写入者一致；撤回后磁盘与历史一致。
    const feed = await reopened.changesSince(null);
    const agentCommits = feed.revisions.filter(({ source }) => source.kind === "agent" && !source.runId.startsWith("whole-"));
    assert.ok(agentCommits.every(({ changes }) => changes.length === 1));
    console.log(JSON.stringify({
      files: size,
      initialOpenMs: opened.ms,
      firstScopedWriteMs: cold.ms,
      scopedWriteMs: stats(scoped),
      scopedWriteWithExternalMs: stats(withExternal),
      wholeSpaceRecordMs: stats(whole),
      externalPathSnapshotMs: stats(externalPath),
      wholeSnapshotWithoutChangesMs: stats(wholeSnapshot),
      commitsBeforeReopen: commits,
      firstScopedWriteAfterReopenMs: coldAfterHistory.ms,
      undoRunMs: undo.ms,
      undoRun: { restored: undo.value.restored.length, conflicts: undo.value.conflicts.length },
    }));
  } finally {
    await rm(space, { recursive: true, force: true });
  }
}
