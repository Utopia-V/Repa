import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { AgentSpace, PluginRequestOrigin, PluginToolRequest } from "../agent.js";
import { isCode } from "../backup/copy.js";
import type { PluginHost } from "../plugins.js";
import { readEnablement, withLoaded, withUnloaded, writeEnablement, type EnablementWrite, type PluginEnablement } from "../plugins/enablement.js";
import { loadPlugin, readPluginFolder } from "../plugins/manifest.js";
import { linkInPluginFolder, pluginFolderOf } from "../plugins/plugin-list.js";
import { checkSnapshot, discardStaged, folderHashes, publishSnapshot, snapshotDirectory, stageFolder, type StagedFolder } from "../plugins/snapshots.js";
import type { SpacePlugin, UnavailablePlugin } from "../plugins/space-plugins.js";
import type { PluginInfo, PluginOutcome, PluginRequestStage, PluginResult } from "../protocol.js";
import { errorText, RepaFault, type Confirmation, type PluginApproval } from "../schema.js";

/** 加载取哪个版本：插件文件夹当前的内容、启用记录里的版本、上一次选定的版本。 */
export type LoadFrom = "folder" | "recorded" | "previous";
type Reason = { code: string; message: string };
type RequestState = NonNullable<PluginInfo["request"]>;

interface Item {
  id: string;
  action: "load" | "unload";
  from: LoadFrom;
  /** 加载的目标版本，准备以后确定。 */
  digest?: string;
  /** 需要批准的暂存副本；批准以后发布为快照。 */
  staged?: StagedFolder;
  approval?: PluginApproval;
  /** 写入以后读回的盘上记录，是否因这一项改变。 */
  recorded?: boolean;
  outcome?: PluginOutcome;
}

type Origin<P> =
  | {
    kind: "agent";
    sessionId: string;
    runId: string;
    peer: P | undefined;
    since: number;
    /** 这次运行里每一次提出请求时都处于完全访问模式。 */
    fullAccess: boolean;
    status?: "completed" | "failed" | "aborted";
  }
  | { kind: "list"; peer: P };

interface Batch<P> {
  id: string;
  root: string;
  opened: number;
  origin: Origin<P>;
  items: Item[];
  stage: PluginRequestStage;
  controller: AbortController;
  /** 重组的闸门已经落下，不能再撤回；结果在重组里交回。 */
  executing: boolean;
  /** 各项都已有结局，正在等空闲把结果交回会话；撤回已经没有意义。 */
  handingBack: boolean;
  done: boolean;
}

/** 当前打开的空间：根目录、数据目录、这一次打开的装配序号与随包插件的 id。 */
export interface RequestSpace {
  root: string;
  dataDir: string;
  opened: number;
  bundled: string[];
}

/** 一次重组为一批装卸做的事，由重组按次序调用。 */
export interface Execution {
  /** 空闲成立、闸门落下的那一刻（同步）。此后不能撤回。 */
  begin(): void;
  /** 旧的插件宿主与 Agent 空间都已关闭：写启用记录并读回。clean 为 false 时这次装配不清理快照。 */
  write(): Promise<{ clean: boolean }>;
  /** 新的装配已经建立、闸门尚未抬起：按装配读到的启用记录与运行的插件判断每项的结局，把结果交回请求方会话、登记续跑。 */
  finish(assembled: Assembled): Promise<void>;
  /** 重组整体失败，空间已经关闭。 */
  failed(error: unknown): void;
}

/** 重组以后的装配。 */
export interface Assembled {
  agent: AgentSpace;
  host: PluginHost;
  selfWritten: SpacePlugin[];
  unavailable: UnavailablePlugin[];
  /** 装配实际读到的启用记录；读不了时为 undefined，这时没有自写插件运行。 */
  record: PluginEnablement | undefined;
  closeFailures: { pluginId: string; message: string }[];
}

/** 装卸请求借用后端的部分：确认、重组、事件与连接。P 是连接。 */
export interface RequestHost<P> {
  home: string;
  now(): number;
  current(): RequestSpace | undefined;
  /** 向连接发 kind 为 plugin 的确认；signal 中止时确认结束。 */
  confirm(peer: P, request: Confirmation, signal: AbortSignal): Promise<string | boolean | null>;
  alive(peer: P): boolean;
  fullAccess(): boolean;
  /** 等空间空闲并进行一次重组；signal 中止或空间关闭、切换时以 cancelled 结束。 */
  execute(execution: Execution, signal: AbortSignal): Promise<"applied" | "cancelled">;
  /**
   * 不重组，等空间空闲、在闸门下以当前装配的 Agent 空间调用 action，交回没有经过重组的结果；
   * 空间关闭、切换或后端关闭时以 cancelled 结束，action 不调用。
   */
  handBack(action: (agent: AgentSpace) => Promise<void>): Promise<"done" | "cancelled">;
  /** 在连接名下执行 action：续跑的运行属于发起请求的连接，命令确认与询问发给它。action 同步开始。 */
  runAs(peer: P, action: () => Promise<void>): Promise<void>;
  /** 请求的阶段或结局变了。 */
  updated(): void;
  error(error: unknown): void;
}

class Stopped extends Error {
  constructor(readonly application: "denied" | "cancelled", readonly reason: Reason) {
    super(reason.message);
  }
}

const withdrawn = () => new Stopped("cancelled", { code: "plugin_request_cancelled", message: "请求已撤回" });
const spaceChanged = () => new Stopped("cancelled", { code: "space_changed", message: "空间已经关闭或切换，请求没有执行" });

/** 批次的 signal 中止时的结局：撤回与空间关闭各自带着原因中止它。 */
function abortedBy(signal: AbortSignal): Stopped {
  return signal.reason instanceof Stopped ? signal.reason : withdrawn();
}

const STAGES: Record<PluginRequestStage, string> = {
  requested: "等本次运行结束",
  queued: "排队中",
  preparing: "准备中",
  approving: "等使用者批准",
  importing: "导入中",
  waiting: "等空间空闲",
  executing: "重组中",
};
const APPLICATIONS: Record<PluginOutcome["application"], string> = {
  applied: "已生效",
  failed: "没有生效",
  denied: "使用者拒绝批准",
  cancelled: "已取消",
};
const STATES: Record<PluginInfo["state"], string> = {
  disabled: "未启用",
  running: "运行中",
  pending: "待批准",
  failed: "失败",
};
const FOLDERS: Record<NonNullable<PluginInfo["folder"]>, string> = {
  same: "与记录的版本相同",
  modified: "相对记录的版本有改动",
  missing: "不在",
  unreadable: "读不了",
};

function reasonOf(error: unknown): Reason {
  return { code: error instanceof RepaFault ? error.code : "plugin_request_failed", message: errorText(error) };
}

function outcomeText(outcome: PluginOutcome): string {
  const reason = outcome.reason === undefined ? "" : `。${outcome.reason.message}（${outcome.reason.code}）`;
  return `${APPLICATIONS[outcome.application]}，启用记录${outcome.recorded ? "已改" : "未改"}${reason}`;
}

/** 插件列表的分行文字，交给 plugin 工具的 list。 */
export function listText(plugins: PluginInfo[]): string {
  if (plugins.length === 0) return "这个空间没有插件。自写插件放在 .agents/plugins/<id>/。";
  return plugins.map((plugin) => {
    const parts = [`${plugin.id}（${plugin.source === "bundled" ? "随产品附带" : "自写"}）`, STATES[plugin.state]];
    if (plugin.reason !== undefined) parts.push(`原因：${plugin.reason.message}（${plugin.reason.code}）`);
    if (plugin.version !== undefined) parts.push(`版本 ${plugin.version}`);
    if (plugin.folder !== undefined) parts.push(`文件夹${FOLDERS[plugin.folder]}`);
    if (plugin.tools.length > 0) parts.push(`工具 ${plugin.tools.join("、")}`);
    if (plugin.previous !== undefined) parts.push("有上一次选定的版本");
    const request = plugin.request;
    if (request !== undefined) parts.push("stage" in request ? `请求 ${request.id}：${STAGES[request.stage]}` : `最近一次请求 ${request.id}：${outcomeText(request.outcome)}`);
    return parts.join("；");
  }).join("\n");
}

/**
 * 自写插件的装卸请求。Agent 的一次运行里提出的请求合成一批，运行结束时封口；插件列表的 plugin.load、plugin.unload 各成一批。
 * 每个空间一条队列，先进先出，一次只有一批经过各段：准备 → 批准 → 发布快照并导入 → 等待空闲 → 执行（一次重组）。
 * Agent 的批次把结果交回请求方会话：经过重组的在重组里交回；没有经过重组就结束的（准备或导入失败、拒绝、撤回）
 * 等到空闲、在闸门下交回，空间已经关闭或切换时不交回。插件列表发起的批次没有会话，结局只在请求状态里。
 */
export function createPluginRequests<P>(host: RequestHost<P>) {
  // 还在运行中、尚未封口的 Agent 批次，以运行编号为键。
  const open = new Map<string, Batch<P>>();
  const queue: Batch<P>[] = [];
  let processing: Batch<P> | undefined;
  // 每个空间每个插件当前的或最近一次的请求状态，进程内保留，空间重新打开以后仍可查看。
  const states = new Map<string, Map<string, RequestState>>();
  // 介入的时钟：使用者在会话里发消息、停止、压缩、分支，或者关闭、切换空间时加一，续跑据此判断请求提出以后有没有介入。
  let clock = 0;
  const sessionMarks = new Map<string, number>();
  let spaceMark = 0;

  function stateOf(root: string): Map<string, RequestState> {
    let map = states.get(root);
    if (map === undefined) {
      map = new Map();
      states.set(root, map);
    }
    return map;
  }

  function setStage(batch: Batch<P>, stage: PluginRequestStage): void {
    batch.stage = stage;
    const map = stateOf(batch.root);
    for (const item of batch.items) {
      if (item.outcome === undefined) map.set(item.id, { id: batch.id, stage });
    }
    host.updated();
  }

  function settle(batch: Batch<P>, item: Item, outcome: PluginOutcome): void {
    item.outcome = outcome;
    stateOf(batch.root).set(item.id, { id: batch.id, outcome });
  }

  /** 所有尚无结局的项按同一结局结束。 */
  function stop(batch: Batch<P>, stopped: Stopped): void {
    for (const item of batch.items) {
      if (item.outcome === undefined) settle(batch, item, { recorded: false, application: stopped.application, reason: stopped.reason });
    }
  }

  /** 批次结束时删掉它仍持有的暂存副本：拒绝、撤回，或准备在暂存以后失败，副本都不再有人使用。 */
  async function release(batch: Batch<P>): Promise<void> {
    for (const item of batch.items) {
      const staged = item.staged;
      if (staged === undefined) continue;
      item.staged = undefined;
      await discardStaged(staged).catch(host.error);
    }
  }

  function guard(batch: Batch<P>): void {
    if (batch.controller.signal.aborted) throw abortedBy(batch.controller.signal);
    if (host.current()?.opened !== batch.opened) throw spaceChanged();
  }

  /** 请求提出以后，使用者没有在这个会话里介入，也没有关闭、切换或新建空间。 */
  function quiet(origin: Extract<Origin<P>, { kind: "agent" }>): boolean {
    return (sessionMarks.get(origin.sessionId) ?? 0) <= origin.since && spaceMark <= origin.since;
  }

  function addItems(batch: Batch<P>, action: "load" | "unload", ids: string[], from: LoadFrom): void {
    for (const id of ids) {
      // 同一批里后提出的请求取代先前对同一插件的请求。
      batch.items = batch.items.filter((item) => item.id !== id);
      batch.items.push({ id, action, from });
    }
  }

  function checkIds(space: RequestSpace, action: "load" | "unload", ids: string[]): void {
    for (const id of ids) {
      if (space.bundled.includes(id)) {
        throw action === "unload"
          ? new RepaFault("plugin_bundled", `插件 ${id} 随产品附带，不能卸载`, { id })
          : new RepaFault("plugin_id_conflict", `插件 ${id} 与随产品附带的插件同名，自写插件要换一个 id`, { id });
      }
    }
  }

  function enqueue(batch: Batch<P>): void {
    queue.push(batch);
    setStage(batch, "queued");
    pump();
  }

  function pump(): void {
    if (processing !== undefined) return;
    const batch = queue.shift();
    if (batch === undefined) return;
    processing = batch;
    advance(batch).catch((error: unknown) => {
      host.error(error);
      for (const item of batch.items) {
        if (item.outcome === undefined) settle(batch, item, { recorded: false, application: "failed", reason: reasonOf(error) });
      }
    }).then(() => release(batch)).then(() => handBack(batch)).catch(host.error).finally(() => {
      batch.done = true;
      processing = undefined;
      host.updated();
      pump();
    });
  }

  /** 准备一项：卸载核对它已启用；加载复制文件夹、读清单，确定目标版本，判断是否需要批准。失败时抛错，只影响这一项。 */
  async function prepare(space: RequestSpace, record: PluginEnablement, item: Item): Promise<void> {
    const entry = record.plugins[item.id];
    if (item.action === "unload") {
      if (entry?.enabled !== true) throw new RepaFault("plugin_not_enabled", `插件 ${item.id} 没有启用，不需要卸载`, { id: item.id });
      return;
    }
    if (item.from === "previous") {
      if (entry?.previous === undefined) throw new RepaFault("previous_unavailable", `插件 ${item.id} 没有上一次选定的版本`, { id: item.id });
      const status = await checkSnapshot(host.home, space.root, item.id, entry.previous);
      if (status !== "ok") throw new RepaFault("snapshot_missing", `插件 ${item.id} 上一次选定的版本的快照${status === "missing" ? "不在了" : "被改动过"}，不能让它重新生效`, { id: item.id });
      item.digest = entry.previous;
      await expectId(snapshotDirectory(host.home, space.root, item.id, entry.previous), item.id);
      return;
    }
    if (item.from === "recorded") {
      if (entry === undefined) throw new RepaFault("plugin_not_recorded", `启用记录里没有插件 ${item.id}`, { id: item.id });
      if ((await checkSnapshot(host.home, space.root, item.id, entry.digest)) === "ok") {
        item.digest = entry.digest;
        return;
      }
    }
    const link = await linkInPluginFolder(space.root, item.id);
    if (link !== undefined) {
      throw new RepaFault("invalid_plugin_folder", `${path.relative(space.root, link)} 是符号链接；插件文件夹要实际放在空间的 .agents/plugins/${item.id}/ 里`, { id: item.id });
    }
    let staged: StagedFolder;
    try {
      staged = await stageFolder(host.home, space.root, pluginFolderOf(space.root, item.id));
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        throw new RepaFault("plugin_folder_missing", `插件文件夹 .agents/plugins/${item.id}/ 不存在`, { id: item.id });
      }
      throw error;
    }
    try {
      if (item.from === "recorded" && staged.digest !== entry?.digest) {
        throw new RepaFault("snapshot_missing", `插件 ${item.id} 记录的版本没有快照，文件夹的内容也已不同；要运行文件夹现在的内容，用 from: folder`, { id: item.id });
      }
      const manifest = await expectId(staged.directory, item.id);
      item.digest = staged.digest;
      // 同一内容本机已经批准过：快照在而且完好，不再询问。
      if ((await checkSnapshot(host.home, space.root, item.id, staged.digest)) === "ok") {
        await discardStaged(staged);
        return;
      }
      item.staged = staged;
      item.approval = {
        id: item.id,
        ...(manifest.title === undefined ? {} : { title: manifest.title }),
        version: manifest.version,
        digest: staged.digest,
        pages: (manifest.pages ?? []).map((page) => ({ id: page.id, title: page.title })),
        ...(await changes(space, item.id, entry?.digest, staged)),
      };
    } catch (error) {
      if (item.staged === undefined) await discardStaged(staged).catch(host.error);
      throw error;
    }
  }

  /** 读清单并核对 id 与文件夹名相同。 */
  async function expectId(directory: string, id: string) {
    const { manifest } = await readPluginFolder(directory);
    if (manifest.id !== id) throw new RepaFault("plugin_id_mismatch", `插件文件夹 ${id} 里清单的 id 是 ${manifest.id}，两者要相同`, { id, manifest: manifest.id });
    return manifest;
  }

  /** 暂存副本相对记录里当前版本的改动；当前版本没有完好的快照时全部算新增。 */
  async function changes(space: RequestSpace, id: string, recorded: string | undefined, staged: StagedFolder): Promise<Pick<PluginApproval, "base" | "files">> {
    const after = await folderHashes(staged.directory);
    let before: Map<string, string> | undefined;
    if (recorded !== undefined) {
      try {
        if ((await checkSnapshot(host.home, space.root, id, recorded)) === "ok") before = await folderHashes(snapshotDirectory(host.home, space.root, id, recorded));
      } catch {
        before = undefined;
      }
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

  /** 让一批请求依次经过各段，直到每一项都有结局。 */
  async function advance(batch: Batch<P>): Promise<void> {
    try {
      guard(batch);
      const space = host.current();
      if (space === undefined) throw new Stopped("cancelled", { code: "space_changed", message: "空间已经关闭" });
      setStage(batch, "preparing");
      let record: PluginEnablement;
      try {
        record = await readEnablement(space.dataDir);
      } catch (error) {
        throw new Stopped("cancelled", { code: "plugin_enablement_unreadable", message: `启用记录读不了，请求没有执行：${errorText(error)}` });
      }
      for (const item of batch.items) {
        guard(batch);
        try {
          await prepare(space, record, item);
        } catch (error) {
          if (error instanceof Stopped) throw error;
          settle(batch, item, { recorded: false, application: "failed", reason: reasonOf(error) });
        }
      }
      guard(batch);
      await approve(batch);
      guard(batch);
      setStage(batch, "importing");
      for (const item of batch.items) {
        if (item.outcome !== undefined || item.action !== "load" || item.digest === undefined) continue;
        guard(batch);
        try {
          await importItem(batch, space, item);
        } catch (error) {
          if (error instanceof Stopped) throw error;
          // 导入失败到此为止：记录不变，原来的版本照常运行。
          settle(batch, item, { recorded: false, application: "failed", reason: reasonOf(error) });
        }
      }
      guard(batch);
      if (batch.items.every((item) => item.outcome !== undefined)) return;
      setStage(batch, "waiting");
      const executed = { value: false };
      const status = await host.execute(execution(batch, space, executed), batch.controller.signal);
      if (status === "cancelled" && !executed.value) throw batch.controller.signal.aborted ? abortedBy(batch.controller.signal) : spaceChanged();
      // 记录已经写过、装配却没有进行（后端正在关闭）：盘上的记录按 recorded 报告，这次没有生效。
      for (const item of batch.items) {
        if (item.outcome === undefined) settle(batch, item, { recorded: item.recorded ?? false, application: "failed", reason: { code: "reassembly_cancelled", message: "后端正在关闭，重组没有完成" } });
      }
    } catch (error) {
      if (!(error instanceof Stopped)) throw error;
      stop(batch, error);
    }
  }

  /**
   * Agent 的批次没有经过重组就结束时，把结果交回请求方会话：等到空闲，在闸门下交回，期间批次仍占着队列。
   * 准备或导入失败结束的，满足续跑条件时续跑，Agent 拿到错误接着改；拒绝、撤回、无人批准的只追加结果。
   * 空间已经关闭或切换、后端正在关闭时不交回。
   */
  async function handBack(batch: Batch<P>): Promise<void> {
    const origin = batch.origin;
    if (origin.kind !== "agent" || batch.executing) return;
    if (host.current()?.opened !== batch.opened) return;
    const followUp = batch.items.every((item) => item.outcome?.application === "failed");
    batch.handingBack = true;
    setStage(batch, "waiting");
    await host.handBack((agent) => deliver(batch, origin, agent, [], followUp));
  }

  /**
   * 需要批准的项合成一次确认，发给发起请求的连接；整批同意或拒绝。Agent 在完全访问模式下明确提出的加载不再询问，
   * 条件是提出时与此刻都处于完全访问模式，提出它的运行正常结束，此后使用者没有介入：停止运行或插话就是收回这次授权，照常询问。
   */
  async function approve(batch: Batch<P>): Promise<void> {
    const pending = batch.items.filter((item) => item.outcome === undefined && item.approval !== undefined);
    if (pending.length === 0) return;
    const origin = batch.origin;
    if (origin.kind === "agent" && origin.fullAccess && host.fullAccess() && origin.status === "completed" && quiet(origin)) return;
    const peer = batch.origin.peer;
    if (peer === undefined || !host.alive(peer)) throw new Stopped("cancelled", { code: "confirmation_cancelled", message: "发起请求的连接已经不在，没有人批准" });
    setStage(batch, "approving");
    // 改动之前就复算了暂存副本的标题和改动：此后改动 .agents/plugins 里的文件不影响这一次批准的内容。
    let answer: string | boolean | null;
    try {
      answer = await host.confirm(peer, { kind: "plugin", title: "", plugins: pending.flatMap((item) => (item.approval === undefined ? [] : [item.approval])) }, batch.controller.signal);
    } catch (error) {
      if (batch.controller.signal.aborted) throw abortedBy(batch.controller.signal);
      throw new Stopped("cancelled", { code: error instanceof RepaFault ? error.code : "confirmation_cancelled", message: `批准没有完成：${errorText(error)}` });
    }
    if (answer !== true) {
      // 不需要批准的项（卸载、已批准过的内容）没有展示给使用者，不算被拒绝：它们随同批的拒绝取消。
      for (const item of batch.items) {
        if (item.outcome === undefined && item.approval === undefined) {
          settle(batch, item, { recorded: false, application: "cancelled", reason: { code: "plugin_batch_denied", message: "同一批里需要批准的项没有获批，这一项随之没有执行" } });
        }
      }
      throw new Stopped("denied", { code: "plugin_denied", message: "使用者没有批准" });
    }
  }

  /** 批准以后：暂存副本发布为快照，再导入入口。导入执行模块顶层代码，所以在批准之后；放在写记录之前，语法错误这类失败不必停掉旧版。 */
  async function importItem(batch: Batch<P>, space: RequestSpace, item: Item): Promise<void> {
    const digest = item.digest;
    if (digest === undefined) return;
    if (item.staged !== undefined) {
      const staged = item.staged;
      item.staged = undefined;
      try {
        await publishSnapshot(host.home, space.root, item.id, staged);
      } catch (error) {
        await discardStaged(staged).catch(() => undefined);
        throw error;
      }
      // 发布期间撤回或关闭了空间：快照留着（它是获批的内容），但不再导入。
      guard(batch);
    }
    // 导入之前最后一次核对：loadPlugin 里还有异步读取，撤回可能在那时到达。已经开始执行的模块顶层代码收不回。
    const loaded = await loadPlugin(snapshotDirectory(host.home, space.root, item.id, digest), { confined: true, beforeImport: () => guard(batch) });
    if (loaded.manifest.id !== item.id) throw new RepaFault("plugin_id_mismatch", `快照里的插件 id 是 ${loaded.manifest.id}，请求的是 ${item.id}`, { id: item.id });
  }

  function execution(batch: Batch<P>, space: RequestSpace, executed: { value: boolean }): Execution {
    let write: EnablementWrite | undefined;
    let before: PluginEnablement | undefined;
    const items = () => batch.items.filter((item) => item.outcome === undefined);
    return {
      begin() {
        batch.executing = true;
        setStage(batch, "executing");
      },
      async write() {
        executed.value = true;
        try {
          before = await readEnablement(space.dataDir);
        } catch (error) {
          // 读不了就不写：写进去会丢掉记录里别的插件。装配仍按盘上的记录进行。
          for (const item of items()) settle(batch, item, { recorded: false, application: "failed", reason: { code: "plugin_enablement_unreadable", message: `启用记录读不了，没有写入：${errorText(error)}` } });
          return { clean: false };
        }
        let next = before;
        const at = new Date(host.now()).toISOString();
        for (const item of items()) {
          next = item.action === "load" && item.digest !== undefined ? withLoaded(next, item.id, item.digest, at) : withUnloaded(next, item.id);
        }
        try {
          write = await writeEnablement(space.dataDir, next);
        } catch (error) {
          write = { status: "unknown", error, readError: error };
        }
        const after = write.status === "unknown" ? undefined : write.record;
        for (const item of items()) item.recorded = after !== undefined && !isDeepStrictEqual(before.plugins[item.id], after.plugins[item.id]);
        // 持久化没有确认或盘上状态不明时不清理快照：掉电以后盘上可能还是旧记录，它引用的快照要留着。
        return { clean: write.status === "written" || write.status === "unchanged" };
      },
      async finish(assembled) {
        executed.value = true;
        // 结局只按装配实际读到的启用记录与这次运行的插件结算：recorded 比较写入之前与装配读到的记录，
        // application 看装配以后是否以目标摘要运行（卸载看是否不再运行）。写入的状态只决定这一次清不清快照。
        const seen = assembled.record;
        const running = new Set(assembled.host.list().map((plugin) => plugin.id));
        const disabled = new Map(assembled.host.disabled().map((plugin) => [plugin.id, plugin.reason]));
        const unavailable = new Map(assembled.unavailable.map((plugin) => [plugin.id, plugin.reason]));
        const writeError = write !== undefined && write.status !== "written" ? `：${errorText(write.error)}` : "";
        const unreadable: Reason = { code: "plugin_enablement_unreadable", message: "装配时启用记录读不了，自写插件都没有运行" };
        const notWritten: Reason = { code: "record_write_failed", message: `启用记录没有改成这次请求的样子${writeError}` };
        for (const item of items()) {
          const entry = seen?.plugins[item.id];
          const recorded = before !== undefined && seen !== undefined && !isDeepStrictEqual(before.plugins[item.id], entry);
          let reason: Reason | undefined;
          if (item.action === "load") {
            const loaded = assembled.selfWritten.find((plugin) => plugin.id === item.id);
            if (!running.has(item.id) || loaded?.digest !== item.digest) {
              if (seen === undefined) reason = unreadable;
              else if (entry?.enabled !== true || entry.digest !== item.digest) reason = notWritten;
              else reason = disabled.get(item.id) ?? unavailable.get(item.id) ?? { code: "plugin_not_running", message: `插件 ${item.id} 没有运行` };
            }
          } else if (seen === undefined) {
            reason = unreadable;
          } else if (entry?.enabled === true || running.has(item.id)) {
            reason = notWritten;
          }
          settle(batch, item, { recorded, application: reason === undefined ? "applied" : "failed", ...(reason === undefined ? {} : { reason }) });
        }
        host.updated();
        if (batch.origin.kind === "agent") await deliver(batch, batch.origin, assembled.agent, assembled.closeFailures, true);
      },
      failed(error) {
        executed.value = true;
        for (const item of items()) settle(batch, item, { recorded: item.recorded ?? false, application: "failed", reason: { code: "reassembly_failed", message: `重组整体失败，空间已经关闭：${errorText(error)}` } });
      },
    };
  }

  /**
   * 结果交回请求方会话。会话取得以后，在同一段同步代码里核对续跑的条件并登记运行：followUp 为真，提出请求的运行正常结束，
   * 此后使用者没有在这个会话里发消息、停止、换模型、压缩或分支，没有关闭或切换空间，发起它的连接还在。
   * 满足时以结果为输入开始下一次运行，否则只追加结果条目。只等登记，不等运行。
   * 取不到会话或写不进去时记进最近错误，不使批次或闸门停住；结局仍在请求状态里。
   */
  async function deliver(batch: Batch<P>, origin: Extract<Origin<P>, { kind: "agent" }>, agent: AgentSpace, closeFailures: Assembled["closeFailures"], followUp: boolean): Promise<void> {
    const result = resultOf(batch, closeFailures);
    const text = resultText(batch, closeFailures);
    const undelivered = (error: unknown) => {
      host.error(new RepaFault("plugin_result_undelivered", `插件装卸请求 ${batch.id} 的结果没能写进会话 ${origin.sessionId}：${errorText(error)}`, { requestId: batch.id, sessionId: origin.sessionId }));
    };
    let session;
    try {
      session = await agent.get(origin.sessionId);
    } catch (error) {
      undelivered(error);
      return;
    }
    const peer = origin.peer;
    if (followUp && origin.status === "completed" && quiet(origin) && peer !== undefined && host.alive(peer)) {
      const continued = session;
      // 运行自己的失败已经作为会话的 error 事件发出。
      host.runAs(peer, () => continued.continueWith(text, result)).catch(() => undefined);
      return;
    }
    try {
      session.appendPluginResult(text, result);
    } catch (error) {
      undelivered(error);
    }
  }

  function resultOf(batch: Batch<P>, closeFailures: Assembled["closeFailures"]): PluginResult {
    return {
      requestId: batch.id,
      items: batch.items.flatMap((item) => (item.outcome === undefined ? [] : [{ id: item.id, action: item.action, outcome: item.outcome }])),
      closeFailures: closeFailures.map((failure) => ({ ...failure })),
    };
  }

  function resultText(batch: Batch<P>, closeFailures: Assembled["closeFailures"]): string {
    const lines = [`插件装卸请求 ${batch.id} 的结果：`];
    for (const item of batch.items) {
      if (item.outcome === undefined) continue;
      lines.push(`- ${item.action === "load" ? "加载" : "卸载"} ${item.id}：${outcomeText(item.outcome)}`);
    }
    for (const failure of closeFailures) lines.push(`- 插件 ${failure.pluginId} 的旧实例 close() 报错：${failure.message}`);
    if (batch.items.some((item) => item.action === "load" && item.outcome?.application === "applied")) {
      lines.push("生效的插件的工具已经在工具清单里，可以直接调用来验证。");
    }
    return lines.join("\n");
  }

  return {
    /** Agent 的 plugin 工具提出 load、unload：记进这次运行的批次，返回给模型的文字。 */
    request(input: PluginToolRequest, origin: PluginRequestOrigin, peer: P | undefined): string {
      if (!origin.direct) {
        throw new RepaFault("plugin_request_not_direct", "只有使用者直接对话的会话能提出装卸；子 Agent 与后台任务的运行结束以后没有人接着处理结果");
      }
      const space = host.current();
      if (space === undefined) throw new RepaFault("space_not_open", "空间没有打开");
      checkIds(space, input.action, input.ids);
      let batch = open.get(origin.runId);
      if (batch === undefined) {
        batch = {
          id: randomUUID(),
          root: space.root,
          opened: space.opened,
          origin: { kind: "agent", sessionId: origin.sessionId, runId: origin.runId, peer, since: clock, fullAccess: true },
          items: [],
          stage: "requested",
          controller: new AbortController(),
          executing: false,
          handingBack: false,
          done: false,
        };
        open.set(origin.runId, batch);
      }
      if (batch.origin.kind === "agent" && !host.fullAccess()) batch.origin.fullAccess = false;
      addItems(batch, input.action, input.ids, input.from ?? "folder");
      setStage(batch, "requested");
      const verb = input.action === "load" ? "加载" : "卸载";
      return `已记下请求 ${batch.id}：${verb} ${input.ids.join("、")}。本次运行结束后处理，需要批准的会请使用者批准；处理完以后结果交回这个会话。不要等待，也不要重复提出。`;
    },
    /** 插件列表发起的加载或卸载：自成一批，排进队列，返回请求编号。 */
    submit(action: "load" | "unload", ids: string[], from: LoadFrom, peer: P): string {
      const space = host.current();
      if (space === undefined) throw new RepaFault("space_not_open", "请先打开空间");
      checkIds(space, action, ids);
      const batch: Batch<P> = {
        id: randomUUID(),
        root: space.root,
        opened: space.opened,
        origin: { kind: "list", peer },
        items: [],
        stage: "queued",
        controller: new AbortController(),
        executing: false,
        handingBack: false,
        done: false,
      };
      addItems(batch, action, ids, from);
      enqueue(batch);
      return batch.id;
    },
    /**
     * 撤回一批还没开始重组的请求。还没轮到的批次当即以撤回结束；Agent 的批次仍按次序经过队列，轮到时把撤回的结果交回会话。
     * 正在经过各段的批次由它自己在下一个检查点结束。
     */
    cancel(requestId: string): void {
      const batch = [...open.values(), ...queue, ...(processing === undefined ? [] : [processing])].find((item) => item.id === requestId);
      if (batch === undefined || batch.controller.signal.aborted) throw new RepaFault("plugin_request_not_found", "请求不存在或已经结束", { requestId });
      if (batch.executing || batch.done) throw new RepaFault("plugin_request_not_cancellable", "请求已经开始重组，不能撤回", { requestId });
      if (batch.handingBack) throw new RepaFault("plugin_request_not_cancellable", "请求的各项已有结局，正在把结果交回会话", { requestId });
      const stopped = withdrawn();
      batch.controller.abort(stopped);
      if (batch.origin.kind === "agent" && open.get(batch.origin.runId) === batch) {
        open.delete(batch.origin.runId);
        stop(batch, stopped);
        enqueue(batch);
      } else if (queue.includes(batch)) {
        stop(batch, stopped);
        if (batch.origin.kind === "list") queue.splice(queue.indexOf(batch), 1);
        host.updated();
      }
    },
    /** 一次运行结束：这次运行的批次封口，排进队列。 */
    runEnded(runId: string, status: "completed" | "failed" | "aborted"): void {
      const batch = open.get(runId);
      if (batch === undefined || batch.origin.kind !== "agent") return;
      open.delete(runId);
      batch.origin.status = status;
      enqueue(batch);
    },
    /**
     * 使用者在会话里发消息、插话、追问、停止、压缩或分支：请求到达时登记，此前提出的装卸不再自动续跑。
     * 会话里开始一次新的运行也登记：请求提出之前到达、排在提出请求的运行之后的消息，同样使续跑不再接着进行。
     */
    intervene(sessionId: string): void {
      sessionMarks.set(sessionId, ++clock);
    },
    /** 使用者关闭、切换或新建空间：请求到达时登记。 */
    interveneSpace(): void {
      spaceMark = ++clock;
    },
    /** 空间关闭：这个空间的批次全部撤回；正在批准的确认随之结束。 */
    closeSpace(): void {
      const stopped = spaceChanged();
      for (const batch of [...open.values(), ...queue]) {
        batch.controller.abort(stopped);
        stop(batch, stopped);
      }
      open.clear();
      queue.length = 0;
      host.updated();
      if (processing !== undefined && !processing.executing) processing.controller.abort(stopped);
      // 此后只有正在重组的批次还会交回，空间关闭已经登记在 spaceMark 上；会话的介入记号不再需要。
      sessionMarks.clear();
    },
    /** 插件列表加上请求状态；有请求状态而列表里没有的 id（例如文件夹不存在）也列出。 */
    merge(root: string, list: PluginInfo[]): PluginInfo[] {
      const map = states.get(root);
      if (map === undefined) return list;
      const seen = new Set(list.map((plugin) => plugin.id));
      const merged = list.map((plugin) => {
        const request = map.get(plugin.id);
        return request === undefined ? plugin : { ...plugin, request };
      });
      for (const [id, request] of map) {
        if (!seen.has(id)) merged.push({ id, source: "space", state: "disabled", pages: [], methods: [], tools: [], request });
      }
      return merged.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    },
  };
}

export type PluginRequests<P> = ReturnType<typeof createPluginRequests<P>>;
