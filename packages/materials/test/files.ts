// 测试里现造的小文件：PDF 按规范手写对象与交叉引用表，PPTX、DOCX 是 zip 加 XML，PPT、DOC 由 cfb 写成复合文档。
import CFB from "cfb";
import { strToU8, zipSync } from "fflate";

/** 一个 PDF 页面：内容流与它用到的字体（名字到字体对象正文）。 */
export interface PdfPage {
  content: string;
  fonts?: Record<string, string>;
}

/** 手写一个 PDF，交叉引用表的偏移按实际字节算出。 */
export function pdf(pages: PdfPage[]): Uint8Array {
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids: string[] = [];
  for (const page of pages) {
    const fontReferences: string[] = [];
    for (const [name, font] of Object.entries(page.fonts ?? {})) {
      objects.push(font);
      fontReferences.push(`/${name} ${objects.length} 0 R`);
    }
    objects.push(`<< /Length ${Buffer.byteLength(page.content, "latin1")} >>\nstream\n${page.content}\nendstream`);
    const contents = objects.length;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << ${fontReferences.join(" ")} >> >> /Contents ${contents} 0 R >>`);
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

/**
 * 不嵌入字形、按预定义 CMap 编码的中文字体：pdf.js 要读 encoding 对应的 CMap 才知道字节是哪个字，
 * 再用 Adobe-GB1-UCS2 换成 Unicode。缺 CMap 数据时这样的文字读成空白。
 */
export function cjkFont(encoding: "UniGB-UCS2-H" | "GBK-EUC-H"): string {
  const descriptor = "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>";
  return `<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /${encoding} /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor ${descriptor} >>] >>`;
}

/** 字符对照全指向私用区的字体：pdf.js 读出的都是私用区字符，相当于没有对照的乱码。 */
export function privateUseFont(): string {
  const map = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Garbled def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfrange <20> <7E> <E020> endbfrange endcmap CMapName currentdict /CMap defineresource pop end end";
  return `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode << /Length ${map.length} >>\nstream\n${map}\nendstream >>`;
}

/** 把文字写成 UTF-16BE 的十六进制串，配 UniGB-UCS2-H 使用。 */
export function ucs2(text: string): string {
  return Buffer.from(text, "utf16le").swap16().toString("hex");
}

export function zip(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
}

const A = "xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"";
const P = "xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"";
const R = "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"";

/** 幻灯片里的一个形状：placeholder 写占位符类型，lines 是各段文字。 */
export function shape(lines: string[], placeholder?: string): string {
  const ph = placeholder === undefined ? "" : `<p:nvPr><p:ph type="${placeholder}"/></p:nvPr>`;
  const paragraphs = lines.map((line) => `<a:p><a:r><a:rPr lang="zh-CN"/><a:t>${line}</a:t></a:r></a:p>`).join("");
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="形状"/><p:cNvSpPr/>${ph}</p:nvSpPr><p:txBody><a:bodyPr/>${paragraphs}</p:txBody></p:sp>`;
}

/**
 * 一个 PPTX：slides 按放映次序给出各张的形状。文件名故意与次序相反（第一张是 slide{n}.xml），
 * 读取方必须按 presentation.xml 的次序而不是文件名排。
 */
export function pptx(slides: string[]): Uint8Array {
  const files: Record<string, string> = {
    "[Content_Types].xml": "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>",
  };
  const ids: string[] = [];
  const relationships: string[] = [];
  slides.forEach((body, index) => {
    const number = slides.length - index;
    ids.push(`<p:sldId id="${256 + index}" r:id="rId${index + 7}"/>`);
    relationships.push(`<Relationship Id="rId${index + 7}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${number}.xml"/>`);
    files[`ppt/slides/slide${number}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld ${A} ${P} ${R}><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
  });
  files["ppt/presentation.xml"] = `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${A} ${P} ${R}><p:sldIdLst>${ids.join("")}</p:sldIdLst></p:presentation>`;
  files["ppt/_rels/presentation.xml.rels"] = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join("")}</Relationships>`;
  return zip(files);
}

/** 一个 DOCX，body 是 w:body 里的内容。 */
export function docx(body: string): Uint8Array {
  return zip({
    "[Content_Types].xml": "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>",
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>${body}</w:body></w:document>`,
  });
}

/** Word 的一个段落。 */
export function paragraph(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function compoundFile(streams: Record<string, Uint8Array>): Uint8Array {
  const container = CFB.utils.cfb_new();
  for (const [name, content] of Object.entries(streams)) CFB.utils.cfb_add(container, `/${name}`, content);
  return new Uint8Array(CFB.write(container, { type: "buffer" }) as Buffer);
}

/** [MS-PPT] 的一条记录：8 字节的头加正文。 */
function record(type: number, body: Uint8Array | Uint8Array[], options: { instance?: number } = {}): Uint8Array {
  const container = Array.isArray(body);
  const content = container ? Buffer.concat(body) : body;
  const head = Buffer.alloc(8);
  head.writeUInt16LE(((options.instance ?? 0) << 4) | (container ? 0x0f : 0), 0);
  head.writeUInt16LE(type, 2);
  head.writeUInt32LE(content.length, 4);
  return Buffer.concat([head, content]);
}

function u32(...values: number[]): Uint8Array {
  const buffer = Buffer.alloc(4 * values.length);
  values.forEach((value, index) => buffer.writeUInt32LE(value, 4 * index));
  return buffer;
}

function placeholder(type: number): Uint8Array {
  const body = Buffer.alloc(8);
  body.writeUInt8(type, 4);
  return record(0xf011, [record(0x0bc3, body)]);
}

const textChars = (text: string) => record(0x0fa0, Buffer.from(text, "utf16le"));
const textBytes = (text: string) => record(0x0fa8, Buffer.from(text, "latin1"));
const textHeader = () => record(0x0f9f, u32(0));
const shapeRecord = (children: Uint8Array[]) => record(0xf004, children);
const slideRecord = (shapes: Uint8Array[]) => record(0x03ee, [record(0x040c, [record(0xf002, [record(0xf003, shapes)])])]);

/**
 * 一个两张幻灯片的 PPT。第一张的标题是占位符，文字放在 SlideListWithText 里，形状只经 OutlineTextRefAtom 指过去；
 * 另有一个文本框和一个页码占位符。第二张的标题按单字节存。encrypted 时写加密文件的 headerToken。
 */
export function ppt(options: { encrypted?: boolean } = {}): Uint8Array {
  const slideList = record(0x0ff0, [
    record(0x03f3, u32(2, 0, 1, 256, 0)),
    textHeader(),
    textChars("进程与线程\r两者的区别"),
    record(0x03f3, u32(3, 0, 1, 257, 0)),
    textHeader(),
    textBytes("Deadlock"),
  ]);
  const documentContainer = record(0x03e8, [slideList]);
  const first = slideRecord([
    shapeRecord([placeholder(0x0d), record(0xf00d, [record(0x0f9e, u32(0))])]),
    shapeRecord([record(0xf00d, [textHeader(), textChars("文本框：PCB")])]),
    shapeRecord([placeholder(0x08), record(0xf00d, [textHeader(), textChars("第*页")])]),
  ]);
  const second = slideRecord([
    shapeRecord([placeholder(0x0d), record(0xf00d, [record(0x0f9e, u32(0))])]),
  ]);
  const documentOffset = 0;
  const firstOffset = documentContainer.length;
  const secondOffset = firstOffset + first.length;
  const directoryOffset = secondOffset + second.length;
  const directory = record(0x1772, u32((3 << 20) | 1, documentOffset, firstOffset, secondOffset));
  const editOffset = directoryOffset + directory.length;
  const edit = record(0x0ff5, Buffer.concat([u32(256), Buffer.from([0, 3, 0, 3]), u32(0, directoryOffset, 1, 4), Buffer.alloc(4)]));
  const current = Buffer.concat([
    record(0x0ff6, Buffer.concat([u32(0x14, options.encrypted === true ? 0xf3d1c4df : 0xe391c05f, editOffset), Buffer.alloc(8)])),
  ]);
  return compoundFile({
    "Current User": current,
    "PowerPoint Document": Buffer.concat([documentContainer, first, second, directory, edit]),
  });
}

/**
 * 一个 DOC：正文由两个分段拼成，第一段按 UTF-16 存，第二段按单字节压缩存；正文之后还有一段不属于正文的文字
 * （例如脚注），读取方只能取 ccpText 个字符。
 */
export function doc(options: { main: string; compressed: string; trailing: string; encrypted?: boolean }): Uint8Array {
  const fib = Buffer.alloc(1024);
  fib.writeUInt16LE(0xa5ec, 0);
  fib.writeUInt16LE(0x00c1, 2);
  fib.writeUInt16LE(0x0200 | (options.encrypted === true ? 0x0100 : 0), 0x0a);
  fib.writeUInt16LE(14, 0x20);
  fib.writeUInt16LE(22, 0x3e);
  fib.writeInt32LE(options.main.length + options.compressed.length, 0x4c);
  fib.writeUInt16LE(93, 0x98);
  const unicode = Buffer.from(options.main + options.trailing, "utf16le");
  const compressedAt = fib.length + unicode.length;
  const compressed = Buffer.from(options.compressed, "latin1");
  const pieces = [
    { length: options.main.length, position: fib.length },
    { length: options.compressed.length, position: (compressedAt * 2) | 0x40000000 },
    { length: options.trailing.length, position: fib.length + 2 * options.main.length },
  ];
  const positions: number[] = [0];
  for (const piece of pieces) positions.push((positions.at(-1) ?? 0) + piece.length);
  const descriptors = Buffer.concat(pieces.map((piece) => {
    const descriptor = Buffer.alloc(8);
    descriptor.writeUInt32LE(piece.position >>> 0, 2);
    return descriptor;
  }));
  const pieceTable = Buffer.concat([Buffer.from(u32(...positions)), descriptors]);
  const table = Buffer.concat([
    // 一项格式属性（Prc），读取方要跳过它才找得到分段表。
    Buffer.from([0x01, 0x02, 0x00, 0xaa, 0xbb]),
    Buffer.from([0x02]),
    Buffer.from(u32(pieceTable.length)),
    pieceTable,
  ]);
  fib.writeUInt32LE(0, 0x1a2);
  fib.writeUInt32LE(table.length, 0x1a6);
  return compoundFile({ WordDocument: Buffer.concat([fib, unicode, compressed]), "1Table": table });
}

/** 设了打开密码的 OOXML 的样子：复合文档里放着 EncryptedPackage。 */
export function encryptedOoxml(): Uint8Array {
  return compoundFile({ EncryptionInfo: Buffer.from("info"), EncryptedPackage: Buffer.alloc(5000, 7) });
}
