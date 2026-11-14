import type { Plugin } from "../plugin.js";
import { errorText, RepaFault } from "../schema.js";
import { readEnablement, type PluginEnablement } from "./enablement.js";
import { loadPlugin, type PluginManifest } from "./manifest.js";
import { checkSnapshot, cleanSnapshots, clearStaging, removeSnapshot, snapshotDirectory } from "./snapshots.js";

/**
 * 启用了却没有交给插件宿主的自写插件。pending：本机没有记录的那个版本的完好快照，要批准以后才能运行；
 * failed：与随包插件同名、核对或删除快照时读写出错、清单不合格、id 与记录不符或导入失败。宿主打开以后才失败的插件不在这里，由宿主停用。
 */
export interface UnavailablePlugin {
  id: string;
  state: "pending" | "failed";
  reason: { code: string; message: string };
}

export interface SpacePlugin {
  id: string;
  digest: string;
  manifest: PluginManifest;
}

/**
 * 打开空间时选出的插件。plugins 交给插件宿主；record 是这一次读到的启用记录，读不了或不合格式时为 undefined，与空记录不同；
 * selfWritten 是交给宿主的自写插件各自的版本与清单；unavailable 是启用了却没有交给宿主的自写插件。
 */
export interface SpacePlugins {
  plugins: Plugin[];
  record: PluginEnablement | undefined;
  selfWritten: SpacePlugin[];
  unavailable: UnavailablePlugin[];
}

/**
 * 打开空间时这个空间要运行的插件：随包插件，加上启用记录里 enabled 的自写插件中快照核对通过、导入成功的那些，
 * 自写插件按记录里的次序排在随包插件之后。
 *
 * 先清掉暂存副本、按记录清理快照，再逐个核对并导入；核对不通过的快照在这里删除，插件列为待批准。
 * 这一切都在插件打开之前，没有实例在用这些快照。出错时只让出错的那一部分不运行，空间照常打开，onError 收到原来的错误：
 * 启用记录读不了或不合格式时，自写插件一个都不运行，也不清理快照，因为无从知道该运行什么、该保留哪些快照；
 * 清理暂存副本或快照出错时，照常按这次读到的记录运行；一个插件的核对、删除快照或加载出错时，只有它列为失败。
 */
export async function spacePlugins(options: {
  home: string;
  space: { root: string; dataDir: string };
  bundled: Plugin[];
  onError?(error: unknown): void;
}): Promise<SpacePlugins> {
  const { home, space, bundled } = options;
  let record: PluginEnablement;
  try {
    record = await readEnablement(space.dataDir);
  } catch (error) {
    options.onError?.(error);
    return { plugins: [...bundled], record: undefined, selfWritten: [], unavailable: [] };
  }
  for (const clean of [() => clearStaging(home, space.root), () => cleanSnapshots(home, space.root, record)]) {
    try {
      await clean();
    } catch (error) {
      options.onError?.(error);
    }
  }
  const bundledIds = new Set(bundled.map((plugin) => plugin.id));
  const loaded: Plugin[] = [];
  const selfWritten: SpacePlugin[] = [];
  const unavailable: UnavailablePlugin[] = [];
  for (const [id, entry] of Object.entries(record.plugins)) {
    if (!entry.enabled) continue;
    if (bundledIds.has(id)) {
      unavailable.push({ id, state: "failed", reason: { code: "plugin_id_conflict", message: `自写插件 ${id} 与随产品附带的插件同名，没有运行` } });
      continue;
    }
    try {
      const status = await checkSnapshot(home, space.root, id, entry.digest);
      if (status === "missing") {
        unavailable.push({ id, state: "pending", reason: { code: "snapshot_missing", message: `本机没有插件 ${id} 这个版本的已批准快照，批准以后才运行` } });
        continue;
      }
      if (status === "modified") {
        await removeSnapshot(home, space.root, id, entry.digest);
        unavailable.push({ id, state: "pending", reason: { code: "snapshot_modified", message: `插件 ${id} 的已批准快照被改动过，已删除，重新批准以后才运行` } });
        continue;
      }
      const { manifest, plugin } = await loadPlugin(snapshotDirectory(home, space.root, id, entry.digest), { snapshotOf: id });
      loaded.push(plugin);
      selfWritten.push({ id, digest: entry.digest, manifest });
    } catch (error) {
      unavailable.push({ id, state: "failed", reason: { code: error instanceof RepaFault ? error.code : "plugin_open_failed", message: errorText(error) } });
      options.onError?.(error);
    }
  }
  return { plugins: [...bundled, ...loaded], record, selfWritten, unavailable };
}
