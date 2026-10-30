import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import type { Host, Plugin } from "@repa/base/plugin";
import { createPluginTestHost } from "@repa/base/testing";

const fault = (code: string) => (error: unknown): boolean => error instanceof Error && "code" in error && error.code === code;

test("插件只能导出自己数据目录中的普通文件：越出数据目录或是符号链接时拒绝，还没建立的文件按空文件收入；离线宿主写到临时的 home/exports/", async (t) => {
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
  const dataDir = host.space.dataDir;
  await writeFile(path.join(dataDir, "log.jsonl"), '{"n":1}\n{"n":');
  await mkdir(path.join(host.space.root, "notes"), { recursive: true });
  await writeFile(path.join(host.space.root, "notes", "a.md"), "空间里的笔记\n");
  await assert.rejects(host.prepareExport({ files: [{ name: "a.md", file: "../../../notes/a.md" }], sessions: false }), fault("invalid_path"));
  if (process.platform !== "win32") {
    await symlink(path.join(host.space.root, "notes", "a.md"), path.join(dataDir, "link.md"));
    await assert.rejects(host.prepareExport({ files: [{ name: "link.md", file: "link.md" }], sessions: false }), fault("invalid_path"));
  }

  const prepared = await host.prepareExport({
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
