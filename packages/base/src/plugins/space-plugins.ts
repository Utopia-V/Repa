import type { Plugin } from "../plugin.js";
import { errorText, RepaFault } from "../schema.js";
import { readEnablement, type PluginEnablement, type PluginEnablementEntry } from "./enablement.js";
import { loadPlugin, type PluginManifest } from "./manifest.js";
import { checkSnapshot, cleanSnapshots, clearStaging, removeSnapshot, snapshotDirectory } from "./snapshots.js";

/**
 * 启用了却没有交给插件宿主的自写插件。pending：本机没有记录的那个版本的完好快照，要批准以后才能运行；
 * failed：快照在，但读不了、导入失败，或与随包插件同名。宿主打开以后才失败的插件不在这里，由宿主停用。
 */
export interface UnavailablePlugin {
  id: string;
  state: "pending" | "failed";
  reason: { code: string; message: string };
}

/** 交给插件宿主的一个自写插件：它的版本与快照里的清单。 */
export interface SpacePlugin {
  id: string;
  digest: string;
  manifest: PluginManifest;
}

/**
 * 交给插件宿主的插件，以及没有交给它的自写插件；selfWritten 是交给宿主的自写插件各自的版本；
 * record 是这一次实际读到的启用记录，读不了时为 undefined，装卸请求按它结算 recorded；
 * problems 是与单个插件无关、或需要另记一笔的错误。
 */
export interface SpacePlugins {
  plugins: Plugin[];
  record: PluginEnablement | undefined;
  selfWritten: SpacePlugin[];
  unavailable: UnavailablePlugin[];
  problems: unknown[];
}

function failure(id: string, error: unknown): UnavailablePlugin {
  return {
    id,
    state: "failed",
    reason: {
      code: error instanceof RepaFault ? error.code : "plugin_open_failed",
      message: errorText(error),
    },
  };
}

/**
 * 每次装配（打开空间与每次重组）时这个空间要运行的插件：随包插件，加上启用记录里 enabled 的自写插件中快照核对通过、导入成功的那些，
 * 自写插件按 id 排在随包插件之后。
 *
 * 每次都从盘上的启用记录出发：运行的集合是这份记录经核对、导入以后的结果，没能运行的带着待批准或失败的状态。先清掉暂存副本、按记录清理快照，
 * 再逐个核对并导入；核对不通过的快照在这里删除，插件列为待批准。不运行的保留版本（previous、卸载的插件的版本）
 * 也核对，被改动的同样删除：否则它永远不会再被核对，以后批准同一内容时发布一直被拒绝。
 * 这一切都在插件打开之前；重组时旧实例都已关闭，没有实例在用这些快照，除非某个实例的 close() 报了错，那时由调用方传 clean: false。
 * 记录读不了时不运行任何自写插件，也不清理，只报告错误：空间照常打开。
 *
 * clean 为 false 时什么都不删：不清暂存、不按记录清理、不删改动过的快照。重组时上一批实例的 close() 报了错，
 * 它们可能仍在用这些文件，这一次就不清理；改动过的快照照样不加载，插件列为待批准，留到下一次清理时删除。
 * staging 决定是否清掉暂存副本，省略时随 clean：重组时传 false，下一批装卸可能正拿着暂存副本等批准，暂存只在打开空间时清。
 */
export async function spacePlugins(options: { home: string; space: { root: string; dataDir: string }; bundled: Plugin[]; clean?: boolean; staging?: boolean }): Promise<SpacePlugins> {
  const { home, space, bundled } = options;
  const clean = options.clean ?? true;
  const staging = clean && (options.staging ?? true);
  const problems: unknown[] = [];
  let record;
  try {
    record = await readEnablement(space.dataDir);
  } catch (error) {
    return { plugins: bundled, record: undefined, selfWritten: [], unavailable: [], problems: [error] };
  }
  if (clean) {
    try {
      if (staging) await clearStaging(home, space.root);
      await cleanSnapshots(home, space.root, record);
    } catch (error) {
      // 清理失败只影响占用的磁盘，下次打开空间再清。
      problems.push(error);
    }
  }
  const bundledIds = new Set(bundled.map((plugin) => plugin.id));
  const loaded: Plugin[] = [];
  const selfWritten: SpacePlugin[] = [];
  const unavailable: UnavailablePlugin[] = [];
  const ids = Object.keys(record.plugins).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  for (const id of ids) {
    const entry = record.plugins[id];
    if (entry === undefined || !entry.enabled) continue;
    if (bundledIds.has(id)) {
      unavailable.push(failure(id, new RepaFault("plugin_id_conflict", `自写插件 ${id} 与随产品附带的插件同名，没有运行`, { id })));
      continue;
    }
    try {
      const directory = snapshotDirectory(home, space.root, id, entry.digest);
      const status = await checkSnapshot(home, space.root, id, entry.digest);
      if (status === "missing") {
        unavailable.push({ id, state: "pending", reason: { code: "snapshot_missing", message: `本机没有插件 ${id} 这个版本的已批准快照，批准以后才运行` } });
        continue;
      }
      if (status === "modified") {
        if (clean) await removeSnapshot(home, space.root, id, entry.digest).catch((error: unknown) => { problems.push(error); });
        const message = clean ? `插件 ${id} 的已批准快照被改动过，已删除，重新批准以后才运行` : `插件 ${id} 的已批准快照被改动过，重新批准以后才运行`;
        unavailable.push({ id, state: "pending", reason: { code: "snapshot_modified", message } });
        continue;
      }
      const { manifest, plugin } = await loadPlugin(directory, { confined: true });
      if (manifest.id !== id) throw new RepaFault("plugin_id_mismatch", `快照里的插件 id 是 ${manifest.id}，启用记录里是 ${id}`, { id, manifest: manifest.id });
      loaded.push(plugin);
      selfWritten.push({ id, digest: entry.digest, manifest });
    } catch (error) {
      unavailable.push(failure(id, error));
      problems.push(error);
    }
  }
  for (const id of clean ? ids : []) {
    const entry = record.plugins[id];
    if (entry === undefined) continue;
    for (const digest of idle(entry)) {
      try {
        if ((await checkSnapshot(home, space.root, id, digest)) === "modified") await removeSnapshot(home, space.root, id, digest);
      } catch (error) {
        problems.push(error);
      }
    }
  }
  return { plugins: [...bundled, ...loaded], record, selfWritten, unavailable, problems };
}

/** 记录里保留着、这次不会运行的版本：上一个版本，卸载的插件连同当前版本。运行的版本在加载前已经核对。 */
function idle(entry: PluginEnablementEntry): string[] {
  const versions = entry.enabled ? [] : [entry.digest];
  if (entry.previous !== undefined && entry.previous !== entry.digest) versions.push(entry.previous);
  return versions;
}
