import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { convert } from "../src/convert.js";
import type { Converted } from "../src/result.js";
import { cjkFont, doc, docx, encryptedOoxml, paragraph, pdf, ppt, pptx, privateUseFont, shape, ucs2, zip } from "./files.js";

const signal = new AbortController().signal;

function failure(result: Converted): string | undefined {
  return result.status === "failed" ? result.reason : undefined;
}

test("中文 PDF 按页读出：不嵌入字体、靠预定义 CMap 编码的文字读得出，没有文字的一页如实标出", async () => {
  const result = await convert(pdf([
    { content: `BT /F1 24 Tf 72 700 Td <${ucs2("中文课件")}> Tj ET`, fonts: { F1: cjkFont("UniGB-UCS2-H") } },
    { content: "0 0 m 100 100 l S" },
    // GBK 编码的“操作系统”。
    { content: "BT /F1 24 Tf 72 700 Td <b2d9d7f7cfb5cdb3> Tj 0 -30 Td <c4dabacb> Tj ET", fonts: { F1: cjkFont("GBK-EUC-H") } },
  ]), "pdf", signal);
  assert.deepEqual(result, { status: "text", format: "pdf", parts: ["中文课件", { missing: "no_text" }, "操作系统\n内核"] });
});

test("PDF 读不出文字的几种情形各给出原因：扫描件、乱码、加密、损坏", async () => {
  const blank = pdf([{ content: "0 0 m 100 100 l S" }, { content: "" }]);
  assert.equal(failure(await convert(blank, "pdf", signal)), "scanned");

  const garbled = pdf([{ content: "BT /F1 12 Tf 72 700 Td (ABCDEFGHIJ) Tj ET", fonts: { F1: privateUseFont() } }]);
  assert.equal(failure(await convert(garbled, "pdf", signal)), "garbled");

  // mutool 1.23 用 AES-128 加密的一页 PDF，打开密码是 user。
  const encrypted = new Uint8Array(await readFile(new URL("fixtures/encrypted.pdf", import.meta.url)));
  assert.equal(failure(await convert(encrypted, "pdf", signal)), "encrypted");

  const whole = pdf([{ content: `BT /F1 24 Tf 72 700 Td <${ucs2("中文")}> Tj ET`, fonts: { F1: cjkFont("UniGB-UCS2-H") } }]);
  assert.equal(failure(await convert(whole.subarray(0, 40), "pdf", signal)), "damaged");
});

test("PPTX 按放映次序逐张读出，跳过页码与页脚，表格一行一行，图片留下标记", async () => {
  const table = "<p:graphicFrame><a:graphic><a:graphicData><a:tbl>"
    + "<a:tr><a:tc><a:txBody><a:p><a:r><a:t>进程</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>线程</a:t></a:r></a:p></a:txBody></a:tc></a:tr>"
    + "<a:tr><a:tc><a:txBody><a:p><a:r><a:t>资源单位</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p/></a:txBody></a:tc></a:tr>"
    + "</a:tbl></a:graphicData></a:graphic></p:graphicFrame>";
  const result = await convert(pptx([
    shape(["第一章 引论"], "title") + shape(["操作系统是&lt;资源管理者&gt; &amp; 服务者", "第二段<a:br/>换行"]) + shape(["3"], "sldNum") + shape(["2026 秋"], "dt"),
    "<p:pic><p:nvPicPr/></p:pic>" + table,
    "",
  ]), "zip", signal);
  assert.deepEqual(result, {
    status: "text",
    format: "pptx",
    parts: [
      "第一章 引论\n操作系统是<资源管理者> & 服务者\n第二段\n换行",
      "[图片]\n进程 | 线程\n资源单位 | ",
      "",
    ],
  });
});

test("DOCX 按段读出：表格一行一块，正文的制表符保留，段落属性里的制表位与给旧程序看的副本不读", async () => {
  const body = [
    paragraph("第一章　进程管理"),
    "<w:p><w:pPr><w:tabs><w:tab w:val=\"left\" w:pos=\"420\"/></w:tabs></w:pPr><w:r><w:t>1</w:t></w:r><w:r><w:tab/><w:t>什么是进程？</w:t></w:r></w:p>",
    "<w:p></w:p>",
    "<w:tbl><w:tr><w:tc>" + paragraph("页号") + "</w:tc><w:tc>" + paragraph("块号") + "</w:tc></w:tr>"
      + "<w:tr><w:tc>" + paragraph("0") + "</w:tc><w:tc>" + paragraph("5") + "</w:tc></w:tr></w:tbl>",
    "<w:p><w:r><mc:AlternateContent><mc:Choice><w:drawing/></mc:Choice><mc:Fallback><w:pict/></mc:Fallback></mc:AlternateContent></w:r><w:r><w:t>如图</w:t></w:r></w:p>",
    "<w:p><w:r><w:t>见</w:t></w:r><w:r><w:instrText> PAGEREF _Toc1 </w:instrText></w:r><w:del><w:r><w:delText>删掉的</w:delText></w:r></w:del><w:r><w:t>第 3 页</w:t></w:r></w:p>",
  ].join("");
  const result = await convert(docx(body), "zip", signal);
  assert.deepEqual(result, {
    status: "text",
    format: "docx",
    parts: ["第一章　进程管理", "1\t什么是进程？", "页号 | 块号", "0 | 5", "[图片]如图", "见第 3 页"],
  });
});

test("PPT 逐张读出：占位符的文字经 OutlineTextRefAtom 取回，文本框照读，页码占位符跳过", async () => {
  const result = await convert(ppt(), "compound", signal);
  assert.deepEqual(result, {
    status: "text",
    format: "ppt",
    parts: ["进程与线程\n两者的区别\n文本框：PCB", "Deadlock"],
  });
  assert.equal(failure(await convert(ppt({ encrypted: true }), "compound", signal)), "encrypted");
});

test("DOC 拼出正文：只取正文长度，域只留结果，表格单元换成分隔符，压缩存放的一段按单字节读", async () => {
  const main = "第1章 概论\r见\u0013 PAGEREF _Toc \u0014第 2 页\u0015。\r页号\u0007块号\u0007\u0007\r\r";
  const result = await convert(doc({ main, compressed: "Café OS\r", trailing: "脚注不属于正文\r" }), "compound", signal);
  assert.deepEqual(result, {
    status: "text",
    format: "doc",
    parts: ["第1章 概论", "见第 2 页。", "页号 | 块号", "Café OS"],
  });
  assert.equal(failure(await convert(doc({ main, compressed: "", trailing: "", encrypted: true }), "compound", signal)), "encrypted");
});

test("加密的 OOXML、不认识的 zip、空的文档和坏的复合文档各给出原因，不会卡住", async () => {
  assert.equal(failure(await convert(encryptedOoxml(), "compound", signal)), "encrypted");
  assert.equal(failure(await convert(zip({ "xl/workbook.xml": "<workbook/>" }), "zip", signal)), "unsupported");
  assert.equal(failure(await convert(pptx(["", "<p:pic/>"]), "zip", signal)), "no_text");
  assert.equal(failure(await convert(docx("<w:p><w:r><w:drawing/></w:r></w:p>"), "zip", signal)), "no_text");
  assert.equal(failure(await convert(pptx([shape(["标题"])]).subarray(0, 60), "zip", signal)), "damaged");

  // 让分配表里第一个扇区指向自己：扇区链成环。
  const looped = new Uint8Array(ppt());
  const view = new DataView(looped.buffer);
  const sectorSize = 1 << view.getUint16(0x1e, true);
  const fatSector = view.getUint32(0x4c, true);
  const directorySector = view.getUint32(0x30, true);
  view.setUint32((fatSector + 1) * sectorSize + 4 * directorySector, directorySector, true);
  assert.equal(failure(await convert(looped, "compound", signal)), "damaged");
});
