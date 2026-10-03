import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { CapabilityHost } from "../src/capabilities/host.js";
import type { BackendPlugin, CapabilityDefinition } from "../src/capabilities/types.js";
import { ContentStore } from "../src/content/store.js";
import { object } from "../src/schema.js";

const InputSchema = object({ value: Type.String() });
const OutputSchema = object({
  version: Type.Integer(),
  entries: Type.Array(object({ id: Type.Integer(), value: Type.String(), normalizedValue: Type.String() })),
});
const contract = { id: "example.migrated-entries.append", version: "1" };

/** 该测试插件拥有 v1→v2 事务与失败清理，宿主不解释数据库版本。 */
function migratingPlugin(indexColumn: string, handles: DatabaseSync[]): BackendPlugin<object, DatabaseSync> {
  const append: CapabilityDefinition<typeof InputSchema, typeof OutputSchema, object, DatabaseSync> = {
    contract, implementationId: "sqlite", inputSchema: InputSchema, outputSchema: OutputSchema,
    scopes: ["space"], execution: "inline",
    invoke(input, context) {
      const database = context.spaceRuntime;
      assert(database);
      database.prepare("INSERT INTO entries(value, normalized_value) VALUES (?, trim(?))").run(input.value, input.value);
      const result = {
        version: database.prepare("PRAGMA user_version").get()?.user_version,
        entries: database.prepare("SELECT id, value, normalized_value AS normalizedValue FROM entries ORDER BY id").all().map(row => ({ ...row })),
      };
      if (!Check(OutputSchema, result)) throw new Error("数据库结果不符合插件格式");
      return result;
    },
  };
  return {
    capabilities: [append],
    openSpace(context) {
      const database = new DatabaseSync(path.join(context.dataDirectory, "entries.sqlite"));
      handles.push(database);
      try {
        const version = database.prepare("PRAGMA user_version").get()?.user_version;
        if (version === 1) {
          database.exec("BEGIN IMMEDIATE");
          try {
            database.exec("ALTER TABLE entries ADD COLUMN normalized_value TEXT NOT NULL DEFAULT ''");
            database.exec("UPDATE entries SET normalized_value = trim(value)");
            database.exec("PRAGMA user_version=2");
            // 模拟正常升级中遗漏的旧列名；修复后仍走同一真实 SQLite 迁移事务。
            database.exec(`CREATE INDEX entries_normalized ON entries(${indexColumn})`);
            database.exec("COMMIT");
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        } else if (version !== 2) throw new Error("插件不支持此数据库版本");
        return database;
      } catch (error) {
        database.close();
        throw error;
      }
    },
    closeSpace(database) { database.close(); },
  };
}

test("真实数据库升级事务失败保留旧数据和版本，修正迁移后明确重开升级并接续", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-plugin-migration-"));
  const hosts: CapabilityHost[] = [];
  const handles: DatabaseSync[] = [];
  const content = await ContentStore.open({ root, spaceId: "space", assertOwned() {} });
  t.after(async () => {
    await Promise.all(hosts.map(host => host.close()));
    await content.settled();
    await rm(root, { recursive: true, force: true });
  });
  const directory = path.join(root, ".repa/plugins/entries");
  const file = path.join(directory, "entries.sqlite");
  await mkdir(directory, { recursive: true });
  // 原始 v1 格式独立建库，不借用新版插件初始化路径。
  const legacy = new DatabaseSync(file);
  try {
    legacy.exec("PRAGMA journal_mode=WAL; CREATE TABLE entries(id INTEGER PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version=1;");
    legacy.prepare("INSERT INTO entries(value) VALUES (?)").run(" 原有条目 ");
  } finally { legacy.close(); }
  const context = {
    scope: { kind: "space" as const, spaceId: "space" },
    source: { kind: "client" as const, hostId: "frontend" }, content, signal: new AbortController().signal,
  };
  const failing = new CapabilityHost();
  hosts.push(failing);
  await failing.register({ id: "entries", enabled: true, factory: () => migratingPlugin("legacy_value", handles) });
  await assert.rejects(failing.invoke({ contract }, { value: "失败时不能写入" }, context), { code: "ERR_SQLITE_ERROR" });
  assert.equal(handles.length, 1);
  assert.equal(handles[0]?.isOpen, false);
  const afterFailure = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(afterFailure.prepare("PRAGMA user_version").get()?.user_version, 1);
    assert.deepEqual(afterFailure.prepare("PRAGMA table_info(entries)").all().map(row => row.name), ["id", "value"]);
    assert.deepEqual(afterFailure.prepare("SELECT * FROM entries").all().map(row => ({ ...row })), [{ id: 1, value: " 原有条目 " }]);
  } finally { afterFailure.close(); }
  await failing.close();

  // 修复包代码后重新建立宿主，按普通调用明确重试，不由核心自动迁移或重放失败输入。
  const repaired = new CapabilityHost();
  hosts.push(repaired);
  await repaired.register({ id: "entries", enabled: true, factory: () => migratingPlugin("normalized_value", handles) });
  const result = await repaired.invoke({ contract }, { value: " 新增条目 " }, context);
  const firstRows = [
    { id: 1, value: " 原有条目 ", normalizedValue: "原有条目" },
    { id: 2, value: " 新增条目 ", normalizedValue: "新增条目" },
  ];
  assert.deepEqual(result, { version: 2, entries: firstRows });
  await repaired.closeSpace("space");
  assert.equal(handles[1]?.isOpen, false);
  assert.deepEqual(await repaired.invoke({ contract }, { value: "再次接续" }, context), {
    version: 2, entries: [...firstRows, { id: 3, value: "再次接续", normalizedValue: "再次接续" }],
  });
  await repaired.close();
  assert.equal(handles.length, 3);
  assert(handles.every(database => !database.isOpen));
  const afterUpgrade = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(afterUpgrade.prepare("PRAGMA user_version").get()?.user_version, 2);
    assert.deepEqual(afterUpgrade.prepare("PRAGMA index_list(entries)").all().map(row => row.name), ["entries_normalized"]);
    assert.equal(afterUpgrade.prepare("SELECT count(*) AS count FROM entries").get()?.count, 3);
  } finally { afterUpgrade.close(); }
});
