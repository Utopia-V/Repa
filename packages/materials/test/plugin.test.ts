import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { createPluginTestHost, type PluginTestHost } from "@repa/base/testing";

import { conversionCount } from "../src/convert.js";
import { Materials } from "../src/materials.js";
import { materialsPlugin, READ_BYTE_LIMIT, READ_LINE_LIMIT } from "../src/plugin.js";
import { cjkFont, docx, paragraph, pdf, pptx, shape, ucs2 } from "./files.js";

const fault = (code: string) => (error: unknown): boolean => error instanceof Error && "code" in error && error.code === code;

async function fixture(t: TestContext) {
  const testing = await createPluginTestHost({ plugins: [materialsPlugin] });
  t.after(() => testing.close());
  await testing.host.start();
  return testing;
}

async function put(testing: PluginTestHost, file: string, content: Uint8Array | string): Promise<void> {
  const target = path.join(testing.space.root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function call(testing: PluginTestHost, name: string, input: unknown): Promise<string> {
  const tool = testing.host.tools().find((item) => item.name === name);
  assert.ok(tool, `没有工具 ${name}`);
  const result = await tool.execute(input, { signal: new AbortController().signal, callId: `call-${name}` });
  return result.text;
}

/** 空间里除 .repa 以外的全部文件及其内容，用来确认工具没有写空间。 */
async function spaceFiles(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.relative(root, path.join(entry.parentPath, entry.name));
    if (file.split(path.sep)[0] === ".repa") continue;
    result.set(file, (await readFile(path.join(root, file))).toString("base64"));
  }
  return result;
}

const chinesePdf = (pages: string[]) => pdf(pages.map((text) => ({
  content: `BT /F1 18 Tf 72 700 Td <${ucs2(text)}> Tj ET`,
  fonts: { F1: cjkFont("UniGB-UCS2-H") },
})));

test("列出 materials/ 的文件：能读的给出页数或段数，读不了的给出原因，坏文件不影响其余文件和插件", async (t) => {
  const testing = await fixture(t);
  assert.match(await call(testing, "materials_list", {}), /还没有 materials\/ 文件夹/u);

  await put(testing, "materials/第一章.pdf", chinesePdf(["进程", "线程"]));
  await put(testing, "materials/习题/作业.docx", docx(paragraph("第一题") + paragraph("第二题") + paragraph("第三题")));
  await put(testing, "materials/扫描.pdf", pdf([{ content: "0 0 m 9 9 l S" }]));
  await put(testing, "materials/坏了.pdf", "%PDF-1.4\n这不是完整的 PDF");
  await put(testing, "materials/笔记.md", "# 笔记\n");
  await put(testing, "materials/引论.pptx", pptx([shape(["第一章 引论"], "title"), ""]));
  await put(testing, "materials/图.png", Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0));
  await put(testing, "materials/.DS_Store", Uint8Array.of(0, 0, 0, 1));

  const listing = await call(testing, "materials_list", {});
  assert.equal(listing, [
    "materials/ 里有 7 个文件：",
    "- materials/习题/作业.docx：Word 文档，3 段",
    "- materials/图.png：读不出文字：不支持这种格式；能读出文字的是 PDF、PPTX、PPT、DOCX 和 DOC。",
    "- materials/坏了.pdf：读不出文字：文件已损坏或不完整，打不开（Invalid PDF structure.）。",
    "- materials/引论.pptx：PowerPoint 幻灯片，2 张",
    "- materials/扫描.pdf：读不出文字：这份 PDF 没有文字层，可能是扫描件或图片，读不出文字。",
    "- materials/笔记.md：文字文件，用 read 直接读",
    "- materials/第一章.pdf：PDF，2 页",
  ].join("\n"));
  assert.equal(await call(testing, "materials_read", { path: "materials/第一章.pdf" }), "materials/第一章.pdf（PDF，共 2 页）第 1–2 页：\n\n〔第 1 页〕\n进程\n\n〔第 2 页〕\n线程");
  assert.equal(await call(testing, "materials_read", { path: "materials/引论.pptx" }), "materials/引论.pptx（PowerPoint 幻灯片，共 2 张）第 1–2 张：\n\n〔第 1 张〕\n第一章 引论\n\n〔第 2 张〕\n（这一张没有文字）");
  assert.equal(await call(testing, "materials_read", { path: "materials/扫描.pdf" }), "materials/扫描.pdf 读不出文字：这份 PDF 没有文字层，可能是扫描件或图片，读不出文字。");
  assert.deepEqual(testing.host.disabled(), []);
  assert.deepEqual(testing.errors, []);
});

test("按段分批读一份长文档：每批不超过输出上限，按提示的 from 接着读，拼起来不丢段、不重段", async (t) => {
  const testing = await fixture(t);
  const paragraphs = Array.from({ length: 900 }, (_, index) => `第 ${index + 1} 题：${"进程同步与互斥".repeat(index % 7 + 1)}`);
  await put(testing, "materials/题库.docx", docx(paragraphs.map(paragraph).join("")));

  const seen: string[] = [];
  let from = 1;
  let batches = 0;
  for (;;) {
    const text = await call(testing, "materials_read", { path: "materials/题库.docx", from });
    batches += 1;
    assert.ok(Buffer.byteLength(text) <= READ_BYTE_LIMIT, `第 ${batches} 批 ${Buffer.byteLength(text)} 字节`);
    assert.ok(text.split("\n").length <= READ_LINE_LIMIT);
    for (const match of text.matchAll(/^〔第 (\d+) 段〕 (.*)$/gmu)) {
      assert.equal(Number(match[1]), seen.length + 1);
      seen.push(match[2] ?? "");
    }
    const next = /from 填 (\d+)/u.exec(text);
    if (next === null) break;
    from = Number(next[1]);
  }
  assert.deepEqual(seen, paragraphs);
  assert.ok(batches > 1);

  assert.equal(
    await call(testing, "materials_read", { path: "materials/题库.docx", from: 3, to: 4 }),
    `materials/题库.docx（Word 文档，共 900 段）第 3–4 段：\n\n〔第 3 段〕 ${paragraphs[2] ?? ""}\n〔第 4 段〕 ${paragraphs[3] ?? ""}\n\n（后面还有第 5–900 段。）`,
  );
  await assert.rejects(call(testing, "materials_read", { path: "materials/题库.docx", from: 901 }), fault("invalid_range"));
});

test("工具不写空间：转换结果缓存在插件的数据目录，同一内容不再解析，换个名字也一样", async (t) => {
  const testing = await fixture(t);
  await put(testing, "materials/讲义.pdf", chinesePdf(["死锁"]));
  const before = await spaceFiles(testing.space.root);
  const revisions = await testing.space.history.list(10);

  const start = conversionCount();
  await call(testing, "materials_list", {});
  await call(testing, "materials_read", { path: "materials/讲义.pdf" });
  assert.equal(conversionCount() - start, 1);

  await put(testing, "materials/讲义副本.pdf", chinesePdf(["死锁"]));
  await call(testing, "materials_read", { path: "materials/讲义副本.pdf" });
  assert.equal(conversionCount() - start, 1);
  await rm(path.join(testing.space.root, "materials/讲义副本.pdf"));

  assert.deepEqual(await spaceFiles(testing.space.root), before);
  assert.deepEqual(await testing.space.history.list(10), revisions);
  const cache = await readdir(path.join(testing.space.dataDir, "plugins", "materials", "cache"));
  assert.equal(cache.length, 1);
});

test("缓存跨实例保留：重新打开后不再解析；缓存文件坏了就重新转换并覆盖", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-materials-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "space");
  const data = path.join(directory, "data");
  await mkdir(path.join(root, "materials"), { recursive: true });
  await writeFile(path.join(root, "materials", "a.pdf"), chinesePdf(["页表"]));
  const signal = new AbortController().signal;

  const start = conversionCount();
  await new Materials(root, data).read("materials/a.pdf", signal);
  const reopened = await new Materials(root, data).read("materials/a.pdf", signal);
  assert.equal(conversionCount() - start, 1);
  assert.deepEqual(reopened.outcome, { status: "text", format: "pdf", parts: ["页表"] });

  const [file] = await readdir(path.join(data, "cache"));
  assert.ok(file);
  await writeFile(path.join(data, "cache", file), "{\"version\":");
  const repaired = await new Materials(root, data).read("materials/a.pdf", signal);
  assert.equal(conversionCount() - start, 2);
  assert.deepEqual(repaired.outcome, reopened.outcome);
});

test("只读空间里的文件：空间外的路径和指向空间外的链接都拒绝", async (t) => {
  const testing = await fixture(t);
  const outside = path.join(testing.directory, "outside.pdf");
  await writeFile(outside, chinesePdf(["外面"]));
  await mkdir(path.join(testing.space.root, "materials"), { recursive: true });
  await symlink(outside, path.join(testing.space.root, "materials", "链接.pdf"));

  await assert.rejects(call(testing, "materials_read", { path: "../outside.pdf" }), fault("file_outside_space"));
  await assert.rejects(call(testing, "materials_read", { path: outside }), fault("file_outside_space"));
  await assert.rejects(call(testing, "materials_read", { path: "materials/链接.pdf" }), fault("file_outside_space"));
  await assert.rejects(call(testing, "materials_read", { path: "materials/没有.pdf" }), fault("file_not_found"));
  assert.equal(await call(testing, "materials_list", {}), "materials/ 里还没有文件。");
});
