import path from "node:path";
import type { TSchema } from "typebox";
import type { Catalog } from "./catalog.js";
import type { ContentRef } from "./schema.js";
import type { ReferenceMapping } from "./references.js";

/** 已安装持久格式的轻量解释，不建立能力运行实例或业务存储。 */
export interface ContentFormat {
  id: string;
  field: string;
  default: unknown;
  schema: TSchema;
  references(value: unknown): ContentRef[];
  files(value: unknown): ContentRef[];
  remapMetadata(value: unknown, mapping: ReferenceMapping): unknown;
  remapFile(bytes: Buffer, mapping: ReferenceMapping): Buffer;
}

export function formatValue(catalog: Catalog, format: ContentFormat): unknown {
  return Object.hasOwn(catalog, format.field) ? catalog[format.field] : format.default;
}

export function formatFiles(catalog: Catalog, formats: readonly ContentFormat[]): Map<string, ContentFormat[]> {
  const files = new Map<string, ContentFormat[]>();
  for (const format of formats) {
    for (const ref of format.files(formatValue(catalog, format))) {
      const record = catalog.items[ref.id];
      if (record?.location.kind !== "relative") continue;
      const file = path.normalize(record.location.path);
      files.set(file, [...files.get(file) ?? [], format]);
    }
  }
  return files;
}
