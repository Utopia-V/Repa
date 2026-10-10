import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Check } from "typebox/value";
import { RepaClient, RpcError, startRepaServer, type BackgroundRequest, type ContentTarget, type SettingScope } from "repa";
import { RepresentationSchema } from "repa/protocol";
import { EXTRACT_CONTRACT, ExtractDataSchema, type ExtractInput } from "../dist/index.js";
import { parse } from "../dist/parser.js";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const application = { kind: "application" as const };
const fault = (code: string) => (error: unknown) => error instanceof RpcError &&
  error.data !== null && typeof error.data === "object" && "code" in error.data && error.data.code === code;
async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) assert.fail(`材料处理超时：${JSON.stringify(value)}`);
    await delay(10);
  }
}
async function set(client: RepaClient, scope: SettingScope, namespace: string, key: string, value: unknown) {
  const settings = await client.call("settings.get", { scope, namespace });
  const entry = settings.entries.find(entry => entry.key === key);
  assert(entry);
  return client.call("settings.set", { scope, namespace, key, value, base: entry.revision });
}
// 两页真实 PDF，xref 使用实际字节偏移；不用生成库或模型伪造解析结果。
function smallPdf() {
  const streams = ["BT /F1 12 Tf 40 120 Td (First actual page) Tj ET", "BT /F1 12 Tf 40 120 Td (Second actual page) Tj ET"];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...streams.map(stream => `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`),
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6woAAAAASUVORK5CYII=", "base64");

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-materials-test-"));
  const opened: {
    server?: Awaited<ReturnType<typeof startRepaServer>>;
    client?: RepaClient;
  } = {};
  t.after(async () => {
    try {
      await opened.server?.close("cancel");
    } finally {
      try {
        await opened.client?.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  const agentDir = path.join(root, "agent");
  const directory = path.join(root, "space");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [packageDirectory],
    extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"] }));
  const server = await startRepaServer({ agentDir, appDirectory: path.join(root, "app") });
  opened.server = server;
  const client = await RepaClient.connect(server.connection);
  opened.client = client;
  const space = await client.call("space.open", { path: directory });
  const scope = { kind: "space" as const, spaceId: space.id };
  await set(client, application, "plugins", "backends", [{ id: "materials", package: { kind: "package", name: "@repa/materials" } }]);
  await set(client, application, "plugins", "trusted", [{ kind: "package", name: "@repa/materials" }]);
  const describe = await client.call("capability.describe", { scope });
  assert(describe.capabilities.some(item => item.contract.id === EXTRACT_CONTRACT.id));
  assert(describe.packages.some(item => item.name === "@repa/materials" && item.backend?.status === "ready" && !item.piResources));
  const target = (file: string): ContentTarget => ({ kind: "file", spaceId: space.id, location: { kind: "relative", path: file } });
  const put = async (file: string, bytes: Uint8Array) => {
    const uploaded = await client.uploadResource(space.id, bytes, "application/octet-stream");
    await client.call("content.write", { target: target(file), operationId: randomUUID(), base: { kind: "absent" }, value: { kind: "resource", resource: uploaded.resource } });
    const associated = await client.call("content.associate", { spaceId: space.id, location: { kind: "relative", path: file }, role: "material", operationId: randomUUID() });
    const ref = associated.contents[0]?.ref;
    assert(ref);
    return { kind: "content" as const, ref };
  };
  const invoke = async (input: ExtractInput) => {
    const result = await client.call("capability.invoke", { scope, requestId: randomUUID(), contract: EXTRACT_CONTRACT, input });
    assert.equal(result.kind, "background");
    if (result.kind !== "background") assert.fail("材料能力必须后台受理");
    return result.request;
  };
  const finished = async (request: BackgroundRequest) => {
    const stored = await until(() => client.call("request.get", { spaceId: space.id, requestId: request.requestId }),
      value => ["completed", "failed", "cancelled", "interrupted"].includes(value.status));
    assert("operation" in stored);
    return stored;
  };
  const extract = async (input: ExtractInput) => {
    const stored = await finished(await invoke(input));
    assert.equal(stored.status, "completed", JSON.stringify(stored));
    assert(stored.result?.value.kind === "inline");
    assert(Check(RepresentationSchema, stored.result.value.data));
    const representation = stored.result.value.data;
    assert(representation.value.kind === "inline");
    assert(Check(ExtractDataSchema, representation.value.data));
    assert.deepEqual(stored.result.sources, representation.sources);
    assert.deepEqual(stored.result.resources, representation.resources);
    return { stored, representation, data: representation.value.data };
  };
  return { root, directory, space, scope, client, target, put, invoke, finished, extract };
}

test("可安装纯后台包无模型提取文本、HTML、PDF和图片，实际来源定位保留且重提取不覆盖人工稿", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.client.call("connection.list", {}), []);
  await set(f.client, application, "repa.materials", "pdfinfo", "/usr/bin/pdfinfo");
  await set(f.client, application, "repa.materials", "pdftotext", "/usr/bin/pdftotext");
  const original = "# 题目\r\n正文保持换行\r\n```ts\r\nconst answer = 42;\r\n```\r\n";
  const markdown = await f.put("source.md", Buffer.from(original));
  const view = await f.client.call("content.read", { target: markdown });
  const bodyRevision = view.content.bodyRevision;
  assert(bodyRevision);
  const text = await f.extract({ target: markdown, expectedBodyRevision: bodyRevision, range: { kind: "lines", start: 2, end: 4 } });
  assert.equal(text.data.status, "ready");
  assert.equal(text.data.segments.map(segment => segment.text).join(""), "正文保持换行\r\n```ts\r\nconst answer = 42;\r\n");
  assert.deepEqual(text.representation.sources.map(source => source.locator?.value), [{ line: 2 }, { line: 3 }, { line: 4 }]);
  assert(text.representation.sources.every(source => source.revision === bodyRevision));
  for (const file of ["plain.txt", "sample.py"]) {
    const ref = await f.put(file, Buffer.from("first\nsecond\n"));
    assert.equal((await f.extract({ target: ref, range: { kind: "lines", start: 2 } })).data.segments[0]?.text, "second\n");
  }
  const marker = path.join(f.root, "html-script-executed");
  const html = await f.put("article.html", Buffer.from(`<html><head><title>实际网页原件</title></head><body><article><h1>阅读标题</h1><p>${"这是来自已保存网页的真实正文。".repeat(45)}</p><p>末尾独立段落。</p></article><script>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')</script><img src="http://127.0.0.1:1/not-requested"></body></html>`));
  const article = await f.extract({ target: html });
  assert.equal(article.data.status, "ready");
  assert.equal(article.data.reader.name, "readability");
  assert.match(article.data.segments.map(segment => segment.text).join("\n"), /真实正文/);
  assert.equal(existsSync(marker), false);
  const document = await f.put("document.pdf", smallPdf());
  const pdf = await f.extract({ target: document, range: { kind: "pages", start: 2, end: 2 } });
  assert.equal(pdf.data.status, "ready");
  assert.equal(pdf.data.total, 2);
  assert.match(pdf.data.segments[0]?.text ?? "", /Second actual page/);
  assert.deepEqual(pdf.representation.sources[0]?.locator?.value, { page: 2 });
  assert.equal(pdf.data.reader.name, "poppler");
  assert(pdf.data.reader.version);
  const image = await f.put("pixel.png", png);
  const picture = await f.extract({ target: image });
  assert.equal(picture.data.status, "ready");
  assert.deepEqual(picture.data.image, { format: "png", width: 1, height: 1 });
  const resource = picture.representation.resources[0];
  assert(resource);
  assert.deepEqual(Buffer.from(await (await f.client.resource(resource)).arrayBuffer()), png);
  await f.client.call("content.write", { target: f.target("human.md"), operationId: randomUUID(), base: { kind: "absent" }, value: { kind: "text", text: "人工校订不得被重提取覆盖。" } });
  await f.extract({ target: markdown });
  assert.equal((await f.client.readText(f.target("human.md"))).text, "人工校订不得被重提取覆盖。");
  assert.equal((await f.client.readText(markdown)).text, original);
  await rm(path.join(f.directory, "source.md"));
  assert.equal((await f.client.call("content.get", { target: markdown })).status, "missing");
  assert.deepEqual(await f.client.call("request.get", { spaceId: f.space.id, requestId: text.stored.requestId }), text.stored);
  const oldResource = text.representation.resources[0];
  assert(oldResource);
  assert.equal(await (await f.client.resource(oldResource)).text(), original);
});

test("未知格式、损坏原件与缺失PDF依赖有不同结果，版本不匹配不会开始提取", async (t) => {
  const f = await fixture(t);
  const unknown = await f.put("binary.unknown", Buffer.from([0, 1, 2, 3]));
  assert.equal((await f.extract({ target: unknown })).data.status, "unsupported");
  const damaged = await f.put("damaged.pdf", Buffer.from("%PDF-1.4\nnot an actual document"));
  await set(f.client, application, "repa.materials", "pdfinfo", "/usr/bin/pdfinfo");
  assert.equal((await f.extract({ target: damaged })).data.status, "invalid");
  const document = await f.put("actual.pdf", smallPdf());
  await set(f.client, application, "repa.materials", "pdfinfo", path.join(f.root, "not-installed-pdfinfo"));
  assert.equal((await f.extract({ target: document })).data.status, "dependency_missing");
  const failed = await f.finished(await f.invoke({ target: document, expectedBodyRevision: "wrong-body-version" }));
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.code, "revision_conflict");
  await assert.rejects(f.client.call("content.read", { target: document, revision: "wrong-body-version" }), fault("revision_conflict"));
});

test("超限材料在读取正文前结束，不保存大blob或启动PDF解析且原件保持不变", async (t) => {
  const f = await fixture(t);
  const original = Buffer.alloc(33 * 1024 * 1024, " ");
  smallPdf().copy(original);
  const file = path.join(f.directory, "large.pdf");
  await writeFile(file, original);
  const associated = await f.client.call("content.associate", {
    spaceId: f.space.id, location: { kind: "relative", path: "large.pdf" }, role: "material", operationId: randomUUID(),
  });
  const ref = associated.contents[0]?.ref;
  assert(ref);
  const marker = path.join(f.root, "pdf-parser-started");
  const wrapper = path.join(f.root, "pdfinfo-wrapper");
  await writeFile(wrapper, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');\nrequire('node:child_process').execFileSync('/usr/bin/pdfinfo', process.argv.slice(2), {stdio:'inherit'});\n`);
  await chmod(wrapper, 0o755);
  await set(f.client, application, "repa.materials", "pdfinfo", wrapper);
  const directory = path.join(f.directory, ".repa", "content", "blobs");
  const before = await readdir(directory);
  const extracted = await f.extract({ target: { kind: "content", ref } });
  assert.equal(extracted.data.status, "limit_exceeded");
  assert.equal(extracted.data.kind, "unknown");
  assert.equal(extracted.data.reader.name, "none");
  assert.equal(extracted.data.issues[0]?.code, "input_limit");
  assert.deepEqual(extracted.data.segments, []);
  assert.deepEqual(extracted.representation.sources, []);
  assert.deepEqual(extracted.representation.resources, []);
  assert.equal(extracted.stored.progress, undefined);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(await readdir(directory), before);
  assert((await readFile(file)).equals(original));
});

test("取消真实PDF处理等待工具退出且不占内容队列，CPU worker取消也等待退出", async (t) => {
  const f = await fixture(t);
  const source = await f.put("actual.pdf", smallPdf());
  const fifo = path.join(f.root, "exit.fifo");
  await promisify(execFile)("mkfifo", [fifo]);
  const started = path.join(f.root, "started");
  const cancelled = path.join(f.root, "cancelled");
  const exited = path.join(f.root, "exited");
  const wrapper = path.join(f.root, "pdftotext-wrapper");
  await writeFile(wrapper, `#!${process.execPath}\nconst {spawn}=require('node:child_process');const fs=require('node:fs');const promises=require('node:fs/promises');\nconst child=spawn('/usr/bin/pdftotext',process.argv.slice(2),{stdio:['ignore','inherit','inherit']});child.on('close',code=>{if(code!==0)process.exit(code??1);fs.writeFileSync(${JSON.stringify(started)},'parsed');});\nprocess.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(cancelled)},'cancelled');promises.readFile(${JSON.stringify(fifo)}).then(()=>{fs.writeFileSync(${JSON.stringify(exited)},'exited');process.exit(0);});});setInterval(()=>{},10000);\n`);
  await chmod(wrapper, 0o755);
  await set(f.client, application, "repa.materials", "pdfinfo", "/usr/bin/pdfinfo");
  await set(f.client, application, "repa.materials", "pdftotext", wrapper);
  const accepted = await f.invoke({ target: source, range: { kind: "pages", start: 1, end: 1 } });
  await until(() => existsSync(started), Boolean);
  await f.client.call("content.write", { target: f.target("while-processing.md"), operationId: randomUUID(), base: { kind: "absent" }, value: { kind: "text", text: "解析不占共同内容队列" } });
  await f.client.call("request.cancel", { spaceId: f.space.id, requestId: accepted.requestId });
  await until(() => existsSync(cancelled), Boolean);
  assert.equal((await f.client.call("request.get", { spaceId: f.space.id, requestId: accepted.requestId })).status, "cancelling");
  await writeFile(fifo, "退出");
  assert.equal((await f.finished(accepted)).status, "cancelled");
  assert.equal(await readFile(exited, "utf8"), "exited");
  const controller = new AbortController();
  let parsing = false;
  const work = parse("html", Buffer.from(`<article><p>${"真实 worker 解析".repeat(10000)}</p></article>`), {}, controller.signal,
    () => { parsing = true; controller.abort(); });
  await assert.rejects(work, error => error instanceof Error && error.name === "AbortError");
  assert.equal(parsing, true);
});


test("PDF命令只接受机器侧application配置，空间和会话携带路径报配置错误且不执行", async (t) => {
  const f = await fixture(t);
  const source = await f.put("actual.pdf", smallPdf());
  await set(f.client, application, "repa.materials", "pdfinfo", "/usr/bin/pdfinfo");
  await set(f.client, application, "repa.materials", "pdftotext", "/usr/bin/pdftotext");
  const session = await f.client.call("session.create", { spaceId: f.space.id });
  const sessionScope: SettingScope = { kind: "session", spaceId: f.space.id, sessionId: session.sessionId };
  const marker = path.join(f.root, "space-command-executed");
  const command = path.join(f.root, "space-command");
  await writeFile(command, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);
  await chmod(command, 0o755);
  await assert.rejects(set(f.client, f.scope, "repa.materials", "pdfinfo", command), fault("configuration"));
  await assert.rejects(set(f.client, sessionScope, "repa.materials", "pdftotext", command), fault("configuration"));
  const file = path.join(f.directory, ".repa", "settings.json");
  const override = { revision: "space-provided", value: command };
  const payloads = [
    { namespaces: { "repa.materials": { pdfinfo: override } } },
    { sessions: { [session.sessionId]: { namespaces: { "repa.materials": { pdftotext: override } } } } },
  ];
  for (const payload of payloads) {
    const bytes = JSON.stringify({ format: "repa.settings", version: 2, ...payload });
    await writeFile(file, bytes);
    await assert.rejects(f.client.call("settings.get", { scope: f.scope, namespace: "repa.materials" }), fault("configuration"));
    const stored = await f.finished(await f.invoke({ target: source }));
    assert.equal(stored.status, "failed");
    assert.equal(stored.error?.code, "configuration");
    assert.equal(existsSync(marker), false, "信任能力包不允许空间设置执行额外程序");
    assert.equal(await readFile(file, "utf8"), bytes, "非法持久配置报告错误，不悄悄删改用户文件");
  }
  await rm(file);
  assert.equal((await f.extract({ target: source })).data.status, "ready");
  assert.equal(existsSync(marker), false);
});

test("原PDF文件删除后按固定资源读取第二页，保留hash与定位且不建立材料副本", async t => {
  const f = await fixture(t);
  const source = await f.put("original.pdf", smallPdf());
  const first = await f.extract({
    target: source,
    range: { kind: "pages", start: 1, end: 1 },
  });
  const resource = first.representation.resources[0];
  assert(resource);
  await rm(path.join(f.directory, "original.pdf"));
  const before = await f.client.call("content.list", { spaceId: f.space.id });
  const catalogFile = path.join(f.directory, ".repa/content/catalog.json");
  const catalogBefore = await readFile(catalogFile);
  const input: ExtractInput = {
    target: { kind: "resource", resource },
    expectedBodyRevision: resource.id,
    range: { kind: "pages", start: 2, end: 2 },
  };
  const next = await f.extract(input);
  assert.equal(next.data.status, "ready");
  assert.match(next.data.segments[0]?.text ?? "", /Second actual page/);
  assert.deepEqual(next.data.segments[0]?.locator.value, { page: 2 });
  assert.deepEqual(next.representation.resources, [resource]);
  assert.deepEqual(next.representation.sources, []);
  assert.deepEqual(await f.client.call("content.list", { spaceId: f.space.id }), before);
  assert.deepEqual(await readFile(catalogFile), catalogBefore, "资源提取不新建或修改内容身份");
  const replay = await f.client.call("capability.invoke", {
    scope: f.scope,
    requestId: next.stored.requestId,
    contract: EXTRACT_CONTRACT,
    input,
  });
  assert.equal(replay.kind, "background");
  assert(replay.kind === "background");
  assert.deepEqual(await f.finished(replay.request), next.stored);
  const again = await f.extract(input);
  assert.deepEqual(again.data, next.data);
  const stale = await f.finished(await f.invoke({
    ...input,
    expectedBodyRevision: "0".repeat(64),
  }));
  assert.equal(stale.status, "failed");
  assert.equal(stale.error?.code, "revision_conflict");
  const oldFile = await f.finished(await f.invoke({
    target: source,
    expectedBodyRevision: resource.id,
  }));
  assert.equal(oldFile.status, "failed");
  assert.equal(oldFile.error?.code, "revision_conflict");
});

test("资源原件拒绝跨空间或缺失hash，损坏字节不被解释为坏PDF", async t => {
  const f = await fixture(t);
  const uploaded = await f.client.uploadResource(f.space.id, smallPdf(), "application/pdf");
  const resource = uploaded.resource;
  const marker = path.join(f.root, "resource-pdf-started");
  const wrapper = path.join(f.root, "resource-pdfinfo");
  await writeFile(wrapper, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'started');\n`);
  await chmod(wrapper, 0o755);
  await set(f.client, application, "repa.materials", "pdfinfo", wrapper);
  const other = await f.client.call("space.open", { path: path.join(f.root, "other") });
  await assert.rejects(f.invoke({
    target: { kind: "resource", resource: { ...resource, spaceId: other.id } },
  }), fault("permission_required"));
  await assert.rejects(f.invoke({
    target: { kind: "resource", resource: { ...resource, id: "0".repeat(64) } },
  }), fault("revision_unavailable"));
  await writeFile(path.join(f.directory, ".repa/content/blobs", resource.id), "tampered original");
  const failed = await f.finished(await f.invoke({ target: { kind: "resource", resource } }));
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.code, "invalid_storage");
  assert.equal(existsSync(marker), false);
});

test("无路径资源按明确MIME与编码读HTML和JSON，不把octet-stream猜成文本", async t => {
  const f = await fixture(t);
  const chinese = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  const htmlBytes = Buffer.concat([
    Buffer.from("<html><body><article><p>"),
    Buffer.concat(Array.from({ length: 400 }, () => chinese)),
    Buffer.from("</p></article></body></html>"),
  ]);
  const uploaded = await f.client.uploadResource(f.space.id, htmlBytes, "text/html");
  const plain = await f.extract({ target: { kind: "resource", resource: uploaded.resource } });
  assert.equal(plain.data.status, "invalid");
  const explicit = await f.extract({
    target: { kind: "resource", resource: uploaded.resource },
    encoding: "gb18030",
  });
  assert.equal(explicit.data.status, "ready");
  assert.equal(explicit.data.reader.name, "readability");
  assert.equal(explicit.data.reader.encoding, "gb18030");
  assert.match(explicit.data.segments.map(segment => segment.text).join(""), /中文/);
  const overridden = await f.extract({
    target: {
      kind: "resource",
      resource: { ...uploaded.resource, mediaType: "text/html; charset=utf-8" },
    },
    encoding: "gb18030",
  });
  assert.equal(overridden.data.status, "ready");
  assert.equal(overridden.data.reader.encoding, "gb18030");
  assert.deepEqual(overridden.data.segments, explicit.data.segments);
  const declared = await f.extract({
    target: {
      kind: "resource",
      resource: { ...uploaded.resource, mediaType: "text/html; charset=gb18030" },
    },
  });
  assert.equal(declared.data.status, "ready");
  assert.equal(declared.data.reader.name, "readability");
  assert.deepEqual(declared.data.segments, explicit.data.segments);
  const json = await f.client.uploadResource(f.space.id, Buffer.from('{"原文":42}\r\n'), "application/json");
  const parsed = await f.extract({ target: { kind: "resource", resource: json.resource } });
  assert.equal(parsed.data.kind, "text");
  assert.equal(parsed.data.segments.map(segment => segment.text).join(""), '{"原文":42}\r\n');
  const unknown = await f.client.uploadResource(f.space.id, Buffer.from("not a declared text file"), "application/octet-stream");
  const unsupported = await f.extract({ target: { kind: "resource", resource: unknown.resource } });
  assert.equal(unsupported.data.status, "unsupported");
});

test("超限固定资源不启动PDF解析，结果保留已声明原ref而文件分支仍空来源", async t => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(33 * 1024 * 1024, " ");
  smallPdf().copy(bytes);
  const uploaded = await f.client.uploadResource(f.space.id, bytes, "application/pdf");
  const marker = path.join(f.root, "oversize-resource-parser");
  const wrapper = path.join(f.root, "oversize-resource-pdfinfo");
  await writeFile(wrapper, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'started');\n`);
  await chmod(wrapper, 0o755);
  await set(f.client, application, "repa.materials", "pdfinfo", wrapper);
  const result = await f.extract({ target: { kind: "resource", resource: uploaded.resource } });
  assert.equal(result.data.status, "limit_exceeded");
  assert.equal(result.data.reader.name, "none");
  assert.deepEqual(result.data.segments, []);
  assert.deepEqual(result.representation.sources, []);
  assert.deepEqual(result.representation.resources, [uploaded.resource]);
  assert.equal(existsSync(marker), false);
});

test("固定PDF资源受理后由请求持有，取消等待实际进程close再完成", async t => {
  const f = await fixture(t);
  const uploaded = await f.client.uploadResource(f.space.id, smallPdf(), "application/pdf");
  const fifo = path.join(f.root, "resource-exit.fifo");
  await promisify(execFile)("mkfifo", [fifo]);
  const started = path.join(f.root, "resource-started");
  const cancelled = path.join(f.root, "resource-cancelled");
  const exited = path.join(f.root, "resource-exited");
  const wrapper = path.join(f.root, "resource-pdftotext");
  await writeFile(wrapper, `#!${process.execPath}
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const promises = require("node:fs/promises");
const child = spawn("/usr/bin/pdftotext", process.argv.slice(2), {
  stdio: ["ignore", "inherit", "inherit"],
});
child.on("close", code => {
  if (code !== 0) process.exit(code ?? 1);
  fs.writeFileSync(${JSON.stringify(started)}, "parsed");
});
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(cancelled)}, "cancelled");
  promises.readFile(${JSON.stringify(fifo)}).then(() => {
    fs.writeFileSync(${JSON.stringify(exited)}, "exited");
    process.exit(0);
  });
});
setInterval(() => {}, 10000);
`);
  await chmod(wrapper, 0o755);
  await set(f.client, application, "repa.materials", "pdfinfo", "/usr/bin/pdfinfo");
  await set(f.client, application, "repa.materials", "pdftotext", wrapper);
  const accepted = await f.invoke({
    target: { kind: "resource", resource: uploaded.resource },
    range: { kind: "pages", start: 2, end: 2 },
  });
  await until(() => existsSync(started), Boolean);
  await f.client.call("resource.release", {
    spaceId: f.space.id,
    id: uploaded.id,
  });
  const running = await f.client.call("request.get", { spaceId: f.space.id, requestId: accepted.requestId });
  assert("input" in running);
  const part = running.input.parts[0];
  assert(part?.kind === "data");
  assert.deepEqual(part.representation.resources, [uploaded.resource]);
  await f.client.call("resource.collect", { spaceId: f.space.id });
  assert.deepEqual(Buffer.from(await (await f.client.resource(uploaded.resource)).arrayBuffer()), smallPdf());
  await f.client.call("request.cancel", {
    spaceId: f.space.id,
    requestId: accepted.requestId,
  });
  await until(() => existsSync(cancelled), Boolean);
  assert.equal((await f.client.call("request.get", { spaceId: f.space.id, requestId: accepted.requestId })).status, "cancelling");
  assert.equal(existsSync(exited), false);
  await writeFile(fifo, "退出");
  assert.equal((await f.finished(accepted)).status, "cancelled");
  assert.equal(existsSync(exited), true);
});
