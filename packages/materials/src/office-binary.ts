import { CompoundFile } from "./compound-file.js";
import { ConversionFailure, PICTURE, type Converted } from "./result.js";

// [MS-PPT] 的记录类型。
const DOCUMENT_CONTAINER = 0x03e8;
const SLIDE_PERSIST_ATOM = 0x03f3;
const SLIDE_LIST_WITH_TEXT = 0x0ff0;
const USER_EDIT_ATOM = 0x0ff5;
const PERSIST_DIRECTORY_ATOM = 0x1772;
const TEXT_CHARS_ATOM = 0x0fa0;
const TEXT_BYTES_ATOM = 0x0fa8;
const OUTLINE_TEXT_REF_ATOM = 0x0f9e;
const SHAPE_CONTAINER = 0xf004;
const PLACEHOLDER_ATOM = 0x0bc3;
// CurrentUserAtom 的 headerToken：加密的演示文稿写这个值。
const ENCRYPTED_TOKEN = 0xf3d1c4df;
// 占位符类型里的日期、页码、页脚和页眉，每张都有，读出来只是噪声。
const FOOTER_PLACEHOLDERS = new Set([0x07, 0x08, 0x09, 0x0a]);

interface RecordHeader {
  offset: number;
  container: boolean;
  instance: number;
  type: number;
  length: number;
}

function header(view: DataView, offset: number): RecordHeader {
  const options = view.getUint16(offset, true);
  return {
    offset,
    container: (options & 0x0f) === 0x0f,
    instance: options >> 4,
    type: view.getUint16(offset + 2, true),
    length: view.getUint32(offset + 4, true),
  };
}

function* children(view: DataView, parent: RecordHeader): Generator<RecordHeader> {
  const end = parent.offset + 8 + parent.length;
  if (end > view.byteLength) throw new ConversionFailure("damaged", `记录 0x${parent.type.toString(16)} 超出文件`);
  for (let offset = parent.offset + 8; offset + 8 <= end; ) {
    const child = header(view, offset);
    yield child;
    offset += 8 + child.length;
  }
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function atomText(bytes: Uint8Array, record: RecordHeader): string {
  const body = bytes.subarray(record.offset + 8, record.offset + 8 + record.length);
  const text = record.type === TEXT_CHARS_ATOM ? new TextDecoder("utf-16le").decode(body) : new TextDecoder("latin1").decode(body);
  return text.replace(/[\r\v]/gu, "\n").replace(/[ \t]+$/gmu, "");
}

/**
 * 按 [MS-PPT] 读出每张幻灯片的文字：从 Current User 找到最近一次保存，沿保存链合成持久对象目录，
 * 再按 SlideListWithText 的次序逐张遍历幻灯片的形状。占位符里的文字存在 SlideListWithText 里，
 * 形状只留一个 OutlineTextRefAtom 指过去；文本框的文字直接存在形状里。
 */
function presentation(file: CompoundFile): Converted {
  const current = file.stream("Current User");
  const bytes = file.stream("PowerPoint Document");
  if (current === undefined || bytes === undefined) throw new ConversionFailure("damaged", "缺少 PowerPoint 的流");
  const currentView = view(current);
  if (currentView.getUint32(12, true) === ENCRYPTED_TOKEN) throw new ConversionFailure("encrypted");
  const document = view(bytes);

  const persist = new Map<number, number>();
  let documentReference: number | undefined;
  const editsSeen = new Set<number>();
  for (let edit = currentView.getUint32(16, true); ; ) {
    if (editsSeen.has(edit)) throw new ConversionFailure("damaged", "保存记录成环");
    editsSeen.add(edit);
    const record = header(document, edit);
    if (record.type !== USER_EDIT_ATOM) throw new ConversionFailure("damaged", "找不到保存记录");
    // 带 encryptSessionPersistIdRef 的 UserEditAtom 只出现在加密的文件里。
    if (record.length >= 0x20) throw new ConversionFailure("encrypted");
    documentReference ??= document.getUint32(edit + 24, true);
    const directory = header(document, document.getUint32(edit + 20, true));
    if (directory.type !== PERSIST_DIRECTORY_ATOM) throw new ConversionFailure("damaged", "找不到持久对象目录");
    const end = directory.offset + 8 + directory.length;
    for (let offset = directory.offset + 8; offset + 4 <= end; ) {
      const entry = document.getUint32(offset, true);
      offset += 4;
      const first = entry & 0xfffff;
      const count = entry >>> 20;
      // 越新的保存越先读到，旧的同号对象不覆盖它。
      for (let index = 0; index < count; index++, offset += 4) {
        if (!persist.has(first + index)) persist.set(first + index, document.getUint32(offset, true));
      }
    }
    const previous = document.getUint32(edit + 16, true);
    if (previous === 0) break;
    edit = previous;
  }
  const located = (reference: number | undefined): RecordHeader => {
    const offset = reference === undefined ? undefined : persist.get(reference);
    if (offset === undefined) throw new ConversionFailure("damaged", `持久对象 ${reference ?? "?"} 不在目录里`);
    return header(document, offset);
  };

  const container = located(documentReference);
  if (container.type !== DOCUMENT_CONTAINER) throw new ConversionFailure("damaged", "找不到文档记录");
  const slides: Array<{ reference: number; outline: string[] }> = [];
  for (const list of children(document, container)) {
    if (list.type !== SLIDE_LIST_WITH_TEXT || list.instance !== 0) continue;
    for (const record of children(document, list)) {
      if (record.type === SLIDE_PERSIST_ATOM) slides.push({ reference: document.getUint32(record.offset + 8, true), outline: [] });
      else if (record.type === TEXT_CHARS_ATOM || record.type === TEXT_BYTES_ATOM) slides.at(-1)?.outline.push(atomText(bytes, record));
    }
  }

  const isFooter = (shape: RecordHeader): boolean => {
    for (const record of children(document, shape)) {
      if (record.type === PLACEHOLDER_ATOM) return FOOTER_PLACEHOLDERS.has(document.getUint8(record.offset + 8 + 4));
      if (record.container && isFooter(record)) return true;
    }
    return false;
  };
  const collect = (parent: RecordHeader, outline: string[], lines: string[]): void => {
    for (const record of children(document, parent)) {
      if (record.type === TEXT_CHARS_ATOM || record.type === TEXT_BYTES_ATOM) lines.push(atomText(bytes, record));
      else if (record.type === OUTLINE_TEXT_REF_ATOM) lines.push(outline[document.getUint32(record.offset + 8, true)] ?? "");
      else if (record.container && !(record.type === SHAPE_CONTAINER && isFooter(record))) collect(record, outline, lines);
    }
  };
  const parts = slides.map((slide) => {
    const lines: string[] = [];
    collect(located(slide.reference), slide.outline, lines);
    return lines.filter((line) => line.trim() !== "").join("\n");
  });
  return { status: "text", format: "ppt", parts };
}

// [MS-DOC] 的 FIB 标志位。
const ENCRYPTED_FLAG = 0x0100;
const TABLE_STREAM_FLAG = 0x0200;
// Word 97 的 nFib；更小的是 Word 6、Word 95，FIB 的布局不同。
const WORD_97 = 0x00c1;
// FibRgFcLcb97 里 fcClx 是第 33 对。
const CLX_PAIR = 33;
const COMPRESSED_PIECE = 0x40000000;

/**
 * 按 [MS-DOC] 的分段表（piece table）拼出正文：只取正文的 ccpText 个字符，页眉、脚注和文本框不在其中。
 * 域代码只留结果，单元格标记换成分隔符，段落按段落标记分开。
 */
function wordDocument(file: CompoundFile): Converted {
  const bytes = file.stream("WordDocument");
  if (bytes === undefined) throw new ConversionFailure("damaged", "缺少 WordDocument 流");
  const fib = view(bytes);
  if (fib.getUint16(0, true) !== 0xa5ec) throw new ConversionFailure("damaged", "Word 文件头不对");
  if (fib.getUint16(2, true) < WORD_97) throw new ConversionFailure("old_format");
  const flags = fib.getUint16(0x0a, true);
  if ((flags & ENCRYPTED_FLAG) !== 0) throw new ConversionFailure("encrypted");
  const tableBytes = file.stream((flags & TABLE_STREAM_FLAG) !== 0 ? "1Table" : "0Table");
  if (tableBytes === undefined) throw new ConversionFailure("damaged", "缺少表流");
  const table = view(tableBytes);

  const shortCount = fib.getUint16(0x20, true);
  const longStart = 0x22 + shortCount * 2 + 2;
  const longCount = fib.getUint16(0x22 + shortCount * 2, true);
  const textLength = fib.getInt32(longStart + 3 * 4, true);
  const pairStart = longStart + longCount * 4 + 2;
  const clx = fib.getUint32(pairStart + CLX_PAIR * 8, true);

  let offset = clx;
  while (table.getUint8(offset) === 0x01) offset += 3 + table.getUint16(offset + 1, true);
  if (table.getUint8(offset) !== 0x02) throw new ConversionFailure("damaged", "找不到分段表");
  const size = table.getUint32(offset + 1, true);
  const pieces = (size - 4) / 12;
  if (!Number.isInteger(pieces) || pieces < 1) throw new ConversionFailure("damaged", "分段表的长度不对");
  const positions = offset + 5;
  const descriptors = positions + 4 * (pieces + 1);
  let text = "";
  for (let index = 0; index < pieces && text.length < textLength; index++) {
    const start = table.getUint32(positions + 4 * index, true);
    const end = table.getUint32(positions + 4 * (index + 1), true);
    const position = table.getUint32(descriptors + 8 * index + 2, true);
    const length = end - start;
    if ((position & COMPRESSED_PIECE) !== 0) {
      const from = (position & ~COMPRESSED_PIECE) / 2;
      text += cp1252(bytes.subarray(from, from + length));
    } else {
      text += new TextDecoder("utf-16le").decode(bytes.subarray(position, position + 2 * length));
    }
  }
  return { status: "text", format: "doc", parts: paragraphs(text.slice(0, textLength)) };
}

/**
 * Windows-1252 的 0x80–0x9F 这一段，按 WHATWG 编码标准的映射；这段之外与 Latin-1 相同。没有定义的 5 个字节照 WHATWG 映成同值的控制字符。
 * 不用 TextDecoder("windows-1252")：Node 22.19 等版本把这一段解成 C1 控制字符，结果随运行时而变。
 */
const CP1252_HIGH = "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f"
  + "\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";

/** [MS-DOC] 压缩分段的单字节文字按 Windows-1252 解码。 */
function cp1252(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH.charAt(byte - 0x80) : String.fromCharCode(byte);
  return text;
}

function paragraphs(text: string): string[] {
  // 域：0x13 开始、0x14 分开代码与结果、0x15 结束，可以嵌套；只有各层都在结果部分时字符才显示。
  const fields: boolean[] = [];
  let shown = "";
  for (const character of text) {
    if (character === "\u0013") fields.push(false);
    else if (character === "\u0014" && fields.length > 0) fields[fields.length - 1] = true;
    else if (character === "\u0015") fields.pop();
    else if (fields.every((result) => result)) shown += character;
  }
  return shown
    .replace(/\u0001/gu, PICTURE)
    .replace(/\u000b/gu, "\n")
    .replace(/\u001e/gu, "-")
    // 表格的每格以 0x07 结束，一行末尾再多一个 0x07；空格子也会连出两个，所以这里按行切开可能多切，但不会把两行并成一行。
    .replace(/\u0007\u0007/gu, "\r")
    .replace(/\u0007/gu, " | ")
    .replace(/[\u0000-\u0008\u000e-\u001f]/gu, "")
    .split(/[\r\f]/u)
    .map((paragraph) => paragraph.replace(/(?: \| )+$/u, "").replace(/[ \t]+$/gmu, ""))
    .filter((paragraph) => paragraph.trim() !== "");
}

/** 按复合文档里的流分辨 .ppt、.doc 和加密的 OOXML，不看扩展名。 */
export function convertCompoundFile(data: Uint8Array): Converted {
  const file = new CompoundFile(data);
  // 设了打开密码的 .pptx、.docx 也是复合文档，内容加密后放在 EncryptedPackage 里。
  if (file.has("EncryptedPackage")) throw new ConversionFailure("encrypted");
  if (file.has("PowerPoint Document")) return presentation(file);
  if (file.has("WordDocument")) return wordDocument(file);
  if (file.has("PP40")) throw new ConversionFailure("old_format");
  throw new ConversionFailure("unsupported");
}
