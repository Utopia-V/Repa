import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/build-sandbox.mjs", import.meta.url));

test("沙箱构建入口显示固定平台与参数帮助，不启动构建", () => {
  const result = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--cache-dir PATH/);
  assert.match(result.stdout, /Linux x64/);
  assert.equal(result.stderr, "");
});

test("沙箱构建入口在产生副作用前拒绝未知参数和无效并行数", () => {
  for (const args of [["--unknown", "value"], ["--jobs", "0"], ["--jobs"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /无效参数|正整数/);
    assert.equal(result.stdout, "");
  }
});

test("固定沙箱构建锁与来源元信息的摘要相符", async () => {
  const metadata: unknown = JSON.parse(await readFile(new URL("../resources/sandbox/source.json", import.meta.url), "utf8"));
  assert(metadata !== null && typeof metadata === "object" && "buildCargoLockSha256" in metadata);
  const lock = await readFile(new URL("../resources/sandbox/Cargo.lock", import.meta.url));
  assert.equal(createHash("sha256").update(lock).digest("hex"), metadata.buildCargoLockSha256);
  assert("bubblewrap" in metadata && metadata.bubblewrap !== null && typeof metadata.bubblewrap === "object");
  assert("patch" in metadata.bubblewrap && typeof metadata.bubblewrap.patch === "string");
  assert("patchSha256" in metadata.bubblewrap);
  const patch = await readFile(new URL(`../resources/sandbox/${metadata.bubblewrap.patch}`, import.meta.url));
  assert.equal(createHash("sha256").update(patch).digest("hex"), metadata.bubblewrap.patchSha256);
});
