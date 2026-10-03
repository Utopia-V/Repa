import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SpaceSnapshotParticipant } from "repa/plugin";
import { RepaFault } from "repa/protocol";

/** 禁用后的快照只解释数据库版本，不导入 FSRS 或建立业务运行实例。 */
export default function snapshot(pluginId: string): SpaceSnapshotParticipant {
  return {
    id: pluginId, version: "1", directory: `.repa/plugins/${pluginId}`,
    async capture({ sourceDirectory, destinationDirectory }) {
      const database = new DatabaseSync(path.join(sourceDirectory, "reviews.sqlite"), { readOnly: true });
      try {
        if (database.prepare("PRAGMA user_version").get()?.user_version !== 1)
          throw new RepaFault("review_storage_version", "复习数据库版本不受当前快照入口支持。");
        // 内容引用按空间内身份保存；整个空间复制无需改写业务行或实际反馈。
        database.prepare("VACUUM INTO ?").run(path.join(destinationDirectory, "reviews.sqlite"));
      } finally { database.close(); }
    },
  };
}
