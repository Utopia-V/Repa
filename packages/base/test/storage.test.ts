import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { syncDirectory } from "../src/storage.js";

test("Windows 不打开目录，其他平台照常同步目录", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-storage-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const missing = path.join(directory, "missing");

  await syncDirectory(missing, "win32");
  await assert.rejects(syncDirectory(missing, "linux"), { code: "ENOENT" });
  await assert.rejects(syncDirectory(missing, "darwin"), { code: "ENOENT" });
  await syncDirectory(directory);
});
