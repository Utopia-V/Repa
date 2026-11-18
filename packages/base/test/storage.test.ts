import assert from "node:assert/strict";
import { mkdtemp, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { move, MOVE_DELAYS, syncDirectory, type MoveIo } from "../src/storage.js";

const sharing = () => Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });

/** 按给定的结果依次改名：Error 就抛出，undefined 就成功；记下改名次数与等待的间隔，不碰文件、不按时间等。 */
function scripted(outcomes: (Error | undefined)[]): MoveIo & { renames: number; waits: number[] } {
  const io = {
    renames: 0,
    waits: [] as number[],
    async rename() {
      const outcome = outcomes[Math.min(io.renames++, outcomes.length - 1)];
      if (outcome) throw outcome;
    },
    async wait(ms: number) {
      io.waits.push(ms);
    },
  };
  return io;
}

test("Windows 不打开目录，其他平台照常同步目录", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-storage-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const missing = path.join(directory, "missing");

  await syncDirectory(missing, "win32");
  await assert.rejects(syncDirectory(missing, "linux"), { code: "ENOENT" });
  await assert.rejects(syncDirectory(missing, "darwin"), { code: "ENOENT" });
  await syncDirectory(directory);
});

test("Windows 上改名遇到 EPERM、EACCES、EBUSY 时按间隔重试：前两次被占用，第三次成功", async () => {
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    const io = scripted([Object.assign(new Error(code), { code }), Object.assign(new Error(code), { code }), undefined]);
    await move("a", "b", "win32", io);
    assert.equal(io.renames, 3);
    assert.deepEqual(io.waits, MOVE_DELAYS.slice(0, 2));
  }
});

test("Windows 上一直被占用：等完全部间隔后抛出原来的错误", async () => {
  const errors = MOVE_DELAYS.map(sharing).concat(sharing());
  const io = scripted(errors);
  await assert.rejects(move("a", "b", "win32", io), (error) => error === errors.at(-1));
  assert.equal(io.renames, MOVE_DELAYS.length + 1);
  assert.deepEqual(io.waits, MOVE_DELAYS);
});

test("其他平台不重试；Windows 上其他错误码也不重试", async () => {
  for (const platform of ["linux", "darwin"] as const) {
    const failure = sharing();
    const io = scripted([failure, undefined]);
    await assert.rejects(move("a", "b", platform, io), (error) => error === failure);
    assert.deepEqual([io.renames, io.waits], [1, []]);
  }
  const missing = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const io = scripted([missing, undefined]);
  await assert.rejects(move("a", "b", "win32", io), (error) => error === missing);
  assert.deepEqual([io.renames, io.waits], [1, []]);
});

test("Windows 上目标被另一个句柄打开时改名失败，句柄关掉以后重试成功，内容是新的", { skip: process.platform !== "win32" && "只在 Windows 上有这种文件共享语义" }, async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-storage-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "building.json");
  const temporary = path.join(directory, "building.json.tmp");
  await writeFile(target, "旧\n");
  await writeFile(temporary, "新\n");
  // 像备份复制文件那样持住目标；第一次等待时才关掉，所以第一次改名一定碰上打开的句柄。
  const holder = await open(target, "r");
  t.after(() => holder.close().catch(() => undefined));
  const failures: unknown[] = [];
  await move(temporary, target, "win32", {
    async rename(from, to) {
      try {
        await rename(from, to);
      } catch (error) {
        failures.push(error);
        throw error;
      }
    },
    async wait() {
      await holder.close();
    },
  });
  assert.deepEqual(failures.map((error) => (error as NodeJS.ErrnoException).code), ["EPERM"]);
  assert.equal(await readFile(target, "utf8"), "新\n");
});
