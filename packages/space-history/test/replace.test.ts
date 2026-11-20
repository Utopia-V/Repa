import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { replace } from "../src/replace.js";
import { openHistory } from "../src/index.js";

const busy = (code: string) => Object.assign(new Error(code), { code });

test("Windows 上改名被占用时按间隔重试，其他平台与其他错误码不重试", async () => {
  const waits: number[] = [];
  let calls = 0;
  await replace("from", "to", "win32", {
    async rename() {
      calls++;
      if (calls <= 2) throw busy(calls === 1 ? "EPERM" : "EBUSY");
    },
    async wait(ms) { waits.push(ms); },
  });
  assert.deepEqual(waits, [10, 20]);
  const failing = { async rename() { throw busy("EPERM"); }, async wait() { /* 不应等待 */ } };
  await assert.rejects(replace("from", "to", "linux", failing), { code: "EPERM" });
  await assert.rejects(replace("from", "to", "win32", { ...failing, async rename() { throw busy("ENOENT"); } }), { code: "ENOENT" });
});

test("Windows 上撤回写回的文件正被打开时，句柄关掉以后撤回完成，内容是原来的", { skip: process.platform !== "win32" && "只在 Windows 上有这种文件共享语义" }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-space-history-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const space = path.join(root, "space");
  const file = path.join(space, "notes.txt");
  await mkdir(space);
  await writeFile(file, "原来的\n");
  const history = await openHistory(space);
  const run = await history.record({ kind: "agent", runId: "held" }, async () => {
    await writeFile(file, "运行写的\n");
  });
  // 像编辑器那样持住文件；等写回的临时文件出现、改名已经碰上打开的句柄以后才关掉。
  const holder = await open(file, "r");
  t.after(() => holder.close().catch(() => undefined));
  const undoing = history.undo(run.snapshot.revision);
  while (!(await readdir(space)).some((name) => name.startsWith(".repa-undo-"))) await sleep(5);
  await sleep(50);
  await holder.close();
  const undone = await undoing;
  assert.deepEqual(undone.restored, ["notes.txt"]);
  assert.equal(await readFile(file, "utf8"), "原来的\n");
});
