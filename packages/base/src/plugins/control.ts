import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

import type { Static } from "typebox";

import { isCode, remove } from "../backup/copy.js";
import type { PluginHost } from "../plugins.js";
import type { PluginInfo, PluginLoadFromSchema } from "../protocol.js";
import { errorText, RepaFault, type Confirmation, type PluginApproval } from "../schema.js";
import { SerialQueue } from "../storage.js";
import { readEnablement, withLoaded, withUnloaded, writeEnablement } from "./enablement.js";
import { loadPlugin, readPluginFolder, type PluginFolder } from "./manifest.js";
import { linkInPluginFolder, listPlugins, pluginFolderOf, type NotRunning } from "./plugin-list.js";
import { checkSnapshot, folderHashes, publishSnapshot, snapshotDirectory, stageFolder, type StagedFolder } from "./snapshots.js";
import type { SpacePlugins } from "./space-plugins.js";
import { checkSyntax } from "./syntax-check.js";

// 模块加载时的空上下文。导入、写记录、撤下与加上都在这里进行：插件顶层代码和它此后发起的写入不继承发起加载的那次运行。
const detached = AsyncLocalStorage.snapshot();

/** 加载取哪个版本：插件文件夹当前的内容、启用记录里的版本、上一次选定的版本。 */
export type LoadFrom = Static<typeof PluginLoadFromSchema>;

/**
 * 谁发起这次装卸。agent 是 Agent 在一次运行里经 plugin 工具提出，user 是使用者在插件列表里操作。
 * confirm 把批准发给发起的连接；signal 是运行的中止信号，停止运行时等待随之结束。
 */
export interface PluginOrigin {
  kind: "agent" | "user";
  confirm(request: Confirmation, signal?: AbortSignal): Promise<string | boolean | null>;
  signal?: AbortSignal;
}

/** 一次加载生效以后的结果：插件在列表里的一项，以及它的说明（运行中途装上的插件的说明要到下一次运行才进系统提示）。 */
export interface LoadResult {
  plugin: PluginInfo;
  instructions?: string;
}

/** 一个打开着的空间里自写插件的加载、卸载与插件列表。plugin 工具与协议方法都调用它。 */
export interface PluginControl {
  /** 最近一次算出的插件列表，同步返回，供初始化基线使用。 */
  current(): PluginInfo[];
  /** 重新算插件列表：读启用记录、核对源文件夹。 */
  list(): Promise<PluginInfo[]>;
  load(id: string, origin: PluginOrigin, from?: LoadFrom): Promise<LoadResult>;
  unload(id: string): Promise<PluginInfo>;
  /** 不再接受装卸，等正在写的启用记录写完，此后不再写启用记录。空间释放锁之前调用。 */
  close(): Promise<void>;
}

export interface PluginControlOptions {
  home: string;
  space: { root: string; dataDir: string };
  host: PluginHost;
  /** 打开空间时选出的插件。 */
  selected: Pick<SpacePlugins, "selfWritten" | "unavailable">;
  bundled: string[];
  now(): number;
  /** 完全访问模式：Agent 提出的与使用者在列表里的加载都不再询问。 */
  fullAccess(): boolean;
  /** 一次装卸结束、列表变了。 */
  onUpdate(plugins: PluginInfo[]): void;
  onError(error: unknown): void;
}

/** 暂存副本相对当前版本改动了哪些文件；当前版本没有完好的快照时全部算新增。 */
async function changes(home: string, root: string, id: string, recorded: string | undefined, staged: StagedFolder): Promise<Pick<PluginApproval, "base" | "files">> {
  const after = await folderHashes(staged.directory);
  let before: Map<string, string> | undefined;
  if (recorded !== undefined && (await checkSnapshot(home, root, id, recorded)) === "ok") {
    before = await folderHashes(snapshotDirectory(home, root, id, recorded));
  }
  const files: PluginApproval["files"] = [];
  for (const [file, hash] of after) {
    const old = before?.get(file);
    if (old === undefined) files.push({ path: file, change: "added" });
    else if (old !== hash) files.push({ path: file, change: "modified" });
  }
  for (const file of before?.keys() ?? []) {
    if (!after.has(file)) files.push({ path: file, change: "removed" });
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { base: before === undefined ? "none" : "recorded", files };
}

/** 读清单并核对 id 与文件夹名相同。只读清单，不执行代码。 */
async function expectId(directory: string, id: string): Promise<PluginFolder> {
  const folder = await readPluginFolder(directory);
  const { manifest } = folder;
  if (manifest.id !== id) throw new RepaFault("plugin_id_mismatch", `插件文件夹 ${id} 里清单的 id 是 ${manifest.id}，两者要相同`, { id, manifest: manifest.id });
  return folder;
}

/** 交给调用方的错误：插件自己抛出的值和文件系统的错误换成带错误码的 RepaFault，列表里的原因据此给出。 */
function faultOf(error: unknown, code: string, prefix: string): RepaFault {
  return error instanceof RepaFault ? error : new RepaFault(code, `${prefix}：${errorText(error)}`);
}

/** 加载停在某一步时的错误：运行已停止，那一步还没有返回。 */
function stopped(id: string, step: "import" | "close" | "open", outcome: string): RepaFault {
  const where = { import: "导入（模块顶层代码还没有执行完）", close: "等上一个实例的 close() 返回", open: "打开（插件的 open() 还没有返回）" }[step];
  return new RepaFault("plugin_load_stopped", `运行已停止，插件 ${id} 的加载停在${where}：${outcome}`, { id, step });
}

/**
 * 等一步结束；signal 先取消时不再等，以 onStop 给出的错误失败。那一步本身不取消，留在后台照常结束。
 * 取消时 work 已有处理函数，它此后的拒绝不成为未处理的拒绝。
 */
function until<T>(work: Promise<T>, signal: AbortSignal | undefined, onStop: () => RepaFault): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { reject(onStop()); };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    const settle = () => { signal?.removeEventListener("abort", abort); };
    work.then((value) => { settle(); resolve(value); }, (error: unknown) => { settle(); reject(error); });
  });
}

/**
 * 建立一个空间的装卸入口。装卸以插件为单位：同一个插件同时只有一次装卸，另一次立即以 plugin_busy 失败；
 * 全空间排队的只有启用记录的读出、修改、写回。加载的步骤：复制插件文件夹并读清单（不执行代码）；需要批准时先查语法（也不执行代码），再请求批准；
 * 发布快照并核对、导入；替换时撤下旧实例，等它的 close() 返回；写启用记录；加上新实例。批准以后的步骤在运行的上下文之外执行。
 * 导入、等 close()、打开都可能因插件代码一直不返回，运行停止时调用随之结束；停不掉的导入或打开留在后台，
 * 它结束以前这个插件仍算在装卸中，结束以后列表随之更新。卸载撤下实例（不等 close()）、写启用记录。
 * 这些步骤都不等空间写锁：快照在配置目录，启用记录在 .repa，插件的 open() 碰上写锁被占立即失败，追赶不等。
 */
export function createPluginControl(options: PluginControlOptions): PluginControl {
  const { home, host } = options;
  const { root, dataDir } = options.space;
  const bundled = new Set(options.bundled);
  // 运行中的自写插件的清单，与已启用却没有运行的自写插件及原因。
  const manifests = new Map(options.selected.selfWritten.map((plugin) => [plugin.id, plugin.manifest]));
  const notRunning = new Map<string, NotRunning>(options.selected.unavailable.map(({ id, state, reason }) => [id, { state, reason }]));
  // 已经撤下、close() 还没返回的实例；同一个插件的新实例等它，同一时刻只有一个实例写数据目录。
  const closing = new Map<string, Promise<void>>();
  // 正在装卸的插件。
  const busy = new Set<string>();
  const records = new SerialQueue();
  const lists = new SerialQueue();
  let latest: PluginInfo[] = [];
  let closed = false;

  function checkOpen(): void {
    if (closed) throw new RepaFault("space_closed", "空间已经关闭或切换，装卸没有进行");
  }

  /** 开始这个插件的一次装卸；已有一次在进行时立即失败。 */
  function claim(id: string): void {
    checkOpen();
    if (bundled.has(id)) throw new RepaFault("plugin_id_conflict", `${id} 是随产品附带的插件，不能作为自写插件加载或卸载`, { id });
    if (busy.has(id)) throw new RepaFault("plugin_busy", `插件 ${id} 正在加载或卸载，这一次没有进行`, { id });
    busy.add(id);
  }

  function list(): Promise<PluginInfo[]> {
    return lists.run(async () => {
      latest = await listPlugins({ home, root, dataDir, host, bundled: options.bundled, manifests, notRunning });
      return latest;
    });
  }

  /** 一次装卸结束以后：重新算列表并通知，返回这份列表。 */
  async function updated(): Promise<PluginInfo[]> {
    const plugins = await list();
    options.onUpdate(plugins);
    return plugins;
  }

  function itemOf(plugins: PluginInfo[], id: string): PluginInfo {
    const plugin = plugins.find((item) => item.id === id);
    if (plugin === undefined) throw new RepaFault("plugin_not_found", "插件不存在", { pluginId: id });
    return plugin;
  }

  /** 插件已启用却没在运行：列表里显示为失败，附上原因。 */
  function failed(id: string, fault: RepaFault): void {
    notRunning.set(id, { state: "failed", reason: { code: fault.code, message: fault.message } });
  }

  /** 撤下运行中的实例，不等 close()；返回它结束的 Promise，同一个插件的新实例等它。 */
  function retire(id: string): Promise<void> {
    manifests.delete(id);
    const done = host.remove(id).catch(() => undefined).finally(() => { if (closing.get(id) === done) closing.delete(id); });
    closing.set(id, done);
    return done;
  }

  /**
   * 加载前的准备：确定目标版本，需要批准时带回暂存副本、展示的内容和暂存副本里读出的入口。失败时抛错，什么都没有改变。
   */
  async function prepare(id: string, from: LoadFrom): Promise<{ digest: string; staged?: StagedFolder; approval?: PluginApproval; folder?: PluginFolder }> {
    const record = await readEnablement(dataDir);
    const entry = record.plugins[id];
    if (from === "previous") {
      if (entry?.previous === undefined) throw new RepaFault("previous_unavailable", `插件 ${id} 没有上一次选定的版本`, { id });
      if ((await checkSnapshot(home, root, id, entry.previous)) !== "ok") {
        throw new RepaFault("snapshot_missing", `插件 ${id} 上一次选定的版本没有完好的快照，不能让它重新生效`, { id });
      }
      return { digest: entry.previous };
    }
    if (from === "recorded") {
      if (entry === undefined) throw new RepaFault("plugin_not_recorded", `启用记录里没有插件 ${id}`, { id });
      if ((await checkSnapshot(home, root, id, entry.digest)) === "ok") return { digest: entry.digest };
    }
    const link = await linkInPluginFolder(root, id);
    if (link !== undefined) {
      throw new RepaFault("invalid_plugin_folder", `${path.relative(root, link)} 是符号链接；插件文件夹要实际放在空间的 .agents/plugins/${id}/ 里`, { id });
    }
    let staged: StagedFolder;
    try {
      staged = await stageFolder(home, root, pluginFolderOf(root, id));
    } catch (error) {
      if (isCode(error, "ENOENT")) throw new RepaFault("plugin_folder_missing", `插件文件夹 .agents/plugins/${id}/ 不存在`, { id });
      throw error;
    }
    try {
      if (from === "recorded" && staged.digest !== entry?.digest) {
        throw new RepaFault("snapshot_missing", `插件 ${id} 记录的版本在本机没有快照，文件夹的内容也已不同；要运行文件夹现在的内容，用 from: folder`, { id });
      }
      const folder = await expectId(staged.directory, id);
      const { manifest } = folder;
      // 同一份内容本机已经批准过：快照在而且完好，不再询问。
      if ((await checkSnapshot(home, root, id, staged.digest)) === "ok") {
        await remove(staged.directory);
        return { digest: staged.digest };
      }
      return {
        digest: staged.digest,
        staged,
        folder,
        approval: {
          id,
          ...(manifest.title === undefined ? {} : { title: manifest.title }),
          version: manifest.version,
          digest: staged.digest,
          pages: (manifest.pages ?? []).map((page) => ({ id: page.id, title: page.title })),
          ...(await changes(home, root, id, entry?.digest, staged)),
        },
      };
    } catch (error) {
      await remove(staged.directory).catch(options.onError);
      throw error;
    }
  }

  /** 请求批准。true 才继续；拒绝、没有作出决定、没有连接可问、运行被停止都抛错。 */
  async function approve(approval: PluginApproval, origin: PluginOrigin): Promise<void> {
    let answer: string | boolean | null;
    try {
      answer = await origin.confirm({ kind: "plugin", title: "", plugin: approval }, origin.signal);
    } catch (error) {
      throw new RepaFault("plugin_not_decided", `批准没有完成，插件没有加载：${errorText(error)}`, { id: approval.id });
    }
    if (answer === false) throw new RepaFault("plugin_denied", `使用者拒绝了插件 ${approval.id}，插件没有加载`, { id: approval.id });
    if (answer !== true) throw new RepaFault("plugin_not_decided", `使用者没有作出决定，插件 ${approval.id} 没有加载`, { id: approval.id });
  }

  /**
   * 批准以后的各步：发布快照并核对、导入；替换时撤下旧实例，等它的 close() 返回；写启用记录；加上新实例。
   * 运行停止时，停在导入或打开的那一步交给 abandon，它在后台结束以前这个插件仍算在装卸中。
   */
  async function commit(id: string, digest: string, staged: StagedFolder | undefined, signal: AbortSignal | undefined, abandon: (work: Promise<unknown>) => void): Promise<void> {
    if (staged !== undefined) await publishSnapshot(home, root, id, staged);
    // 发布以后、导入之前再核对一次：暂存目录被换成链接时，发布的内容可能不对应摘要。
    if ((await checkSnapshot(home, root, id, digest)) !== "ok") {
      throw new RepaFault("snapshot_modified", `插件 ${id} 的快照与批准的内容不符，没有导入`, { id });
    }
    // 导入执行模块顶层代码。导入出错或停在这里时到此为止：正在运行的版本照常运行，启用记录不变。
    const importing = loadPlugin(snapshotDirectory(home, root, id, digest), { snapshotOf: id });
    const { plugin, manifest } = await until(importing, signal, () => {
      abandon(importing);
      return stopped(id, "import", "启用记录与正在运行的插件都没有改变");
    });
    const replacing = host.list().some((item) => item.id === id);
    // 新实例等旧实例的 close() 返回才打开：这一次撤下的，或者此前卸载、还没关完的。
    const previous = replacing ? retire(id) : closing.get(id);
    if (previous !== undefined) {
      await until(previous, signal, () => {
        const fault = stopped(id, "close", replacing ? "旧版本已经撤下，新版本没有打开，启用记录没有改变" : "新版本没有打开，启用记录没有改变");
        if (replacing) failed(id, fault);
        return fault;
      });
    }
    await records.run(async () => {
      checkOpen();
      try {
        const record = await readEnablement(dataDir);
        await writeEnablement(dataDir, withLoaded(record, id, digest, new Date(options.now()).toISOString()));
      } catch (error) {
        // 盘上仍是原来的记录。替换时旧实例已经关闭，插件这时没有运行。
        const fault = faultOf(error, "plugin_enablement_write_failed", `插件 ${id} 的启用记录没有写成，盘上仍是原来的记录`);
        if (replacing) failed(id, fault);
        throw fault;
      }
    });
    // 不自动退回旧版本：打开失败时记录指向新版本，插件显示为失败，可以明确地让上一次选定的版本重新生效。
    const opening = host.add(plugin).then(() => {
      notRunning.delete(id);
      manifests.set(id, manifest);
    }, (error: unknown) => {
      const fault = faultOf(error, "plugin_open_failed", `插件 ${id} 打开失败`);
      failed(id, fault);
      throw fault;
    });
    await until(opening, signal, () => {
      abandon(opening);
      const fault = stopped(id, "open", "启用记录已指向新版本，插件之后打开成功或失败，插件列表随之更新");
      failed(id, fault);
      return fault;
    });
  }

  return {
    current: () => latest,
    list,
    async load(id, origin, from = "folder") {
      claim(id);
      // 运行停止时留在后台的导入或打开；它结束以后这个插件才能再装卸。
      let leftover: Promise<unknown> | undefined;
      try {
        const { digest, staged, approval, folder } = await prepare(id, from);
        try {
          // 完全访问模式下不再询问，无论是 Agent 提出的还是使用者在列表里的操作。
          if (approval !== undefined && !options.fullAccess()) {
            // 先查语法，不执行代码：有语法错误就当场交回，不为一份导入必然失败的内容请求批准。
            const fault = folder === undefined ? undefined : await checkSyntax(id, folder.root, folder.entry);
            if (fault !== undefined) throw fault;
            await approve(approval, origin);
          }
        } catch (error) {
          if (staged !== undefined) await remove(staged.directory).catch(options.onError);
          throw error;
        }
        await detached(() => commit(id, digest, staged, origin.signal, (work) => { leftover = work; }));
        const item = itemOf(await updated(), id);
        // 说明是插件代码给的；它出错不改变已经生效的结局，只是不随结果带上。
        let text: string | undefined;
        try {
          text = host.instructions().find((entry) => entry.id === `plugin:${id}`)?.text;
        } catch (error) {
          options.onError(error);
        }
        return { plugin: item, ...(text === undefined ? {} : { instructions: text }) };
      } catch (error) {
        updated().catch(options.onError);
        throw error;
      } finally {
        if (leftover === undefined) busy.delete(id);
        else {
          const release = () => {
            busy.delete(id);
            if (!closed) updated().catch(options.onError);
          };
          leftover.then(release, release);
        }
      }
    },
    async unload(id) {
      claim(id);
      try {
        await records.run(() => detached(async () => {
          checkOpen();
          const record = await readEnablement(dataDir);
          const running = host.list().some((item) => item.id === id);
          if (record.plugins[id]?.enabled !== true && !running) throw new RepaFault("plugin_not_enabled", `插件 ${id} 没有启用，不需要卸载`, { id });
          if (running) void retire(id);
          try {
            await writeEnablement(dataDir, withUnloaded(record, id));
          } catch (error) {
            const fault = faultOf(error, "plugin_enablement_write_failed", `插件 ${id} 的启用记录没有写成，盘上仍是原来的记录`);
            if (running) failed(id, fault);
            throw fault;
          }
          notRunning.delete(id);
        }));
        return itemOf(await updated(), id);
      } catch (error) {
        updated().catch(options.onError);
        throw error;
      } finally {
        busy.delete(id);
      }
    },
    async close() {
      closed = true;
      await records.settled();
    },
  };
}
