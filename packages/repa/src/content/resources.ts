import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, unlinkSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { RepaFault } from "../errors.js";
import { IdSchema, object, literals } from "../schema.js";
import { writeJsonSync } from "../storage/atomic.js";
import type { BlobStore } from "../storage/blobs.js";
import { ResourceHoldSchema, type ContentSnapshot, type ResourceHold, type ResourcePreparation, type ResourceRef } from "./schema.js";

const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const leaseSchema = object({ host: IdSchema, kind: literals(["preparation", "hold", "released"]),
  requestHash: Type.String(), hold: ResourceHoldSchema });
type Lease = Static<typeof leaseSchema>;
const stateSchema = object({ version: Type.Literal(1),
  owners: Type.Record(Type.String(), Type.Array(hash)), leases: Type.Record(IdSchema, leaseSchema) });

export interface ResourceRetentionOptions {
  now?: () => number;
  preparationTtlMs?: number;
  holdTtlMs?: number;
}

/** 字节由 BlobStore 持有；这里持有独立业务消费者和有期限的前端使用关系。 */
export class ResourceRetention {
  #owners = new Map<string, string[]>();
  #leases = new Map<string, Lease>();
  readonly #activeHosts = new Set<string>();
  readonly #closedHosts = new Set<string>();
  readonly #hostEpochs = new Map<string, number>();
  readonly #now: () => number;
  readonly #preparationTtl: number;
  readonly #holdTtl: number;
  constructor(readonly spaceId: string, readonly blobs: BlobStore, readonly file: string, options: ResourceRetentionOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#preparationTtl = options.preparationTtlMs ?? 10 * 60 * 1000;
    this.#holdTtl = options.holdTtlMs ?? 60 * 60 * 1000;
    for (const ttl of [this.#preparationTtl, this.#holdTtl])
      if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("资源保留期限必须为正数。");
    try {
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!Check(stateSchema, raw)) throw new RepaFault("invalid_storage", "资源保留记录无法解析，原文件保持不变。");
      this.#owners = new Map(Object.entries(raw.owners));
      this.#leases = new Map(Object.entries(raw.leases));
      for (const [id, lease] of this.#leases) {
        if (lease.hold.id !== id || lease.hold.spaceId !== spaceId || lease.hold.resources.some(ref => ref.spaceId !== spaceId))
          throw new RepaFault("invalid_storage", "资源保留记录的所属空间或标识无效。");
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  #save(owners = this.#owners, leases = this.#leases): void {
    const state = { version: 1, owners: Object.fromEntries(owners), leases: Object.fromEntries(leases) };
    if (!Check(stateSchema, state)) throw new RepaFault("invalid_storage", "资源保留记录无效。");
    writeJsonSync(this.file, state);
    this.#owners = owners; this.#leases = leases;
  }
  validate(refs: readonly ResourceRef[]): void {
    for (const ref of refs) {
      if (ref.spaceId !== this.spaceId) throw new RepaFault("permission_required", "资源不属于当前空间。");
      this.blobs.getSync(ref.id);
    }
  }
  retain(owner: string, refs: readonly ResourceRef[]): void {
    this.validate(refs);
    const values = [...new Set(refs.map(ref => ref.id))].sort();
    if (JSON.stringify(this.#owners.get(owner) ?? []) === JSON.stringify(values)) return;
    const next = new Map(this.#owners);
    if (values.length) next.set(owner, values); else next.delete(owner);
    this.#save(next);
  }
  pinBytes(owner: string, mediaType: string, bytes: Uint8Array): ResourceRef {
    const id = this.blobs.putSync(bytes);
    const refs = this.#owners.get(owner) ?? [];
    if (!refs.includes(id)) this.#save(new Map(this.#owners).set(owner, [...refs, id].sort()));
    return { spaceId: this.spaceId, id, mediaType };
  }
  releaseOwner(owner: string): void {
    if (!this.#owners.has(owner)) return;
    const next = new Map(this.#owners); next.delete(owner); this.#save(next);
  }
  reconcileOwners(prefix: string, existing: ReadonlySet<string>): void {
    const next = new Map(this.#owners);
    for (const key of next.keys()) if (key.startsWith(prefix) && !existing.has(key.slice(prefix.length))) next.delete(key);
    if (next.size !== this.#owners.size) this.#save(next);
  }
  epoch(host: string): number { return this.#hostEpochs.get(host) ?? 0; }
  #assertUse(host: string, epoch: number): void {
    if (this.#closedHosts.has(host) || epoch !== this.epoch(host)) throw new RepaFault("closed", "该前端宿主的使用已经结束。");
  }
  prepare(host: string, resource: ResourceRef, epoch = this.epoch(host)): ResourcePreparation {
    this.#assertUse(host, epoch);
    this.validate([resource]);
    const id = randomUUID(), expiresAt = this.#now() + this.#preparationTtl;
    this.#save(this.#owners, new Map(this.#leases).set(id, {
      host, kind: "preparation", requestHash: "", hold: { id, spaceId: this.spaceId, expiresAt, contents: [], resources: [resource] },
    }));
    return { id, resource, expiresAt };
  }
  previous(host: string, id: string, requestHash: string): ResourceHold | undefined {
    const lease = this.#leases.get(id);
    if (!lease) return undefined;
    this.#checkOwner(lease, host);
    if (lease.requestHash !== requestHash) throw new RepaFault("request_conflict", "相同持有标识已用于另一份输入。");
    if (lease.kind !== "hold") throw new RepaFault("lease_expired", "该资源使用已经结束，请重新取得所需版本。", { id });
    return this.renew(host, id);
  }
  hold(host: string, id: string, requestHash: string, contents: ContentSnapshot[], refs: ResourceRef[], epoch = this.epoch(host)): ResourceHold {
    this.#assertUse(host, epoch);
    const previous = this.previous(host, id, requestHash);
    if (previous) return previous;
    this.validate(refs);
    const resources = [...new Map(refs.map(ref => [ref.id, ref])).values()];
    const hold = { id, spaceId: this.spaceId, expiresAt: this.#now() + this.#holdTtl, contents, resources };
    this.#save(this.#owners, new Map(this.#leases).set(id, { host, requestHash, kind: "hold", hold: structuredClone(hold) }));
    return structuredClone(hold);
  }
  get(host: string, id: string): ResourceHold {
    const lease = this.#leases.get(id);
    if (!lease) throw new RepaFault("lease_expired", "资源使用记录已不可确认，请重新取得所需版本。", { id });
    this.#checkOwner(lease, host);
    if (lease.kind !== "hold" || (lease.hold.expiresAt <= this.#now() && !this.#activeHosts.has(host)))
      throw new RepaFault("lease_expired", "资源使用期限已结束。", { id });
    return structuredClone(lease.hold);
  }
  renew(host: string, id: string): ResourceHold {
    const lease = this.#leases.get(id);
    if (!lease || lease.kind !== "hold") throw new RepaFault("lease_expired", "资源使用已经结束。", { id });
    this.#checkOwner(lease, host);
    this.validate(lease.hold.resources);
    const next = { ...lease, hold: { ...lease.hold, expiresAt: this.#now() + this.#holdTtl } };
    this.#save(this.#owners, new Map(this.#leases).set(id, next));
    return structuredClone(next.hold);
  }
  release(host: string, id: string): void {
    const lease = this.#leases.get(id);
    if (!lease) return;
    this.#checkOwner(lease, host);
    if (lease.kind === "released") return;
    this.#save(this.#owners, new Map(this.#leases).set(id, {
      ...lease, kind: "released", hold: { ...lease.hold, contents: [], resources: [] },
    }));
  }
  #checkOwner(lease: Lease, host: string): void {
    if (lease.host !== host) throw new RepaFault("permission_required", "不能操作其他前端实例持有的资源。");
  }
  setHostActive(host: string, active: boolean): void {
    if (active) { this.#activeHosts.add(host); this.#closedHosts.delete(host); }
    else this.#activeHosts.delete(host);
  }
  releaseHost(host: string): void {
    const next = new Map(this.#leases);
    for (const [id, lease] of next) if (lease.host === host) {
      if (lease.kind === "preparation") next.delete(id);
      else next.set(id, { ...lease, kind: "released", hold: { ...lease.hold, contents: [], resources: [] } });
    }
    this.#activeHosts.delete(host);
    this.#closedHosts.add(host);
    this.#hostEpochs.set(host, this.epoch(host) + 1);
    this.#save(this.#owners, next);
  }
  checkpoint(): void {
    const next = new Map(this.#leases), now = this.#now(); let changed = false;
    for (const [id, lease] of next) if (lease.kind === "hold" && this.#activeHosts.has(lease.host) && lease.hold.expiresAt - now < this.#holdTtl / 2) {
      next.set(id, { ...lease, hold: { ...lease.hold, expiresAt: now + this.#holdTtl } }); changed = true;
    }
    if (changed) this.#save(this.#owners, next);
  }
  #roots(): Set<string> {
    const roots = new Set([...this.#owners.values()].flat()), now = this.#now();
    for (const lease of this.#leases.values())
      if (lease.kind !== "released" && (lease.hold.expiresAt > now || (lease.kind === "hold" && this.#activeHosts.has(lease.host))))
        for (const ref of lease.hold.resources) roots.add(ref.id);
    return roots;
  }
  snapshot(): { state: { version: 1; owners: Record<string, string[]>; leases: Record<string, never> }; roots: Set<string> } {
    return { state: { version: 1, owners: structuredClone(Object.fromEntries(this.#owners)), leases: {} }, roots: this.#roots() };
  }
  /** 调用者持有内容队列；同步消息投影的保留关系在每次删除前重新核对。 */
  async collect(contentRoots: ReadonlySet<string>): Promise<{ removed: number; bytes: number }> {
    let removed = 0, bytes = 0;
    const names = await readdir(this.blobs.directory);
    // 此后删除循环没有 await；同步消息投影不会在标记和删除之间插入新的持有。
    const roots = this.#roots();
    for (const name of names) {
      if (!/^[a-f0-9]{64}$/.test(name) || contentRoots.has(name) || roots.has(name)) continue;
      const file = path.join(this.blobs.directory, name);
      try {
        const stat = lstatSync(file);
        if (!stat.isFile()) throw new RepaFault("invalid_storage", "资源目录包含非普通文件。", { id: name });
        unlinkSync(file); removed++; bytes += stat.size;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const next = new Map(this.#leases);
    for (const [id, lease] of next) if (lease.hold.expiresAt <= this.#now() && (lease.kind !== "hold" || !this.#activeHosts.has(lease.host))) {
      if (lease.kind === "preparation") next.delete(id);
      else if (lease.kind === "hold") next.set(id, { ...lease, kind: "released", hold: { ...lease.hold, contents: [], resources: [] } });
    }
    if (JSON.stringify([...next]) !== JSON.stringify([...this.#leases])) this.#save(this.#owners, next);
    return { removed, bytes };
  }
}
