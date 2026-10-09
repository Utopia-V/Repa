import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { object } from "../../src/schema.js";
import type { BackendPlugin, CapabilityDefinition, InvocationContext, PluginSpaceContext } from "repa/plugin";
import type { SpaceSnapshotParticipant } from "../../src/spaces/schema.js";

const InputSchema = object({ value: Type.String() });
const OutputSchema = object({ count: Type.Integer({ minimum: 0 }), spaceId: Type.String() });

export interface SqliteRuntime {
  database: DatabaseSync;
}

/** 快照只打开本次源数据库，不依赖启用插件或空间运行资源。 */
export function sqliteSnapshot(id: string): SpaceSnapshotParticipant {
  return {
    id,
    version: "1",
    directory: `.repa/plugins/${id}`,
    async capture({ sourceDirectory, destinationDirectory, sourceSpaceId, targetSpaceId }) {
      const database = new DatabaseSync(path.join(sourceDirectory, "entries.sqlite"), { readOnly: true });
      try {
        database.prepare("VACUUM INTO ?").run(path.join(destinationDirectory, "entries.sqlite"));
      } finally {
        database.close();
      }
      const copied = new DatabaseSync(path.join(destinationDirectory, "entries.sqlite"));
      try {
        copied.prepare("UPDATE entries SET space = ? WHERE space = ?").run(targetSpaceId, sourceSpaceId);
      } finally {
        copied.close();
      }
    },
  };
}

/** 使用 Node 24 SQLite 的业务插件样本；表结构、迁移和快照均由插件解释。 */
export function sqlitePlugin(options: {
  id: string;
  beforeOpen?(context: PluginSpaceContext): Promise<void>;
  opened?(context: PluginSpaceContext): void;
  closed?(context: PluginSpaceContext): void;
}) {
  const append = {
    contract: { id: "example.entries.append", version: "1" },
    implementationId: "sqlite",
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    scopes: ["space"],
    execution: "background",
    tool: { name: "append_entry", description: "在所属空间保存一个测试条目。" },
    invoke(input: unknown, context: Pick<InvocationContext, "scope" | "signal" | "spaceRuntime">) {
      context.signal.throwIfAborted();
      if (!Check(InputSchema, input)) throw new Error("条目输入无效");
      const runtime = context.spaceRuntime;
      if (context.scope.kind !== "space" || !runtime || typeof runtime !== "object" ||
        !("database" in runtime) || !(runtime.database instanceof DatabaseSync)) throw new Error("缺少空间运行资源");
      const database = runtime.database;
      database.prepare("INSERT INTO entries(space, value) VALUES (?, ?)").run(context.scope.spaceId, input.value);
      const row = database.prepare("SELECT count(*) AS count FROM entries").get();
      if (typeof row?.count !== "number") throw new Error("无法读取条目数量");
      return { count: row.count, spaceId: context.scope.spaceId };
    },
  } satisfies CapabilityDefinition<typeof InputSchema, typeof OutputSchema, object, SqliteRuntime>;
  return {
    capabilities: [append],
    settings: [{
      namespace: "example.entries",
      settings: { enabled: { schema: Type.Boolean(), default: true, scopes: ["space"] } },
    }],
    async openSpace(context) {
      await options.beforeOpen?.(context);
      context.signal.throwIfAborted();
      const database = new DatabaseSync(path.join(context.dataDirectory, "entries.sqlite"));
      try {
        database.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS entries(space TEXT NOT NULL, value TEXT NOT NULL); PRAGMA user_version=1;");
        const runtime = { database };
        options.opened?.(context);
        return runtime;
      } catch (error) {
        database.close();
        throw error;
      }
    },
    closeSpace(runtime, context) {
      runtime.database.close();
      options.closed?.(context);
    },
    snapshot: sqliteSnapshot(options.id),
  } satisfies BackendPlugin<object, SqliteRuntime>;
}
