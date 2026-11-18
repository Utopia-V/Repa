import assert from "node:assert/strict";
import { crc32, inflateRawSync } from "node:zlib";

// 只在测试里读包：按中央目录逐项解压并核对 CRC，不依赖生成包的同一份代码。
export function unzip(buffer: Buffer): Map<string, { text: string; utf8: boolean }> {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "找不到中央目录结尾");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = new Map<string, { text: string; utf8: boolean }>();
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const flags = buffer.readUInt16LE(offset + 8);
    const checksum = buffer.readUInt32LE(offset + 16);
    const compressed = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = inflateRawSync(buffer.subarray(start, start + compressed));
    assert.equal(crc32(data), checksum, `${name} 的 CRC 不符`);
    files.set(name, { text: data.toString("utf8"), utf8: (flags & 0x0800) !== 0 });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
