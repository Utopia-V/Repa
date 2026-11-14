import { ConversionFailure } from "./result.js";

/** OLE 复合文档（.ppt、.doc 以及加密后的 .pptx、.docx）的文件头。 */
export const COMPOUND_FILE_SIGNATURE = Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);

const END_OF_CHAIN = 0xfffffffe;
const NO_STREAM = 0xffffffff;
const DIRECTORY_ENTRY = 128;

function damaged(detail: string): never {
  throw new ConversionFailure("damaged", `复合文档${detail}`);
}

/**
 * 只读取复合文档根目录下的流，按 [MS-CFB] 跟随扇区链。链的长度不超过文件的扇区数、目录树里的项不重复访问，
 * 损坏的文件因此报错，不会一直转下去。
 */
export class CompoundFile {
  private readonly view: DataView;
  private readonly sectorSize: number;
  private readonly sectorCount: number;
  private readonly fat: number[] = [];
  private readonly streams = new Map<string, { start: number; size: number }>();
  private readonly miniCutoff: number;
  private miniFat: number[] | undefined;
  private miniStream: Uint8Array | undefined;
  private readonly root: { start: number; size: number };
  private readonly miniFatStart: number;

  constructor(private readonly data: Uint8Array) {
    if (data.length < 512 || COMPOUND_FILE_SIGNATURE.some((byte, index) => data[index] !== byte)) damaged("的文件头不对");
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const shift = this.view.getUint16(0x1e, true);
    if (shift !== 9 && shift !== 12) damaged(`的扇区大小不对（${shift}）`);
    this.sectorSize = 1 << shift;
    this.sectorCount = Math.floor((data.length - this.sectorSize) / this.sectorSize);
    this.miniCutoff = this.view.getUint32(0x38, true);
    this.miniFatStart = this.view.getUint32(0x3c, true);

    const fatSectors: number[] = [];
    for (let index = 0; index < 109; index++) fatSectors.push(this.view.getUint32(0x4c + 4 * index, true));
    let difat = this.view.getUint32(0x44, true);
    for (let step = 0; difat !== END_OF_CHAIN && difat !== NO_STREAM; step++) {
      if (step > this.sectorCount) damaged("的 DIFAT 链成环");
      const offset = this.offset(difat);
      const perSector = this.sectorSize / 4 - 1;
      for (let index = 0; index < perSector; index++) fatSectors.push(this.view.getUint32(offset + 4 * index, true));
      difat = this.view.getUint32(offset + 4 * perSector, true);
    }
    const fatCount = this.view.getUint32(0x2c, true);
    for (const sector of fatSectors.slice(0, fatCount)) {
      const offset = this.offset(sector);
      for (let index = 0; index < this.sectorSize / 4; index++) this.fat.push(this.view.getUint32(offset + 4 * index, true));
    }

    const directory = this.chain(this.view.getUint32(0x30, true), this.fat, this.sectorSize, (sector) => this.sectorBytes(sector));
    const entry = (index: number) => {
      const offset = index * DIRECTORY_ENTRY;
      if (offset + DIRECTORY_ENTRY > directory.length) damaged("的目录项越界");
      const view = new DataView(directory.buffer, directory.byteOffset + offset, DIRECTORY_ENTRY);
      const nameLength = Math.max(0, Math.min(64, view.getUint16(0x40, true)) - 2);
      return {
        name: new TextDecoder("utf-16le").decode(directory.subarray(offset, offset + nameLength)),
        type: view.getUint8(0x42),
        left: view.getUint32(0x44, true),
        right: view.getUint32(0x48, true),
        child: view.getUint32(0x4c, true),
        start: view.getUint32(0x74, true),
        size: view.getUint32(0x78, true),
      };
    };
    const rootEntry = entry(0);
    this.root = { start: rootEntry.start, size: rootEntry.size };
    // 根目录的子项是一棵红黑树，按左右兄弟遍历即可，不需要顺序。
    const pending = [rootEntry.child];
    const visited = new Set<number>();
    while (pending.length > 0) {
      const index = pending.pop();
      if (index === undefined || index === NO_STREAM) continue;
      if (visited.has(index)) damaged("的目录树成环");
      visited.add(index);
      const item = entry(index);
      if (item.type === 2) this.streams.set(item.name, { start: item.start, size: item.size });
      pending.push(item.left, item.right);
    }
  }

  has(name: string): boolean {
    return this.streams.has(name);
  }

  /** 根目录下名为 name 的流；没有这个流时返回 undefined。 */
  stream(name: string): Uint8Array | undefined {
    const stream = this.streams.get(name);
    if (stream === undefined) return undefined;
    const content = stream.size >= this.miniCutoff
      ? this.chain(stream.start, this.fat, this.sectorSize, (sector) => this.sectorBytes(sector))
      : this.miniChain(stream.start);
    if (content.length < stream.size) damaged(`里的流 ${name} 应有 ${stream.size} 字节，只读到 ${content.length} 字节`);
    return content.subarray(0, stream.size);
  }

  /** 小于 miniCutoff 的流放在根目录项的小流里，按 64 字节的小扇区和小分配表存放。 */
  private miniChain(start: number): Uint8Array {
    this.miniFat ??= this.readMiniFat();
    const miniStream = this.miniStream ??= this.chain(this.root.start, this.fat, this.sectorSize, (sector) => this.sectorBytes(sector));
    return this.chain(start, this.miniFat, 64, (sector) => {
      if ((sector + 1) * 64 > miniStream.length) damaged("的小扇区越界");
      return miniStream.subarray(sector * 64, (sector + 1) * 64);
    });
  }

  private readMiniFat(): number[] {
    if (this.miniFatStart === END_OF_CHAIN) return [];
    const bytes = this.chain(this.miniFatStart, this.fat, this.sectorSize, (sector) => this.sectorBytes(sector));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result: number[] = [];
    for (let offset = 0; offset + 4 <= bytes.length; offset += 4) result.push(view.getUint32(offset, true));
    return result;
  }

  private offset(sector: number): number {
    if (sector >= this.sectorCount) damaged(`的扇区 ${sector} 超出文件`);
    return (sector + 1) * this.sectorSize;
  }

  private sectorBytes(sector: number): Uint8Array {
    const offset = this.offset(sector);
    return this.data.subarray(offset, offset + this.sectorSize);
  }

  private chain(start: number, table: number[], size: number, read: (sector: number) => Uint8Array): Uint8Array {
    const parts: Uint8Array[] = [];
    for (let sector = start; sector !== END_OF_CHAIN; ) {
      if (parts.length > table.length) damaged("的扇区链成环");
      const next = table[sector];
      if (next === undefined) damaged(`的扇区 ${sector} 不在分配表里`);
      parts.push(read(sector));
      sector = next;
    }
    const result = new Uint8Array(parts.length * size);
    parts.forEach((part, index) => result.set(part, index * size));
    return result;
  }
}
