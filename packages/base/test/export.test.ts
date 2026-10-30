import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import type { Host, Plugin } from "@repa/base/plugin";
import { createPluginTestHost } from "@repa/base/testing";

const fault = (code: string) => (error: unknown): boolean => error instanceof Error && "code" in error && error.code === code;

test("插件只能导出自己数据目录下的顶层普通文件：多级路径、越出数据目录的路径和符号链接都拒绝，还没建立的文件按空文件收入；离线宿主写到临时的 home/exports/", async (t) => {
  let host: Host | undefined;
  const plugin: Plugin = {
    id: "notes",
    async open(opened) {
      host = opened;
      return {};
    },
  };
  const testing = await createPluginTestHost({ plugins: [plugin] });
  t.after(() => testing.close());
  assert.ok(host);
  const opened = host;
  const dataDir = opened.space.dataDir;
  await writeFile(path.join(dataDir, "log.jsonl"), '{"n":1}\n{"n":');
  await mkdir(path.join(dataDir, "sub"));
  await writeFile(path.join(dataDir, "sub", "inner.jsonl"), '{"n":2}\n');
  await mkdir(path.join(opened.space.root, "notes"), { recursive: true });
  await writeFile(path.join(opened.space.root, "notes", "a.md"), "空间里的笔记\n");
  const rejected = async (file: string) => {
    await assert.rejects(opened.prepareExport({ files: [{ name: "x.txt", file }], sessions: false }), fault("invalid_path"), file);
  };
  // 数据目录里的子目录同样不收：中间一级可能是指向别处的链接，只查最后一级挡不住它。
  for (const file of ["sub/inner.jsonl", "../../../notes/a.md", "..", ""]) await rejected(file);
  if (process.platform !== "win32") {
    await symlink(path.join(opened.space.root, "notes"), path.join(dataDir, "linked"));
    await symlink(path.join(opened.space.root, "notes", "a.md"), path.join(dataDir, "link.md"));
    for (const file of ["linked/a.md", "link.md"]) await rejected(file);
  }

  const prepared = await opened.prepareExport({
    files: [
      { name: "log.jsonl", file: "log.jsonl" },
      { name: "later.jsonl", file: "later.jsonl" },
      { name: "about.txt", text: "说明\n" },
    ],
    sessions: false,
  });
  assert.deepEqual(prepared.files.map(({ name, bytes, records }) => ({ name, bytes, records })), [
    { name: "log.jsonl", bytes: Buffer.byteLength('{"n":1}\n'), records: 1 },
    { name: "later.jsonl", bytes: 0, records: 0 },
    { name: "about.txt", bytes: Buffer.byteLength("说明\n"), records: undefined },
    { name: "manifest.json", bytes: prepared.files.at(-1)?.bytes, records: undefined },
  ]);
  const written = await prepared.write();
  assert.equal(path.dirname(written), path.join(testing.directory, "home", "exports"));
  assert.ok((await readFile(written)).length > 0);
  await assert.rejects(prepared.write("exports"), fault("invalid_path"));
});
