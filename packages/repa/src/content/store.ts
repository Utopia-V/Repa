import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { Check } from "typebox/value";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { RepaFault } from "../errors.js";
import { IdSchema } from "../schema.js";
import { SerialQueue } from "../storage/atomic.js";
import { BlobStore, digest } from "../storage/blobs.js";
import { managedDirectory } from "../storage/managed-directory.js";
import { FileJournal, sameImage, type FileImage, type FileMutation } from "./journal.js";
import { parsePatch, applyTextPatch } from "./patch.js";
import { editText, revertText, type TextEdit } from "./text-edits.js";
import { CatalogSchema, catalogPath, emptyCatalog, type Catalog, type ContentRecord } from "./catalog.js";
import { captureContent } from "./snapshot.js";
import { ResourceRetention, type ResourceRetentionOptions } from "./resources.js";
import { mapReference, remapContextComposition, remapMarkdown } from "./references.js";
import {
  ContextCompositionSchema,
  type ContentInfo, type ContentRead, type ContentRef, type ContentTarget,
  type ContentValue, type ContentChangeResult, type ContentOperation,
  type ContextBinding, type ContextState, type ContextView, type FileLocation,
  type ResourceRef, type WriteBase, type ContentSnapshot, type ResourceHold,
} from "./schema.js";

const absent: FileImage = { kind: "absent" };
const clone = <T>(value: T): T => structuredClone(value);
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
const equal = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const inside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

export function mediaType(file: string): string {
  const types: Record<string, string> = {
    ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json",
    ".html": "text/html", ".htm": "text/html", ".css": "text/css",
    ".js": "text/javascript", ".ts": "text/plain", ".tsx": "text/plain", ".jsx": "text/plain",
    ".py": "text/plain", ".rs": "text/plain", ".c": "text/plain", ".h": "text/plain",
    ".cpp": "text/plain", ".v": "text/plain", ".sv": "text/plain", ".csv": "text/csv",
    ".svg": "image/svg+xml", ".pdf": "application/pdf", ".png": "image/png",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  };
  return types[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

interface Observed { path: string; image: FileImage; record?: ContentRecord }
interface Plan {
  catalog: Catalog;
  before: Catalog;
  files: Map<string, FileMutation>;
  seen: Map<string, FileImage>;
  affected: Set<string>;
}
export interface TransferInput {
  target: ContentTarget;
  destination: FileLocation;
  base: string;
  operationId: string;
  container?: boolean;
}
export interface ContentStoreOptions extends ResourceRetentionOptions {
  spaceId: string;
  root: string;
  assertOwned(): void;
  canReadExternal?(path: string): boolean;
  onChange?(result: ContentChangeResult): void;
}

/** 空间中的内容身份、实际文件、保存与恢复共用这个入口。 */
export class ContentStore {
  readonly blobs: BlobStore;
  readonly journal: FileJournal;
  readonly retention: ResourceRetention;
  readonly queue = new SerialQueue();
  #catalog = emptyCatalog();
  #catalogHash: string | null = null;
  private constructor(readonly options: ContentStoreOptions, directory: string) {
    this.blobs = new BlobStore(path.join(directory, "blobs"));
    this.journal = new FileJournal(options.root, path.join(directory, "operations"), this.blobs);
    this.retention = new ResourceRetention(options.spaceId, this.blobs, path.join(directory, "resources.json"), options);
  }
  static async open(options: ContentStoreOptions): Promise<ContentStore> {
    const directory = managedDirectory(options.root, "content");
    managedDirectory(options.root, "content", "blobs");
    managedDirectory(options.root, "content", "operations");
    const store = new ContentStore(options, directory);
    await store.blobs.open();
    await store.journal.open();
    await store.#reload();
    return store;
  }

  target(file: string): ContentTarget {
    const ref = /^repa:(?:document|material)\/([a-zA-Z0-9_-]+)$/.exec(file);
    if (ref) return { kind: "content", ref: { spaceId: this.options.spaceId, id: ref[1]! } };
    const absolute = path.resolve(this.options.root, file);
    return { kind: "file", spaceId: this.options.spaceId, location: this.#location(absolute) };
  }
  #location(absolute: string): FileLocation {
    return inside(this.options.root, absolute)
      ? { kind: "relative", path: path.relative(this.options.root, absolute).split(path.sep).join("/") || "." }
      : { kind: "external", path: absolute };
  }
  #absolute(location: FileLocation): string {
    if (location.kind === "external" && !path.isAbsolute(location.path))
      throw new RepaFault("invalid_input", "外部文件必须使用绝对路径。");
    const absolute = path.resolve(this.options.root, location.path);
    if (location.kind === "relative" && !inside(this.options.root, absolute))
      throw new RepaFault("permission_required", "相对位置超出了当前空间。");
    return absolute;
  }
  async #canonical(absolute: string): Promise<string> {
    let probe = absolute;
    const missing: string[] = [];
    for (;;) {
      try { return path.join(await realpath(probe), ...missing); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        missing.unshift(path.basename(probe));
        const parent = path.dirname(probe);
        if (parent === probe) throw error;
        probe = parent;
      }
    }
  }
  async #checkPath(absolute: string, write: boolean, extraReadRoots: readonly string[] = []): Promise<string> {
    const actual = await this.#canonical(absolute);
    if (inside(this.options.root, actual)) {
      const relative = path.relative(this.options.root, actual);
      if (relative.split(path.sep)[0] === ".repa")
        throw new RepaFault("permission_required", "应用管理状态通过所属模块访问。", { path: relative });
      return actual;
    }
    if (!write && (this.options.canReadExternal?.(actual) || extraReadRoots.some((root) => inside(root, actual))))
      return actual;
    throw new RepaFault("permission_required", write ? "尚未允许修改这个空间外文件。" : "尚未允许读取这个空间外文件。", { path: actual });
  }
  #record(target: ContentTarget, catalog: Catalog): ContentRecord | undefined {
    if (target.kind === "content") {
      if (target.ref.spaceId !== this.options.spaceId) throw new RepaFault("invalid_input", "内容不属于当前空间。");
      const record = Object.hasOwn(catalog.items, target.ref.id) ? catalog.items[target.ref.id] : undefined;
      if (!record) throw new RepaFault("not_found", "内容身份不存在。");
      return record;
    }
    if (target.spaceId !== this.options.spaceId) throw new RepaFault("invalid_input", "文件不属于当前空间。");
    const absolute = this.#absolute(target.location);
    return Object.values(catalog.items).find((item) => item.state === "active" && this.#absolute(item.location) === absolute);
  }
  #validateCatalog(catalog: Catalog): void {
    const occupied = new Map<string, string>();
    for (const record of Object.values(catalog.items)) {
      const location = this.#absolute(record.location);
      if (record.state === "active") {
        const previous = occupied.get(location);
        if (previous !== undefined && previous !== record.id)
          throw new RepaFault("revision_conflict", "同一位置已由另一个内容身份占用。", { ids: [previous, record.id], location: record.location });
        occupied.set(location, record.id);
      }
      for (const member of record.members) {
        if (member.target.kind === "content") this.#record(member.target, catalog);
        else this.#absolute(member.target.location);
      }
    }
    if (catalog.context) this.#record({ kind: "content", ref: catalog.context.ref }, catalog);
  }
  async #observe(target: ContentTarget, catalog = this.#catalog, extraReadRoots: readonly string[] = []): Promise<Observed> {
    const record = this.#record(target, catalog);
    const location = target.kind === "content" ? record!.location : target.location;
    const absolute = this.#absolute(location);
    if (record && record.state !== "active") return { path: absolute, image: absent, record };
    const actual = await this.#checkPath(absolute, false, extraReadRoots);
    let image: FileImage;
    if (inside(this.options.root, actual) && actual !== this.options.root)
      image = await this.journal.image(path.relative(this.options.root, actual));
    else {
      try {
        const stat = await lstat(actual);
        if (stat.isDirectory()) image = { kind: "directory", mode: stat.mode & 0o777 };
        else if (stat.isFile()) image = { kind: "file", hash: await this.blobs.put(await readFile(actual)), mode: stat.mode & 0o777 };
        else throw new RepaFault("unsupported_content", "目标不是普通文件。");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        image = absent;
      }
    }
    const actualRecord = record ?? Object.values(catalog.items).find((item) => item.state === "active" && this.#absolute(item.location) === actual);
    return { path: actual, image, ...(actualRecord ? { record: actualRecord } : {}) };
  }
  #blocked(absolute: string, id?: string): boolean {
    const relative = path.relative(this.options.root, absolute);
    return [...this.journal.entries.values()].some((entry) => entry.status === "needs_recovery" &&
      ((id !== undefined && entry.affectedIds.includes(id)) || entry.files.some((file) => file.path === relative)));
  }
  #revision(observed: Observed): string | null {
    if (observed.image.kind === "absent" && !observed.record) return null;
    return digest(canonicalJson(observed.record ?? { image: observed.image, location: this.#location(observed.path) }));
  }
  async #info(observed: Observed): Promise<ContentInfo> {
    const { record, image } = observed;
    const location = this.#location(observed.path);
    const ref = record ? { spaceId: this.options.spaceId, id: record.id } : undefined;
    return {
      target: ref ? { kind: "content", ref } : { kind: "file", spaceId: this.options.spaceId, location },
      ...(ref ? { ref } : {}), location,
      ...(record ? { role: record.role } : {}),
      mediaType: record?.mediaType ?? mediaType(observed.path),
      revision: this.#revision(observed),
      bodyRevision: image.kind === "file" ? image.hash : null,
      ...(image.kind !== "absent" ? { fileType: image.kind } : {}),
      status: this.#blocked(observed.path, record?.id) ? "needs_recovery"
        : record?.state === "detached" ? "detached" : image.kind === "absent" ? "missing" : "available",
      ...(image.kind === "file" ? { size: (await this.blobs.get(image.hash)).length } : {}),
      members: clone(record?.members ?? []), resources: clone(record?.resources ?? []),
      ...(record?.origin ? { origin: clone(record.origin) } : {}),
    };
  }
  async #metadata(record: ContentRecord): Promise<ContentInfo> {
    const absolute = this.#absolute(record.location);
    const info = await this.#info({ path: absolute, image: absent, record });
    delete info.bodyRevision;
    if (record.state !== "active") return info;
    try {
      const actual = await this.#checkPath(absolute, false), stat = await lstat(actual);
      info.status = this.#blocked(actual, record.id) ? "needs_recovery" : "available";
      if (stat.isFile()) { info.size = stat.size; info.fileType = "file"; }
      else if (stat.isDirectory()) info.fileType = "directory";
    } catch (error) {
      if (error instanceof RepaFault && error.code === "permission_required") info.status = "permission_required";
      else if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return info;
  }
  #assertStructure(observed: Observed): void {
    if (this.#blocked(observed.path, observed.record?.id))
      throw new RepaFault("recovery_required", "该内容的位置或组成仍需恢复，请先检查实际文件。", { path: this.#location(observed.path) });
  }
  #checkBase(observed: Observed, base: WriteBase, body = false): void {
    const current = body ? observed.image.kind === "file" ? observed.image.hash : null : this.#revision(observed);
    if (typeof base === "object" ? observed.image.kind !== "absent" : current !== base)
      throw new RepaFault("revision_conflict", "内容已发生变化，请比较当前版本后保存。", { expected: base, actual: current });
  }
  async #reload(): Promise<void> {
    try {
      const bytes = await readFile(path.join(this.options.root, catalogPath), "utf8");
      const raw: unknown = JSON.parse(bytes);
      if (!Check(CatalogSchema, raw) || Object.entries(raw.items).some(([id, value]) => id !== value.id))
        throw new RepaFault("invalid_storage", "内容清单格式无效，原文件保持不变。");
      this.#catalog = raw;
      this.#catalogHash = digest(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.#catalog = emptyCatalog(); this.#catalogHash = null; }
      else throw error;
    }
  }

  get(target: ContentTarget): Promise<ContentInfo> {
    const input = clone(target);
    return this.queue.run(async () => {
      try { return await this.#info(await this.#observe(input)); }
      catch (error) {
        if (!(error instanceof RepaFault && error.code === "permission_required") || input.kind !== "content") throw error;
        const record = this.#record(input, this.#catalog)!;
        return { ...await this.#info({ path: this.#absolute(record.location), image: absent, record }), status: "permission_required" };
      }
    });
  }
  read(params: { target: ContentTarget; offset?: number; limit?: number; revision?: string }, host?: string): Promise<ContentRead> {
    const input = clone(params);
    const epoch = host ? this.retention.epoch(host) : undefined;
    return this.queue.run(async () => {
      const observed = await this.#observe(input.target);
      if (input.target.kind === "content") this.#assertStructure(observed);
      const content = await this.#info(observed);
      if (input.revision !== undefined && content.bodyRevision !== input.revision)
        throw new RepaFault("revision_conflict", "分页读取期间内容已改变。", { actual: content.bodyRevision });
      if (observed.image.kind !== "file") throw new RepaFault("not_found", "没有可读取的文件正文。");
      const bytes = await this.blobs.get(observed.image.hash);
      const resource: ResourceRef = { spaceId: this.options.spaceId, id: observed.image.hash, mediaType: content.mediaType };
      const prepared = host ? this.retention.prepare(host, resource, epoch) : undefined;
      const shared = { content, resource, ...(prepared ? { preparation: { id: prepared.id, expiresAt: prepared.expiresAt } } : {}) };
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        if (text.includes("\0")) return { ...shared, truncated: false };
      } catch { return { ...shared, truncated: false }; }
      if (content.mediaType === "application/pdf" || /^image\/(?!svg\+xml)/.test(content.mediaType)) return { ...shared, truncated: false };
      const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
      const offset = input.offset ?? 1;
      const limit = input.limit ?? DEFAULT_MAX_LINES;
      if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1 || offset > Math.max(1, lines.length))
        throw new RepaFault("invalid_input", "读取范围超出了文件正文。", { totalLines: lines.length });
      let end = offset - 1, size = 0;
      while (end < lines.length && end < offset - 1 + limit) {
        const bytes = Buffer.byteLength(lines[end]!);
        if (size + bytes > DEFAULT_MAX_BYTES) break;
        size += bytes; end++;
      }
      if (end === offset - 1 && end < lines.length)
        return { ...shared, offset, totalLines: lines.length, truncated: true };
      return { ...shared, text: lines.slice(offset - 1, end).join(""), offset,
        totalLines: lines.length, truncated: end < lines.length,
        ...(end < lines.length ? { nextOffset: end + 1 } : {}) };
    });
  }
  readForTool(file: string, extraReadRoots: readonly string[] = []): Promise<{ bytes: Buffer; content: ContentInfo }> {
    return this.queue.run(async () => {
      const observed = await this.#observe(this.target(file), this.#catalog, extraReadRoots);
      if (this.target(file).kind === "content") this.#assertStructure(observed);
      if (observed.image.kind !== "file") throw new RepaFault("not_found", "文件不可用。");
      return { bytes: await this.blobs.get(observed.image.hash), content: await this.#info(observed) };
    });
  }
  list(params: { path?: string } = {}): Promise<ContentInfo[]> {
    return this.queue.run(async () => {
      const directory = await this.#checkPath(path.resolve(this.options.root, params.path ?? "."), false);
      if (!inside(this.options.root, directory)) throw new RepaFault("permission_required", "只列举当前空间的目录。");
      const entries = await readdir(directory, { withFileTypes: true });
      const result: ContentInfo[] = [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === ".repa" || /^\.repa-.*\.tmp$/.test(entry.name)) continue;
        try {
          const actual = await this.#checkPath(path.join(directory, entry.name), false);
          const target = this.target(actual);
          const record = this.#record(target, this.#catalog);
          const stat = await lstat(actual);
          const ref = record ? { spaceId: this.options.spaceId, id: record.id } : undefined;
          result.push({ target: ref ? { kind: "content", ref } : target,
            ...(ref ? { ref } : {}), location: this.#location(actual),
            ...(record ? { role: record.role } : {}), mediaType: record?.mediaType ?? mediaType(actual),
            revision: null, status: this.#blocked(actual, record?.id) ? "needs_recovery" : "available",
            ...(stat.isFile() ? { fileType: "file" as const } : stat.isDirectory() ? { fileType: "directory" as const } : {}),
            ...(stat.isFile() ? { size: stat.size } : {}), members: clone(record?.members ?? []), resources: clone(record?.resources ?? []) });
        }
        catch (error) { if (!(error instanceof RepaFault && error.code === "permission_required")) throw error; }
      }
      // 空间根还展示外部材料；已登记但原件缺失的条目继续可定位、可重关联。
      const listed = new Set(result.flatMap((item) => item.ref ? [item.ref.id] : []));
      for (const record of Object.values(this.#catalog.items)) {
        if (record.state !== "active" || listed.has(record.id)) continue;
        const absolute = this.#absolute(record.location);
        const belongs = record.location.kind === "external" ? directory === this.options.root : path.dirname(absolute) === directory;
        if (!belongs) continue;
        const info = await this.#info({ path: absolute, image: absent, record });
        delete info.bodyRevision;
        try {
          const actual = await this.#checkPath(absolute, false);
          const stat = await lstat(actual);
          info.status = this.#blocked(actual, record.id) ? "needs_recovery" : "available";
          if (stat.isFile()) { info.size = stat.size; info.fileType = "file"; }
          else if (stat.isDirectory()) info.fileType = "directory";
        } catch (error) {
          if (error instanceof RepaFault && error.code === "permission_required") info.status = "permission_required";
          else if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        result.push(info);
      }
      return result;
    });
  }

  async #value(value: ContentValue): Promise<Buffer> {
    if (value.kind === "text") return Buffer.from(value.text);
    if (value.resource.spaceId !== this.options.spaceId) throw new RepaFault("invalid_input", "资源不属于当前空间。");
    return this.blobs.get(value.resource.id);
  }
  async #put(plan: Plan, absolute: string, image: FileImage, expected?: FileImage): Promise<void> {
    const actual = await this.#checkPath(absolute, true);
    const relative = path.relative(this.options.root, actual);
    const old = plan.files.get(relative);
    const before = old?.before ?? expected ?? await this.journal.image(relative);
    plan.files.set(relative, { path: relative, before, after: image });
    plan.seen.set(relative, before);
    for (const record of Object.values(plan.catalog.items))
      if (this.#absolute(record.location) === actual) plan.affected.add(record.id);
  }
  async #mutate(id: string, request: unknown, build: (plan: Plan) => Promise<void>): Promise<ContentChangeResult> {
    if (!Check(IdSchema, id)) throw new RepaFault("invalid_input", "操作标识无效。");
    const requestHash = digest(canonicalJson(request));
    return this.queue.run(async () => {
      this.options.assertOwned();
      const old = this.journal.previous(id, requestHash);
      if (old) return old;
      await this.#reload();
      const catalogHash = this.#catalogHash;
      const before = clone(this.#catalog);
      const plan: Plan = { catalog: clone(before), before, files: new Map(), seen: new Map(), affected: new Set() };
      await build(plan);
      this.#validateCatalog(plan.catalog);
      if (!equal(plan.catalog, before)) {
        const image = await this.journal.image(catalogPath);
        if ((image.kind === "file" ? image.hash : null) !== catalogHash)
          throw new RepaFault("revision_conflict", "内容清单在保存准备期间发生变化。");
        plan.files.set(catalogPath, { path: catalogPath, before: image,
          after: { kind: "file", hash: await this.blobs.put(`${JSON.stringify(plan.catalog, null, 2)}\n`), mode: 0o600 } });
      }
      const contents: ContentInfo[] = [];
      const observed = new Set<string>();
      for (const id of plan.affected) {
        const record = plan.catalog.items[id];
        if (!record) continue;
        const absolute = this.#absolute(record.location);
        const relative = path.relative(this.options.root, absolute);
        if (record.state === "active" && !plan.files.has(relative)) {
          contents.push(await this.#metadata(record));
          observed.add(absolute);
          continue;
        }
        const image = record.state !== "active" ? absent : plan.files.get(relative)?.after ?? (await this.#observe({ kind: "content", ref: { spaceId: this.options.spaceId, id } }, plan.catalog)).image;
        contents.push(await this.#info({ path: absolute, image, record }));
        if (record.state === "active") observed.add(absolute);
      }
      const changes: ContentChangeResult["changes"] = [];
      for (const file of plan.files.values()) {
        if (file.path === catalogPath) continue;
        const absolute = path.join(this.options.root, file.path);
        const newRecord = Object.values(plan.catalog.items).find((item) => item.state === "active" && this.#absolute(item.location) === absolute);
        if (!sameImage(file.before, file.after)) changes.push({ path: file.path.split(path.sep).join("/"),
          before: file.before.kind === "file" ? file.before.hash : null,
          after: file.after.kind === "file" ? file.after.hash : null });
        if (!observed.has(absolute)) contents.push(await this.#info({ path: absolute, image: file.after, ...(newRecord ? { record: newRecord } : {}) }));
      }
      const result: ContentChangeResult = { operationId: id, changes, contents };
      try {
        await this.journal.commit({ operationId: id, requestHash, files: [...plan.files.values()], affectedIds: [...plan.affected], result });
        this.#catalog = plan.catalog;
      } catch (error) { await this.#reload(); throw error; }
      this.options.onChange?.(clone(result));
      return clone(result);
    });
  }

  write(params: { target: ContentTarget; value: ContentValue; base: WriteBase; operationId: string }): Promise<ContentChangeResult> {
    const input = clone(params);
    return this.#mutate(input.operationId, { method: "write", ...input }, async (plan) => {
      const observed = await this.#observe(input.target, plan.catalog);
      if (input.target.kind === "content") this.#assertStructure(observed);
      if (observed.record && observed.record.state !== "active") throw new RepaFault("not_found", "内容已经移除，请明确恢复原对象或创建新内容。");
      if (observed.image.kind === "directory") throw new RepaFault("invalid_input", "不能将目录覆盖为文件。");
      this.#checkBase(observed, input.base, true);
      const bytes = await this.#value(input.value);
      await this.#put(plan, observed.path, { kind: "file", hash: await this.blobs.put(bytes), mode: observed.image.kind === "file" ? observed.image.mode : 0o644 }, observed.image);
    });
  }
  edit(params: { target: ContentTarget; edits: TextEdit[]; operationId: string }): Promise<ContentChangeResult> {
    const input = clone(params);
    return this.#mutate(input.operationId, { method: "edit", ...input }, async (plan) => {
      const observed = await this.#observe(input.target, plan.catalog);
      if (input.target.kind === "content") this.#assertStructure(observed);
      if (observed.image.kind !== "file") throw new RepaFault("not_found", "没有可编辑的文件。");
      const before = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await this.blobs.get(observed.image.hash));
      const after = editText(before, input.edits);
      await this.#put(plan, observed.path, { ...observed.image, hash: await this.blobs.put(after) }, observed.image);
    });
  }
  applyPatch(params: { patch: string; operationId: string }): Promise<ContentChangeResult> {
    const input = clone(params);
    return this.#mutate(input.operationId, { method: "patch", ...input }, async (plan) => {
      let actions;
      try { actions = parsePatch(input.patch); }
      catch (error) { throw new RepaFault("invalid_patch", message(error)); }
      const touched = new Set<string>();
      for (const action of actions) {
        const target = this.target(action.path);
        const observed = await this.#observe(target, plan.catalog);
        this.#assertStructure(observed);
        if (touched.has(observed.path)) throw new RepaFault("invalid_patch", "同一补丁多次修改同一个文件。");
        touched.add(observed.path);
        if (action.kind === "add") {
          if (observed.image.kind !== "absent") throw new RepaFault("revision_conflict", "新增文件的位置已经存在。");
          await this.#put(plan, observed.path, { kind: "file", hash: await this.blobs.put(action.content), mode: 0o644 }, observed.image);
        } else {
          if (observed.image.kind !== "file") throw new RepaFault("not_found", "补丁目标文件不可用。", { path: action.path });
          if (action.kind === "delete") {
            await this.#put(plan, observed.path, absent, observed.image);
            if (observed.record) { plan.catalog.items[observed.record.id]!.state = "deleted"; plan.affected.add(observed.record.id); }
          } else {
            const original = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await this.blobs.get(observed.image.hash));
            let content: string;
            try {
              const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
              content = bom + applyTextPatch(original.slice(bom.length), action.chunks);
            }
            catch (error) { throw new RepaFault("ambiguous_match", message(error), { path: action.path }); }
            const after: FileImage = { ...observed.image, hash: await this.blobs.put(content) };
            if (action.moveTo !== undefined) {
              const destination = await this.#checkPath(path.resolve(this.options.root, action.moveTo), true);
              if (touched.has(destination) || (await this.journal.image(path.relative(this.options.root, destination))).kind !== "absent")
                throw new RepaFault("revision_conflict", "移动目标位置已被占用。", { path: action.moveTo });
              touched.add(destination);
              await this.#put(plan, observed.path, absent, observed.image);
              await this.#put(plan, destination, after, absent);
              if (observed.record) { plan.catalog.items[observed.record.id]!.location = this.#location(destination); plan.affected.add(observed.record.id); }
            } else await this.#put(plan, observed.path, after, observed.image);
          }
        }
      }
    });
  }
  associate(params: { location: FileLocation; role: "document" | "material"; operationId: string; id?: string }, authorizeExternal?: (file: string) => Promise<void>): Promise<ContentChangeResult> {
    const input = clone(params);
    return this.#mutate(input.operationId, { method: "associate", ...input }, async (plan) => {
      if (input.location.kind === "external") await authorizeExternal?.(this.#absolute(input.location));
      const actual = await this.#checkPath(this.#absolute(input.location), false);
      if (Object.values(plan.catalog.items).some((item) => item.state === "active" && this.#absolute(item.location) === actual))
        throw new RepaFault("already_registered", "该位置已有内容身份，请使用已有引用。");
      const id = input.id ?? randomUUID();
      if (!Check(IdSchema, id) || plan.catalog.items[id]) throw new RepaFault("invalid_input", "新内容标识不可用。");
      plan.catalog.items[id] = { id, location: this.#location(actual), role: input.role, state: "active", mediaType: mediaType(actual), members: [], resources: [] };
      plan.affected.add(id);
    });
  }
  transfer(kind: "move" | "copy" | "collect", params: TransferInput): Promise<ContentChangeResult> {
    const input = clone(params);
    return this.#mutate(input.operationId, { method: kind, ...input }, async plan => {
      const source = await this.#observe(input.target, plan.catalog);
      this.#assertStructure(source); this.#checkBase(source, input.base);
      if (source.image.kind === "absent") throw new RepaFault("not_found", "源内容不存在。");
      if (source.path === this.options.root) throw new RepaFault("invalid_input", "整个空间请使用空间复制入口。");
      if (input.destination.kind !== "relative") throw new RepaFault("permission_required", "目标必须位于当前空间。");
      const destination = await this.#checkPath(this.#absolute(input.destination), true);
      if (destination === source.path || inside(source.path, destination)) throw new RepaFault("invalid_input", "目标不能是源位置或其内部位置。");
      if (kind === "collect" && (source.record?.role !== "material" || source.record.location.kind !== "external" || source.image.kind !== "file"))
        throw new RepaFault("invalid_input", "收集操作需要一份已关联的外部材料。");
      if (kind === "move" && !inside(this.options.root, source.path)) throw new RepaFault("permission_required", "外部原件通过材料收集操作保留并接入空间。");
      const nodes = new Map<string, Observed>();
      const visit = async (target: ContentTarget, first = false): Promise<void> => {
        const record = this.#record(target, plan.catalog);
        // 外部材料作为引用依赖继续保留，独立收集由明确的根操作表达。
        if (!first && (record?.location.kind === "external" || (target.kind === "file" && target.location.kind === "external"))) return;
        const node = first ? source : await this.#observe(target, plan.catalog);
        if (nodes.has(node.path)) return;
        this.#assertStructure(node);
        if (node.image.kind === "absent") throw new RepaFault("not_found", "组成内容中有缺失文件。", { target });
        nodes.set(node.path, node);
        if (node.image.kind === "directory") {
          for (const entry of await readdir(node.path, { withFileTypes: true })) {
            if (entry.name === ".repa" || /^\.repa-.*\.tmp$/.test(entry.name)) continue;
            if (entry.isSymbolicLink()) throw new RepaFault("unsupported_content", "内容树中的符号链接需由相应文件能力处理。", { path: entry.name });
            await visit(this.target(path.join(node.path, entry.name)));
          }
        }
        if (kind !== "collect") for (const member of node.record?.members ?? []) await visit(member.target);
      };
      await visit(input.target, true);
      let anchor = source.image.kind === "directory" ? source.path : path.dirname(source.path);
      if (input.container) {
        for (const node of nodes.values()) while (!inside(anchor, node.path)) anchor = path.dirname(anchor);
      } else if ([...nodes.keys()].some(file => !inside(anchor, file)))
        throw new RepaFault("invalid_input", "组成成员分布在其他目录，请选择 container 复制或移动整个组合。");
      const locations = new Map<string, string>();
      for (const node of nodes.values()) {
        const target = node.path === source.path && !input.container ? destination
          : path.resolve(input.container || source.image.kind === "directory" ? destination : path.dirname(destination), path.relative(anchor, node.path));
        if (!inside(this.options.root, target) || nodes.has(target)) throw new RepaFault("invalid_input", "目标布局与源内容重叠。");
        if ((await this.journal.image(path.relative(this.options.root, target))).kind !== "absent")
          throw new RepaFault("revision_conflict", "目标位置已经存在。", { path: this.#location(target) });
        locations.set(node.path, target);
      }
      if (new Set(locations.values()).size !== locations.size) throw new RepaFault("invalid_input", "多个成员映射到同一目标位置。");
      const ids = new Map<string, string>();
      for (const node of nodes.values()) if (node.record) ids.set(node.record.id, kind === "copy" ? randomUUID() : node.record.id);
      const mapping = { fromSpace: this.options.spaceId, toSpace: this.options.spaceId, ids };
      const mapTarget = (target: ContentTarget): ContentTarget => {
        if (target.kind === "content") return { kind: "content", ref: mapReference(target.ref, mapping) };
        const to = locations.get(this.#absolute(target.location));
        return to ? { ...target, location: this.#location(to) } : target;
      };
      for (const node of nodes.values()) {
        const record = node.record;
        if (!record) continue;
        const origin = clone(record.location);
        const next = kind === "copy" ? clone(record) : plan.catalog.items[record.id]!;
        next.id = ids.get(record.id)!;
        next.location = this.#location(locations.get(node.path)!);
        if (kind === "copy" || kind === "collect") next.origin = origin;
        next.members = next.members.map(member => ({ ...member, target: mapTarget(member.target) }));
        this.retention.validate(next.resources);
        plan.catalog.items[next.id] = next; plan.affected.add(next.id);
      }
      if (kind !== "copy") {
        for (const record of Object.values(plan.catalog.items)) {
          const members = record.members.map(member => ({ ...member, target: mapTarget(member.target) }));
          if (!equal(members, record.members)) { record.members = members; plan.affected.add(record.id); }
        }
      }
      for (const node of [...nodes.values()].sort((a,b) => a.path.split(path.sep).length-b.path.split(path.sep).length)) {
        let after = node.image;
        if (kind === "copy" && after.kind === "file") {
          let bytes = await this.blobs.get(after.hash);
          if (node.record?.id === plan.before.context?.ref.id && plan.before.context?.kind === "composition") bytes = remapContextComposition(bytes, mapping);
          else if (mediaType(node.path) === "text/markdown" && ids.size) {
            let text: string;
            try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
            catch { throw new RepaFault("unsupported_format", "该 Markdown 的编码需要相应的引用处理器。"); }
            bytes = Buffer.from(remapMarkdown(text, ids));
          }
          after = { ...after, hash: await this.blobs.put(bytes) };
        }
        await this.#put(plan, locations.get(node.path)!, after, absent);
      }
      if (kind === "move") {
        for (const node of [...nodes.values()].sort((a,b) => b.path.split(path.sep).length-a.path.split(path.sep).length))
          await this.#put(plan, node.path, absent, node.image);
      }
    });
  }
  relink(params: { ref: ContentRef; location: FileLocation; base: string; operationId: string }, authorizeExternal?: (file: string) => Promise<void>): Promise<ContentChangeResult> {
    const input = clone(params);
    return this.#mutate(input.operationId, { method: "relink", ...input }, async (plan) => {
      const record = this.#record({ kind: "content", ref: input.ref }, plan.catalog)!;
      const current: Observed = { path: this.#absolute(record.location), image: absent, record };
      this.#checkBase(current, input.base);
      if (input.location.kind === "external") await authorizeExternal?.(this.#absolute(input.location));
      const actual = await this.#checkPath(this.#absolute(input.location), false);
      record.location = this.#location(actual);
      record.state = "active";
      plan.affected.add(record.id);
    });
  }
  remove(params: { target: ContentTarget; base: string; operationId: string; detach?: boolean }): Promise<ContentChangeResult> {
    const input = clone(params);
    return this.#mutate(input.operationId, { method: "remove", ...input }, async (plan) => {
      const observed = await this.#observe(input.target, plan.catalog);
      this.#checkBase(observed, input.base, !input.detach);
      if (input.detach) {
        if (!observed.record || observed.record.role !== "material") throw new RepaFault("invalid_input", "只有材料关联可以移除关联。");
        observed.record.state = "detached";
        plan.affected.add(observed.record.id);
      } else {
        if (observed.record?.role === "material") throw new RepaFault("invalid_input", "移除材料请使用关联入口。");
        await this.#put(plan, observed.path, absent, observed.image);
        if (observed.record) { observed.record.state = "deleted"; plan.affected.add(observed.record.id); }
      }
    });
  }
  setComposition(params: { ref: ContentRef; base: string; members: ContentInfo["members"]; resources: ResourceRef[]; operationId: string }): Promise<ContentChangeResult> {
    const input = clone(params);
    return this.#mutate(input.operationId, { method: "composition", ...input }, async (plan) => {
      const observed = await this.#observe({ kind: "content", ref: input.ref }, plan.catalog);
      this.#assertStructure(observed); this.#checkBase(observed, input.base);
      for (const member of input.members) {
        const value = await this.#observe(member.target, plan.catalog);
        this.#assertStructure(value);
      }
      for (const resource of input.resources) {
        if (resource.spaceId !== this.options.spaceId) throw new RepaFault("invalid_input", "组成资源不属于当前空间。");
        await this.blobs.get(resource.id);
      }
      const record = plan.catalog.items[input.ref.id]!;
      record.members = input.members; record.resources = input.resources;
      plan.affected.add(record.id);
    });
  }
  context(): Promise<ContextState> {
    return this.queue.run(async () => ({ binding: clone(this.#catalog.context), revision: digest(canonicalJson(this.#catalog.context)) }));
  }
  hold(params: { id: string; targets?: ContentTarget[]; resources?: ResourceRef[] }, host: string): Promise<ResourceHold> {
    const input = clone(params), requestHash = digest(canonicalJson(params));
    const epoch = this.retention.epoch(host);
    return this.queue.run(async () => {
      this.options.assertOwned();
      const previous = this.retention.previous(host, input.id, requestHash);
      if (previous) return previous;
      await this.#reload();
      if (!(input.targets?.length || input.resources?.length)) throw new RepaFault("invalid_input", "请选择实际内容或资源。");
      const snapshots: ContentSnapshot[] = [], refs = [...input.resources ?? []], seen = new Set<string>();
      const visit = async (target: ContentTarget): Promise<void> => {
        const record = this.#record(target, this.#catalog);
        if (record?.location.kind === "external") {
          if (seen.has(`external:${record.id}`)) return;
          seen.add(`external:${record.id}`);
          const content = await this.#metadata(record);
          if (content.status === "needs_recovery") this.#assertStructure({ path: this.#absolute(record.location), image: absent, record });
          snapshots.push({ target, content });
          return;
        }
        if (target.kind === "file" && target.location.kind === "external")
          throw new RepaFault("external_reference", "外部原件先读取所需表示，再持有返回的资源。");
        const observed = await this.#observe(target);
        if (seen.has(observed.path)) return;
        seen.add(observed.path);
        if (target.kind === "content") this.#assertStructure(observed);
        if (observed.image.kind === "absent") throw new RepaFault("not_found", "所需内容不存在。", { target });
        const content = await this.#info(observed);
        const resource = observed.image.kind === "file"
          ? { spaceId: this.options.spaceId, id: observed.image.hash, mediaType: content.mediaType } : undefined;
        snapshots.push({ target, content, ...(resource ? { resource } : {}) });
        if (resource) refs.push(resource);
        if (content.status !== "needs_recovery") {
          refs.push(...content.resources);
          for (const member of content.members) await visit(member.target);
        }
        if (observed.image.kind === "directory") {
          for (const name of await readdir(observed.path)) {
            if (name === ".repa" || /^\.repa-.*\.tmp$/.test(name)) continue;
            await visit(this.target(path.join(observed.path, name)));
          }
        }
      };
      for (const target of input.targets ?? []) await visit(target);
      return this.retention.hold(host, input.id, requestHash, snapshots, refs, epoch);
    });
  }
  async #resourceRoots(): Promise<Set<string>> {
    const roots = new Set<string>();
    const addCatalog = (catalog: Catalog) => {
      for (const record of Object.values(catalog.items)) if (record.state === "active")
        for (const ref of record.resources) roots.add(ref.id);
    };
    addCatalog(this.#catalog);
    for (const entry of this.journal.entries.values()) {
      for (const file of entry.files) {
        for (const image of [file.before, file.after]) {
          if (image.kind !== "file") continue;
          roots.add(image.hash);
          if (file.path === catalogPath) {
            const value: unknown = JSON.parse((await this.blobs.get(image.hash)).toString("utf8"));
            if (!Check(CatalogSchema, value)) throw new RepaFault("invalid_storage", "历史内容清单无法解析，停止资源回收。");
            addCatalog(value);
          }
        }
      }
    }
    return roots;
  }
  collectResources(): Promise<{ removed: number; bytes: number }> {
    return this.queue.run(async () => {
      this.options.assertOwned(); await this.#reload();
      return this.retention.collect(await this.#resourceRoots());
    });
  }
  pruneHistory(ids: string[]): Promise<string[]> {
    const input = [...ids];
    return this.queue.run(async () => { this.options.assertOwned(); return this.journal.prune(input); });
  }
  upload(bytes: Uint8Array, mediaType: string, host: string) {
    const snapshot = Buffer.from(bytes);
    const epoch = this.retention.epoch(host);
    return this.queue.run(async () => {
      this.options.assertOwned();
      const resource = { spaceId: this.options.spaceId, id: await this.blobs.put(snapshot), mediaType };
      return this.retention.prepare(host, resource, epoch);
    });
  }

  capture(destinationRoot: string, targetSpaceId: string): Promise<FileLocation[]> {
    return this.queue.run(async () => {
      this.options.assertOwned(); await this.#reload();
      return captureContent({ destinationRoot, targetSpaceId, sourceSpaceId: this.options.spaceId,
        currentCatalog: this.#catalog, journal: this.journal, sourceBlobs: this.blobs,
        retained: this.retention, roots: await this.#resourceRoots() });
    });
  }

  setContext(params: { binding: ContextBinding; base: string; operationId: string }): Promise<ContentChangeResult> {
    const input = clone(params);
    return this.#mutate(input.operationId, { method: "context", ...input }, async (plan) => {
      if (digest(canonicalJson(plan.catalog.context)) !== input.base) throw new RepaFault("revision_conflict", "语境绑定已经改变。");
      if (input.binding) {
        const observed = await this.#observe({ kind: "content", ref: input.binding.ref }, plan.catalog);
        this.#assertStructure(observed);
        if (observed.record?.state !== "active") throw new RepaFault("not_found", "语境内容不可用。");
        plan.affected.add(input.binding.ref.id);
      }
      plan.catalog.context = input.binding;
    });
  }
  contextView(): Promise<ContextView> {
    return this.queue.run(async () => {
      const binding = this.#catalog.context;
      const sources: ContextView["sources"] = [];
      const read = async (ref: ContentRef): Promise<string> => {
        const observed = await this.#observe({ kind: "content", ref });
        this.#assertStructure(observed);
        if (observed.image.kind !== "file") throw new RepaFault("context_unavailable", "语境成员没有可读取的正文。", { ref });
        sources.push({ ref, revision: observed.image.hash });
        try { return new TextDecoder("utf-8", { fatal: true }).decode(await this.blobs.get(observed.image.hash)); }
        catch { throw new RepaFault("unsupported_format", "该语境成员需要明确的文本表示。", { ref }); }
      };
      let text = "";
      if (binding?.kind === "document") text = await read(binding.ref);
      else if (binding) {
        const body = await read(binding.ref);
        let data: unknown;
        try { data = JSON.parse(body); } catch { throw new RepaFault("invalid_context", "语境组成清单不是有效 JSON。"); }
        if (!Check(ContextCompositionSchema, data)) throw new RepaFault("invalid_context", "语境组成清单格式无效。");
        const parts: string[] = [];
        const member = async (item: { ref: ContentRef; mode: "expand" | "reference"; title?: string; note?: string }) => {
          const label = item.title ?? item.ref.id;
          if (item.mode === "expand") parts.push(`## ${label}\n${await read(item.ref)}`);
          else {
            const record = this.#record({ kind: "content", ref: item.ref }, this.#catalog)!;
            if (this.#blocked(this.#absolute(record.location), record.id)) throw new RepaFault("recovery_required", "语境引用仍需恢复。", { ref: item.ref });
            parts.push(`## ${label}\nrepa:${record.role}/${record.id}`);
          }
          if (item.note) parts.push(item.note);
        };
        for (const item of data.items) {
          if ("items" in item) { parts.push(`# ${item.title}`); for (const child of item.items) await member(child); }
          else await member(item);
        }
        text = parts.join("\n\n");
      }
      return { text, sources, revision: digest(canonicalJson({ text, sources })) };
    });
  }
  operation(id: string): Promise<ContentOperation | { operationId: string; status: "unknown" | "pruned" }> {
    return this.queue.run(async () => {
      if (this.journal.retired.has(id)) return { operationId: id, status: "pruned" };
      const entry = this.journal.entries.get(id);
      return entry ? this.journal.view(entry) : { operationId: id, status: "unknown" };
    });
  }
  reconcile(id: string): Promise<ContentOperation> {
    return this.queue.run(async () => {
      this.options.assertOwned();
      const entry = this.journal.entries.get(id);
      if (!entry) throw new RepaFault("not_found", "操作记录不存在。");
      if (entry.status !== "needs_recovery") return this.journal.view(entry);
      await this.#reload();
      this.#validateCatalog(this.#catalog);
      const catalogChange = entry.files.find((file) => file.path === catalogPath);
      const before: Catalog = catalogChange?.before.kind === "file" ? JSON.parse((await this.blobs.get(catalogChange.before.hash)).toString()) : emptyCatalog();
      const after: Catalog = catalogChange?.after.kind === "file" ? JSON.parse((await this.blobs.get(catalogChange.after.hash)).toString()) : emptyCatalog();
      for (const recordId of entry.affectedIds) {
        const record = this.#catalog.items[recordId];
        if (!record) continue;
        this.#absolute(record.location);
        for (const member of record.members) this.#record(member.target, this.#catalog);
        if (record.state === "active" &&
          (!equal(before.items[recordId]?.location, after.items[recordId]?.location) ||
           before.items[recordId]?.state !== after.items[recordId]?.state)) {
          const observed = await this.#observe({ kind: "content", ref: { spaceId: this.options.spaceId, id: recordId } });
          if (observed.image.kind === "absent")
            throw new RepaFault("recovery_required", "先重新关联实际内容，或明确移除原对象，再确认恢复。", { ref: { spaceId: this.options.spaceId, id: recordId } });
        }
      }
      for (const file of entry.files) await this.journal.image(file.path, false);
      // The original failure stays recorded; current files and relations were explicitly reconciled.
      const repaired = { ...entry, status: "reconciled" as const, conflicts: [] };
      await this.journal.persist(repaired);
      this.journal.entries.set(id, repaired);
      return this.journal.view(repaired);
    });
  }
  undo(params: { operationId: string; undoOperationId: string }): Promise<ContentChangeResult> {
    const input = clone(params);
    return this.#mutate(input.undoOperationId, { method: "undo", ...input }, async (plan) => {
      const entry = this.journal.entries.get(input.operationId);
      if (!entry || entry.status !== "committed") throw new RepaFault("invalid_input", "只能撤回已完成的内容操作。");
      for (const file of entry.files) {
        if (file.path === catalogPath) {
          const before: Catalog = file.before.kind === "file" ? JSON.parse((await this.blobs.get(file.before.hash)).toString()) : emptyCatalog();
          const after: Catalog = file.after.kind === "file" ? JSON.parse((await this.blobs.get(file.after.hash)).toString()) : emptyCatalog();
          plan.catalog = mergeInverse(before, after, plan.catalog) as Catalog;
          for (const id of entry.affectedIds) {
            if (!plan.catalog.items[id] && after.items[id])
              plan.catalog.items[id] = { ...after.items[id]!, state: after.items[id]!.role === "material" ? "detached" : "deleted" };
          }
          for (const id of entry.affectedIds) plan.affected.add(id);
          continue;
        }
        if (file.after.kind === "directory" && file.before.kind === "absent") continue;
        const current = await this.journal.image(file.path);
        let after = file.before;
        if (!sameImage(current, file.after)) {
          if (file.before.kind !== "file" || file.after.kind !== "file" || current.kind !== "file")
            throw new RepaFault("revision_conflict", "撤回目标已有其他变化。", { path: file.path });
          const decode = (data: Buffer) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
          let merged: string;
          try { merged = revertText(decode(await this.blobs.get(file.before.hash)), decode(await this.blobs.get(file.after.hash)), decode(await this.blobs.get(current.hash))); }
          catch (error) { if (error instanceof RepaFault) throw error; throw new RepaFault("revision_conflict", "二进制内容已有后续修改。", { path: file.path }); }
          after = { ...current, hash: await this.blobs.put(merged) };
        }
        await this.#put(plan, path.join(this.options.root, file.path), after, current);
      }
      for (const file of entry.files.filter(file => file.before.kind === "absent" && file.after.kind === "directory")
        .sort((a,b) => b.path.split(path.sep).length-a.path.split(path.sep).length)) {
        const current = await this.journal.image(file.path);
        if (!sameImage(current, file.after)) continue;
        const names = await readdir(path.join(this.options.root, file.path));
        if (names.every(name => plan.files.get(path.join(file.path, name))?.after.kind === "absent"))
          await this.#put(plan, path.join(this.options.root, file.path), absent, current);
      }
    });
  }
  async settled(): Promise<void> { await this.queue.settled(); }
}

/** Three-way inverse for only the catalog fields changed by one operation. */
function mergeInverse(before: unknown, after: unknown, current: unknown): unknown {
  if (equal(before, after)) return current;
  if (equal(current, after)) return before;
  if (before && after && current && typeof before === "object" && typeof after === "object" && typeof current === "object" &&
    !Array.isArray(before) && !Array.isArray(after) && !Array.isArray(current)) {
    const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
    const result = clone(current as Record<string, unknown>);
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const value = mergeInverse(a[key], b[key], result[key]);
      if (value === undefined) delete result[key]; else result[key] = value;
    }
    return result;
  }
  throw new RepaFault("revision_conflict", "内容关系已有后续修改，请比较后处理。");
}
