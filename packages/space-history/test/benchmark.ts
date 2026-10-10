import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { openHistory } from "../src/history.js";

const execute = promisify(execFile);
const smallFiles = Array.from({ length: 1_000 }, (_, i) => `small-${String(i).padStart(4, "0")}.txt`);
const largeFiles = Array.from({ length: 4 }, (_, i) => `large-${i}.bin`);
const smallBytes = 1_024;
const largeBytes = 12 * 1024 * 1024;

function smallContent(index: number, modified: boolean): Buffer {
  const label = `${modified ? "modified" : "original"}-${String(index).padStart(4, "0")}\n`;
  return Buffer.from(label.repeat(Math.ceil(smallBytes / label.length)).slice(0, smallBytes));
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
    temporaryDirectory,
    filesystemType: `0x${filesystem.type.toString(16)}`,
  },
  workload: {
    independentSamples: 3,
    smallFiles: smallFiles.length,
    smallBytes,
    largeFiles: largeFiles.length,
    largeBytes,
    defaultLimitBytes: 10 * 1024 * 1024,
  },
}));

for (let sample = 1; sample <= 3; sample += 1) {
  const space = await mkdtemp(path.join(temporaryDirectory, "repa-space-history-benchmark-"));
  try {
    // 数据准备与校验都在测量区间之外；三个样本各有全新的真实 Git 仓库。
    for (const [index, name] of smallFiles.entries()) {
      await writeFile(path.join(space, name), smallContent(index, false));
    }
    for (const [index, name] of largeFiles.entries()) {
      await writeFile(path.join(space, name), Buffer.alloc(largeBytes, index + 1));
    }

    const initial = await measured(() => openHistory(space));
    const history = initial.value;
    const noop = await measured(() => history.snapshot());
    assert.equal(noop.value.committed, false);
    const expectedSkipped = largeFiles.map((name) => ({ path: name, reason: "large" }));
    assert.deepEqual(noop.value.skipped, expectedSkipped);

    for (const [index, name] of smallFiles.entries()) {
      await writeFile(path.join(space, name), smallContent(index, true));
    }
    const changed = await measured(() => history.snapshot({ kind: "agent", runId: "benchmark" }));
    assert.equal(changed.value.committed, true);
    assert.deepEqual(changed.value.skipped, expectedSkipped);
    const undo = await measured(() => history.undo(changed.value.revision));
    assert.deepEqual(undo.value.conflicts, []);
    assert.deepEqual([...undo.value.restored].sort(), [...smallFiles].sort());

    // 包括首尾文件在内，逐一确认全部一千个文件恢复到原始字节。
    for (const [index, name] of smallFiles.entries()) {
      assert.deepEqual(await readFile(path.join(space, name)), smallContent(index, false));
    }
    for (const [index, name] of largeFiles.entries()) {
      assert.deepEqual(await readFile(path.join(space, name)), Buffer.alloc(largeBytes, index + 1));
    }
    console.log(JSON.stringify({
      sample,
      space,
      initialOpenMs: initial.ms,
      noopSnapshotMs: noop.ms,
      modifiedSnapshotMs: changed.ms,
      undoIncludingSnapshotsMs: undo.ms,
      verified: { restored: undo.value.restored.length, skipped: changed.value.skipped.length },
    }));
  } finally {
    await rm(space, { recursive: true, force: true });
  }
}
