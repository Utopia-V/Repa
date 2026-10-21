import { crc32, deflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** 包内路径，用 / 分隔；Windows 上不能用 path.join 拼出来的 \。 */
  name: string;
  data: Buffer;
}

// 只写反馈包需要的部分：deflate、不分卷、不用 zip64。超出这些限制时直接报错，而不是写出解不开的包。
const MAX_SIZE = 0xffffffff;
const MAX_ENTRIES = 0xffff;
// 第 11 位：文件名按 UTF-8 编码。不置这一位，Windows 资源管理器会按本地代码页读非 ASCII 名称。
const UTF8_NAMES = 0x0800;
const DEFLATE = 8;
const VERSION = 20;

/** ZIP 用 DOS 时间，按本地时间记录，精度两秒。 */
function dosTime(date: Date): { time: number; date: number } {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function createZip(entries: readonly ZipEntry[], modified = new Date()): Buffer {
  if (entries.length > MAX_ENTRIES) throw new RangeError("zip 条目过多");
  const stamp = dosTime(modified);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    if (entry.name.length === 0 || entry.name.startsWith("/") || entry.name.includes("\\")) {
      throw new RangeError(`zip 条目名称无效：${entry.name}`);
    }
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const checksum = crc32(entry.data);
    if (entry.data.length > MAX_SIZE || compressed.length > MAX_SIZE) throw new RangeError(`zip 条目过大：${entry.name}`);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(VERSION, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(DEFLATE, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
    if (offset > MAX_SIZE) throw new RangeError("zip 总大小超过限制");
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
