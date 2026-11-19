import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import type { Plugin } from "@repa/base/plugin";
import { createPluginTestHost } from "@repa/base/testing";
import { groupDirectory, readGroup } from "../src/backup/store.js";

test("插件在 open 里经 Host.backup 等一次备份成功：返回时备份里已有此刻的数据目录；没有变化时不再复制", async (t) => {
  let seen: string | undefined;
  const plugin: Plugin = {
    id: "notes",
    async open(host) {
      await writeFile(path.join(host.space.dataDir, "log.jsonl"), "{\"n\":1}\n");
      await host.backup();
      await host.backup();
      const [latest] = await readGroup(groupDirectory(path.join(path.dirname(host.space.root), "home"), host.space.root));
      assert.ok(latest);
      seen = await readFile(path.join(latest.directory, "data", "plugins", "notes", "log.jsonl"), "utf8");
      return {};
    },
  };
  const testing = await createPluginTestHost({ plugins: [plugin] });
  t.after(() => testing.close());
  assert.deepEqual(testing.host.disabled(), []);
  assert.equal(seen, "{\"n\":1}\n");
  assert.equal((await readGroup(groupDirectory(path.join(testing.directory, "home"), testing.space.root))).length, 1);
});
