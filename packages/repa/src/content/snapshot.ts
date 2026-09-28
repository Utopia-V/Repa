import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Check } from "typebox/value";
import { RepaFault } from "../errors.js";
import { atomicWrite, writeJson } from "../storage/atomic.js";
import { BlobStore } from "../storage/blobs.js";
import { CatalogSchema, catalogPath, type Catalog } from "./catalog.js";
import type { FileJournal } from "./journal.js";
import type { ResourceRetention } from "./resources.js";
import { mapReference, remapContextComposition } from "./references.js";
import type { ContentTarget, FileLocation, ResourceRef } from "./schema.js";

const clone = <T>(value: T): T => structuredClone(value);
/** 调用者持有内容队列；只解释本模块的格式，普通文件已经由空间快照复制。 */
export async function captureContent(options: {
  destinationRoot: string; sourceSpaceId: string; targetSpaceId: string;
  currentCatalog: Catalog; journal: FileJournal; sourceBlobs: BlobStore;
  retained: ResourceRetention; roots: ReadonlySet<string>;
}): Promise<FileLocation[]> {
  const { destinationRoot, sourceSpaceId, targetSpaceId, currentCatalog, journal, sourceBlobs, retained, roots } = options;
  const copying = targetSpaceId !== sourceSpaceId;
  if (copying && [...journal.entries.values()].some(entry => entry.status === "prepared" || entry.status === "needs_recovery"))
    throw new RepaFault("recovery_required", "独立复制前需要处理未确认的内容操作。");
  const directory = path.join(destinationRoot, ".repa", "content");
  await mkdir(path.join(directory, "operations"), { recursive: true });
  const blobs = new BlobStore(path.join(directory, "blobs")); await blobs.open();
  const retention = retained.snapshot();
  for (const id of new Set([...roots, ...retention.roots])) await blobs.put(await sourceBlobs.get(id));
  const mapping = { fromSpace: sourceSpaceId, toSpace: targetSpaceId, ids: new Map<string, string>() };
  const target = (value: ContentTarget): ContentTarget => value.kind === "content"
    ? { kind: "content", ref: mapReference(value.ref, mapping) }
    : value.spaceId === sourceSpaceId ? { ...value, spaceId: targetSpaceId } : value;
  const resource = (value: ResourceRef): ResourceRef => value.spaceId === sourceSpaceId ? { ...value, spaceId: targetSpaceId } : value;
  const catalog = (value: Catalog): Catalog => {
    const next = clone(value);
    if (next.context) next.context.ref = mapReference(next.context.ref, mapping);
    for (const record of Object.values(next.items)) {
      record.members = record.members.map(member => ({ ...member, target: target(member.target) }));
      record.resources = record.resources.map(resource);
    }
    return next;
  };
  const contextPath = (value: Catalog): string | undefined => {
    if (value.context?.kind !== "composition") return;
    const record = value.items[value.context.ref.id];
    if (record?.location.kind === "relative") return path.normalize(record.location.path);
  };
  const contextPaths = new Set<string>();
  const currentPath = contextPath(currentCatalog); if (currentPath) contextPaths.add(currentPath);
  const historical = new Map<string, Catalog>();
  for (const entry of journal.entries.values()) for (const file of entry.files) if (file.path === catalogPath)
    for (const image of [file.before, file.after]) if (image.kind === "file" && !historical.has(image.hash)) {
      const raw: unknown = JSON.parse((await sourceBlobs.get(image.hash)).toString("utf8"));
      if (!Check(CatalogSchema, raw)) throw new RepaFault("invalid_storage", "历史内容清单无法解析。");
      historical.set(image.hash, raw);
      const location = contextPath(raw); if (location) contextPaths.add(location);
    }
  const mapped = new Map<string, string>();
  const remapImage = async (file: string, hash: string): Promise<string> => {
    const key = `${file}:${hash}`;
    if (mapped.has(key)) return mapped.get(key)!;
    const bytes = await sourceBlobs.get(hash);
    const changed = historical.has(hash) && file === catalogPath
      ? Buffer.from(`${JSON.stringify(catalog(historical.get(hash)!), null, 2)}\n`)
      : contextPaths.has(file) ? remapContextComposition(bytes, mapping) : bytes;
    const id = await blobs.put(changed); mapped.set(key, id); return id;
  };
  for (const original of journal.entries.values()) {
    const entry = clone(original);
    if (copying) {
      for (const file of entry.files) for (const image of [file.before, file.after]) if (image.kind === "file") image.hash = await remapImage(file.path, image.hash);
      for (const change of entry.result.changes) {
        if (change.before) change.before = mapped.get(`${path.normalize(change.path)}:${change.before}`) ?? change.before;
        if (change.after) change.after = mapped.get(`${path.normalize(change.path)}:${change.after}`) ?? change.after;
      }
      for (const info of entry.result.contents) {
        info.target = target(info.target); if (info.ref) info.ref = mapReference(info.ref, mapping);
        info.members = info.members.map(member => ({ ...member, target: target(member.target) }));
        info.resources = info.resources.map(resource);
        if (info.bodyRevision && info.location.kind === "relative") info.bodyRevision = mapped.get(`${path.normalize(info.location.path)}:${info.bodyRevision}`) ?? info.bodyRevision;
      }
    }
    await writeJson(path.join(directory, "operations", `${entry.operationId}.json`), entry);
  }
  await writeJson(path.join(destinationRoot, catalogPath), copying ? catalog(currentCatalog) : currentCatalog);
  await writeJson(path.join(directory, "resources.json"), retention.state);
  if (journal.retired.size) await writeJson(path.join(directory, "retired-operations.json"), { version: 1, items: Object.fromEntries(journal.retired) });
  if (copying) for (const file of contextPaths) {
    const absolute = await journal.filePath(file);
    const targetFile = path.join(destinationRoot, file);
    try {
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const bytes = await readFile(targetFile), next = remapContextComposition(bytes, mapping);
      if (!bytes.equals(next)) await atomicWrite(targetFile, next, stat.mode & 0o777);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return Object.values(currentCatalog.items).filter(record => record.state === "active" && record.location.kind === "external").map(record => clone(record.location));
}
