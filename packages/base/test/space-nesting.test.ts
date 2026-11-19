import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { RepaFault } from "../src/schema.js";
import { NESTING_SCAN_LIMIT } from "../src/space/nesting.js";
import { createSpace, openSpace } from "../src/space.js";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-nesting-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

/** 被拒绝的错误：码、指出的文件夹。 */
function refused(code: string, folder?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof RepaFault, String(error));
    assert.equal(error.code, code);
    if (folder !== undefined) assert.equal((error.details as { path: string }).path, folder);
    return true;
  };
}

test("在空间里面建空间被拒绝，指出外层的空间；被拒绝时不留下文件夹，也不写 .repa", async (t) => {
  const base = await fixture(t);
  const outer = path.join(base, "Repa");
  await (await createSpace(outer, { watch: false })).close();
  const inner = path.join(outer, "courses", "操作系统");
  await assert.rejects(createSpace(inner, { watch: false }), refused("nested_space", outer));
  assert.equal(await exists(path.join(outer, "courses")), false);
  // 已有的普通文件夹直接打开也一样。
  await mkdir(inner, { recursive: true });
  await assert.rejects(openSpace(inner, { watch: false }), refused("nested_space", outer));
  assert.equal(await exists(path.join(inner, ".repa")), false);
});

test("在已有空间外面建空间被拒绝，指出里面的空间；打开一个里面藏着空间的普通文件夹同样被拒绝", async (t) => {
  const base = await fixture(t);
  const inner = path.join(base, "Repa", "旧的课", "深处");
  await (await createSpace(inner, { watch: false })).close();
  await assert.rejects(createSpace(path.join(base, "Repa"), { watch: false }), refused("nested_space", inner));
  await assert.rejects(openSpace(base, { watch: false }), refused("nested_space", inner));
  assert.equal(await exists(path.join(base, ".repa")), false);
  assert.equal(await exists(path.join(base, "Repa", ".repa")), false);
});

test("已经是空间的文件夹再打开只查祖先：它下面先前就有的空间不挡住它", async (t) => {
  const base = await fixture(t);
  const outer = path.join(base, "外层");
  await (await createSpace(outer, { watch: false })).close();
  // 本检查之前形成的嵌套：把一个空间搬进去。
  const elsewhere = path.join(base, "别处");
  await (await createSpace(elsewhere, { watch: false })).close();
  await rename(elsewhere, path.join(outer, "搬进来的"));
  const reopened = await openSpace(outer, { watch: false });
  await reopened.close();
});

test(`向下查超过 ${NESTING_SCAN_LIMIT} 个文件夹时拒绝，说明没有查完`, async (t) => {
  const base = await fixture(t);
  const target = path.join(base, "很多文件夹");
  for (let index = 0; index < NESTING_SCAN_LIMIT; index++) await mkdir(path.join(target, String(index)), { recursive: true });
  await assert.rejects(openSpace(target, { watch: false }), refused("nesting_unchecked", target));
  assert.equal(await exists(path.join(target, ".repa")), false);
});
