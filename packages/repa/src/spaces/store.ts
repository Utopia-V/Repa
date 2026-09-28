import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { RepaFault } from "../errors.js";
import { IdSchema, object } from "../schema.js";
import { type ContentStore, canonicalJson } from "../content/store.js";
import { digest } from "../storage/blobs.js";
import { syncDirectory, writeJson } from "../storage/atomic.js";
import { readRunJournal, appendRunRecord } from "../run-journal.js";
import { copyTree, relativePath, scanTree, syncTree, TreeEntrySchema, validateTree, within } from "./files.js";
import { SpaceOperationSchema, type SpaceOperation, type SpaceSnapshotParticipant } from "./schema.js";

const manifestName = ".repa-snapshot.json";
const markerName = ".repa-space-operation.json";
const receiptSchema = object({ format: Type.Literal("repa.space-operation"), version: Type.Literal(1),
  source: Type.String(), requestHash: Type.String({ pattern: "^[a-f0-9]{64}$" }), result: SpaceOperationSchema });
type Receipt = Static<typeof receiptSchema>;
const manifestSchema = object({ format: Type.Literal("repa.space-snapshot"), version: Type.Literal(1),
  result: SpaceOperationSchema, entries: Type.Array(TreeEntrySchema) });

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function json(file: string): Promise<unknown> { return JSON.parse(await readFile(file, "utf8")); }
async function readReceipt(file: string): Promise<Receipt | undefined> {
  if (!await exists(file)) return;
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new RepaFault("invalid_storage", "空间操作记录必须是普通文件。");
  const raw = await json(file);
  if (!Check(receiptSchema, raw)) throw new RepaFault("invalid_storage", "空间操作记录无法解析。");
  return raw;
}
const fault = (error: unknown) => ({ code: error instanceof RepaFault ? error.code : "storage", message: error instanceof Error ? error.message : String(error) });

/** 空间目录的准备、发布与结果恢复；内容和数据库格式仍由各自 owner 解释。 */
export class SpaceOperations {
  readonly #running = new Map<string, { hash: string; promise: Promise<SpaceOperation> }>();
  constructor(readonly directory: string) {}
  async #locked<T>(file: string, action: (assertOwned: () => void) => Promise<T>): Promise<T> {
    let compromised: Error | undefined;
    let unlock: () => Promise<void>;
    try { unlock = await lockfile.lock(file, { realpath: false, onCompromised: error => { compromised = error; } }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new RepaFault("operation_busy", "该空间操作或目标位置正由另一个操作持有。");
      throw error;
    }
    try { return await action(() => { if (compromised) throw new RepaFault("space_lock_lost", "空间操作的独占访问已经结束。"); }); }
    finally { if (!compromised) await unlock(); }
  }
  #receiptPath(id: string): string {
    if (!Check(IdSchema, id)) throw new RepaFault("invalid_input", "空间操作标识无效。");
    return path.join(this.directory, `${id}.json`);
  }
  #stage(receipt: Receipt): string {
    return path.join(path.dirname(receipt.result.destination), `.repa-space-${receipt.result.operationId}-${receipt.requestHash.slice(0, 16)}.tmp`);
  }
  async #ownedStage(receipt: Receipt): Promise<boolean> {
    const stage = this.#stage(receipt);
    if (!await exists(stage)) return false;
    const stat = await lstat(stage);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const marker = await readReceipt(path.join(stage, markerName));
    return marker?.requestHash === receipt.requestHash && marker.result.operationId === receipt.result.operationId;
  }
  async #recover(receipt: Receipt): Promise<Receipt> {
    if (receipt.result.status !== "prepared") return receipt;
    const destination = receipt.result.destination;
    if (await exists(destination)) {
      const stat = await lstat(destination);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        const marker = await readReceipt(path.join(destination, markerName));
        if (marker?.requestHash === receipt.requestHash && marker.result.operationId === receipt.result.operationId && marker.result.status === "completed") {
          await writeJson(this.#receiptPath(receipt.result.operationId), marker); return marker;
        }
      }
    }
    if (await this.#ownedStage(receipt)) await rm(this.#stage(receipt), { recursive: true });
    const next: Receipt = { ...receipt, result: { ...receipt.result, status: "failed", error: { code: "interrupted", message: "空间操作在发布前中断，未自动重新执行。" } } };
    await writeJson(this.#receiptPath(receipt.result.operationId), next); return next;
  }
  async get(operationId: string): Promise<SpaceOperation | { operationId: string; status: "unknown" }> {
    const receipt = await readReceipt(this.#receiptPath(operationId));
    if (!receipt) return { operationId, status: "unknown" };
    if (this.#running.has(operationId) || receipt.result.status !== "prepared") return structuredClone(receipt.result);
    try {
      return await this.#locked(this.#receiptPath(operationId), async () => structuredClone((await this.#recover((await readReceipt(this.#receiptPath(operationId)))!)).result));
    } catch (error) { if (error instanceof RepaFault && error.code === "operation_busy") return structuredClone(receipt.result); throw error; }
  }
  async #start(input: { kind: SpaceOperation["kind"]; operationId: string; source: string; destination: string; spaceId: string },
    build: (stage: string, result: SpaceOperation) => Promise<void>): Promise<SpaceOperation> {
    const file = this.#receiptPath(input.operationId);
    const requestHash = digest(canonicalJson({ kind: input.kind, source: path.resolve(input.source), destination: path.resolve(input.destination), ...(input.kind === "restore" ? {} : { spaceId: input.spaceId }) }));
    const running = this.#running.get(input.operationId);
    if (running) {
      if (running.hash !== requestHash) throw new RepaFault("operation_id_conflict", "相同操作标识已经用于另一项空间操作。");
      return running.promise;
    }
    const work = async () => {
      await mkdir(this.directory, { recursive: true });
      return this.#locked(file, async assertOwned => {
        const previous = await readReceipt(file);
        if (previous) {
          if (previous.requestHash !== requestHash) throw new RepaFault("operation_id_conflict", "相同操作标识已经用于另一项空间操作。");
          return structuredClone((await this.#recover(previous)).result);
        }
        const source = await realpath(input.source);
        const parent = await realpath(path.dirname(path.resolve(input.destination)));
        const destination = path.join(parent, path.basename(path.resolve(input.destination)));
        if (within(source, destination)) throw new RepaFault("invalid_input", "快照或副本的目标目录必须位于源目录之外。");
        return this.#locked(destination, async assertDestinationOwned => {
          if (await exists(destination)) throw new RepaFault("destination_exists", "目标位置已存在，请使用新目录。");
          const result: SpaceOperation = { operationId: input.operationId, kind: input.kind, status: "prepared",
            spaceId: input.kind === "copy" ? randomUUID() : input.spaceId, destination, participants: [], externalDependencies: [] };
          const receipt: Receipt = { format: "repa.space-operation", version: 1, requestHash, source, result };
          const stage = this.#stage(receipt);
          if (await exists(stage)) throw new RepaFault("destination_exists", "空间操作的准备目录已存在，需先核对原操作。");
          await writeJson(file, receipt);
          let published = false;
          try {
            await mkdir(stage, { mode: 0o700 });
            await writeJson(path.join(stage, markerName), receipt);
            await build(stage, result);
            const entries = await scanTree(stage, file => file !== markerName);
            await syncTree(stage, entries);
            result.status = "completed";
            await writeJson(path.join(stage, markerName), receipt);
            assertOwned(); assertDestinationOwned();
            if (await realpath(parent) !== parent || await exists(destination)) throw new RepaFault("destination_exists", "目标位置在准备期间发生了变化。");
            await rename(stage, destination); published = true;
            await syncDirectory(parent);
            await writeJson(file, receipt);
            return structuredClone(result);
          } catch (error) {
            if (published) throw new RepaFault("result_unconfirmed", "目录已经发布，请通过 space.operation.get 确认结果。", { operationId: result.operationId });
            if (await this.#ownedStage(receipt)) await rm(stage, { recursive: true });
            result.status = "failed"; result.error = fault(error);
            await writeJson(file, receipt); return structuredClone(result);
          }
        });
      });
    };
    const promise = work(); this.#running.set(input.operationId, { hash: requestHash, promise });
    try { return await promise; } finally { this.#running.delete(input.operationId); }
  }
  capture(input: { kind: "backup" | "copy"; operationId: string; spaceId: string; source: string; destination: string },
    content: ContentStore, participants: readonly SpaceSnapshotParticipant[]): Promise<SpaceOperation> {
    return this.#start(input, async (stage, result) => {
      const owners = [...participants];
      for (let i = 0; i < owners.length; i++) {
        const owner = owners[i]!; relativePath(owner.directory);
        if (!Check(IdSchema, owner.id) || !owner.version || !owner.directory.startsWith(".repa/") ||
          ["content", "runtime", "sessions", "settings.json"].some(name => within(path.resolve(".repa", name), path.resolve(owner.directory))) ||
          owners.slice(0, i).some(other => other.id === owner.id || within(path.resolve(other.directory), path.resolve(owner.directory)) || within(path.resolve(owner.directory), path.resolve(other.directory))))
          throw new RepaFault("invalid_snapshot_owner", "持久数据 owner 的标识或目录重叠。");
      }
      const include = (file: string): boolean => {
        if (file === markerName || file === manifestName || file === ".repa/content" || file === ".repa/runtime/owner.lock" || file === ".repa/settings.json.lock" || /^\.repa-.*\.tmp$/.test(path.posix.basename(file))) return false;
        if (owners.some(owner => file === owner.directory)) return false;
        if (file.startsWith(".repa/") && ![".repa/runtime", ".repa/sessions", ".repa/settings.json"].some(root => file === root || file.startsWith(`${root}/`)) &&
          !owners.some(owner => owner.directory.startsWith(`${file}/`)))
          throw new RepaFault("snapshot_owner_unavailable", "该持久数据目录尚无快照 owner。", { path: file });
        return true;
      };
      const before = await scanTree(input.source, include);
      const data = input.kind === "backup" ? path.join(stage, "data") : stage;
      await copyTree(input.source, data, before);
      result.externalDependencies = await content.capture(data, result.spaceId);
      for (const owner of owners) {
        const sourceDirectory = path.join(input.source, owner.directory);
        if (!await exists(sourceDirectory)) continue;
        if (await realpath(sourceDirectory) !== sourceDirectory || !(await lstat(sourceDirectory)).isDirectory())
          throw new RepaFault("invalid_snapshot_owner", "持久数据 owner 的目录位置无效。");
        const destinationDirectory = path.join(data, owner.directory);
        await mkdir(destinationDirectory, { recursive: true });
        await owner.capture({ sourceDirectory, destinationDirectory, sourceSpaceId: input.spaceId, targetSpaceId: result.spaceId, mode: input.kind });
        result.participants.push({ id: owner.id, version: owner.version, directory: owner.directory });
      }
      if (input.kind === "copy") {
        await writeJson(path.join(data, ".repa/runtime/space.json"), { id: result.spaceId, copiedFrom: input.spaceId });
        const runFile = path.join(data, ".repa/runtime/runs.jsonl");
        const records = readRunJournal(runFile, input.spaceId);
        await rm(runFile, { force: true });
        for (const record of records) appendRunRecord(runFile, { ...record, request: { ...record.request, spaceId: result.spaceId } });
      }
      if (canonicalJson(await scanTree(input.source, include)) !== canonicalJson(before))
        throw new RepaFault("revision_conflict", "快照期间外部编辑改变了空间文件，请重新取得快照。");
      const modes = new Map(before.map(entry => [entry.path, entry.mode]));
      const entries = (await scanTree(data, file => file !== markerName)).map(entry => ({ ...entry, mode: modes.get(entry.path) ?? entry.mode }));
      await syncTree(data, entries);
      content.options.assertOwned();
      if (input.kind === "backup") await writeJson(path.join(stage, manifestName), { format: "repa.space-snapshot", version: 1, result: { ...result, status: "completed" }, entries });
    });
  }
  async restore(input: { operationId: string; source: string; destination: string }): Promise<SpaceOperation> {
    const previous = await readReceipt(this.#receiptPath(input.operationId));
    if (previous || this.#running.has(input.operationId))
      return this.#start({ ...input, kind: "restore", spaceId: previous?.result.spaceId ?? "pending" }, async () => {});
    const source = await realpath(input.source);
    const raw = await json(path.join(source, manifestName));
    if (!Check(manifestSchema, raw)) throw new RepaFault("unsupported_snapshot", "不支持该空间快照的格式或版本。");
    validateTree(raw.entries);
    return this.#start({ ...input, kind: "restore", spaceId: raw.result.spaceId }, async (stage, result) => {
      const data = path.join(source, "data");
      if (await realpath(data) !== data || !(await lstat(data)).isDirectory()) throw new RepaFault("invalid_snapshot", "快照数据目录无效。");
      if (canonicalJson(await scanTree(data)) !== canonicalJson(raw.entries)) throw new RepaFault("invalid_snapshot", "空间快照的文件或校验值不一致。");
      await copyTree(data, stage, raw.entries);
      const identity = await json(path.join(stage, ".repa/runtime/space.json"));
      if (!identity || typeof identity !== "object" || !("id" in identity) || identity.id !== raw.result.spaceId)
        throw new RepaFault("invalid_snapshot", "快照中的空间身份不一致。");
      result.participants = raw.result.participants;
      result.externalDependencies = raw.result.externalDependencies;
      await syncTree(stage, raw.entries);
    });
  }
}
