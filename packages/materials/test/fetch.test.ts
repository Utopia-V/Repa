import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http, { type RequestListener } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Check } from "typebox/value";
import { RepaClient, startRepaServer, type BackgroundRequest } from "repa";
import { RepresentationSchema } from "repa/protocol";
import { FETCH_CONTRACT, FETCH_FORMAT, FetchDataSchema, type FetchInput } from "../dist/index.js";
import { MAX_BYTES } from "../dist/schema.js";
import { fetchBytes } from "../dist/fetch.js";
import { RepaFault } from "repa/protocol";

async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) assert.fail(`在线材料处理超时：${JSON.stringify(value)}`);
    await delay(10);
  }
}

function result(request: BackgroundRequest) {
  assert.equal(request.status, "completed", JSON.stringify(request));
  assert(request.result?.value.kind === "inline");
  assert(Check(RepresentationSchema, request.result.value.data));
  const representation = request.result.value.data;
  assert.deepEqual(representation.format, FETCH_FORMAT);
  assert(representation.value.kind === "inline");
  assert(Check(FetchDataSchema, representation.value.data));
  const data = representation.value.data;
  const original = representation.resources[data.originalResourceIndex];
  assert(original);
  return { representation, data, original };
}

function pdfSample(): Buffer {
  const stream = "BT /F1 12 Tf 40 120 Td (Actual HTTP PDF page) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(body);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

async function fixture(t: TestContext, handler: RequestListener) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-material-fetch-"));
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [],
    extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"] }));
  const web = http.createServer(handler);
  await new Promise<void>(resolve => { web.listen(0, "127.0.0.1", resolve); });
  const address = web.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const directory = path.join(root, "space");
  const options = { agentDir, appDirectory: path.join(root, "app") };
  let server = await startRepaServer(options);
  let client = await RepaClient.connect(server.connection);
  t.after(async () => {
    try { await server.close("cancel"); await client.close(); }
    finally {
      web.closeAllConnections();
      await new Promise<void>((resolve, reject) => { web.close(error => error ? reject(error) : resolve()); });
      await rm(root, { recursive: true, force: true });
    }
  });
  const space = await client.call("space.open", { path: directory });
  const scope = { kind: "space" as const, spaceId: space.id };
  const describe = await client.call("capability.describe", { scope });
  assert(describe.capabilities.some(capability => capability.contract.id === FETCH_CONTRACT.id && capability.tool?.name === "fetch_material"));
  const invoke = async (input: FetchInput, requestId: string = randomUUID()) => {
    const accepted = await client.call("capability.invoke", { scope, requestId, contract: FETCH_CONTRACT, input });
    assert(accepted.kind === "background");
    return accepted.request;
  };
  const finished = async (request: BackgroundRequest) => {
    const stored = await until(() => client.call("request.get", { spaceId: space.id, requestId: request.requestId }),
      value => ["completed", "failed", "cancelled", "interrupted"].includes(value.status));
    assert("operation" in stored);
    return stored;
  };
  const reopen = async () => {
    await server.close("cancel");
    await client.close();
    server = await startRepaServer(options);
    client = await RepaClient.connect(server.connection);
    assert.equal((await client.call("space.open", { path: directory })).id, space.id);
  };
  return { root, base, directory, space, scope, invoke, finished, reopen, get client() { return client; } };
}

test("真实 HTTP 重定向保留原字节和实际来源，本地提取不加载子资源，重传与重开不再获取", async (t) => {
  const html = Buffer.from('<!doctype html><html><head><title>潮汐资料</title></head><body><article><h1>潮汐</h1><p>月球和太阳引力会影响潮汐。真实获取的原件保留 η 和换行。\r\n这里可以进一步核对实际来源。</p><img src="/tracking"><script>fetch("/tracking")</script></article></body></html>');
  let downloads = 0;
  let tracking = 0;
  const f = await fixture(t, (request, response) => {
    if (request.url === "/start") { response.writeHead(302, { location: "/article.html" }); response.end(); }
    else if (request.url === "/article.html") {
      downloads++;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", etag: '"actual-version"', "last-modified": "Sat, 03 Oct 2026 00:00:00 GMT" });
      response.end(html);
    } else { tracking++; response.end("unexpected"); }
  });
  const input = { url: `${f.base}/start` };
  const accepted = await f.invoke(input);
  const stored = await f.finished(accepted);
  const fetched = result(stored);
  assert.equal(fetched.data.source.requestedUrl, input.url);
  assert.equal(fetched.data.source.finalUrl, `${f.base}/article.html`);
  assert.equal(fetched.data.source.mediaType, "text/html");
  assert.equal(fetched.data.source.contentType, "text/html; charset=utf-8");
  assert.equal(fetched.data.source.etag, '"actual-version"');
  assert.equal(fetched.data.source.bodyRevision, fetched.original.id);
  assert.deepEqual(fetched.data.origin, { kind: "url", url: `${f.base}/article.html`, retrievedAt: fetched.data.source.fetchedAt });
  assert(Number.isFinite(fetched.data.source.fetchedAt));
  assert.equal(fetched.data.extraction.status, "ready");
  assert.equal(fetched.data.extraction.kind, "html");
  assert.match(fetched.data.extraction.segments.map(segment => segment.text).join("\n"), /月球和太阳引力/u);
  assert.deepEqual(fetched.representation.sources, [], "尚未关联本地内容，不伪造 ContentTarget");
  assert.equal(fetched.representation.resources.length, 1);
  assert.deepEqual(Buffer.from(await (await f.client.resource(fetched.original)).arrayBuffer()), html);
  assert.equal(tracking, 0);
  await f.invoke(input, accepted.requestId);
  assert.equal(downloads, 1);
  await f.reopen();
  await f.client.call("resource.collect", { spaceId: f.space.id });
  assert.deepEqual(await f.finished(accepted), stored);
  assert.deepEqual(Buffer.from(await (await f.client.resource(fetched.original)).arrayBuffer()), html);
  assert.equal(downloads, 1);
  const target = { kind: "file" as const, spaceId: f.space.id, location: { kind: "relative" as const, path: "article.html" } };
  await f.client.call("content.write", { target, base: { kind: "absent" }, operationId: randomUUID(), value: { kind: "resource", resource: fetched.original } });
  assert.deepEqual(await readFile(path.join(f.directory, "article.html")), html);
  const associated = await f.client.call("content.associate", { spaceId: f.space.id, operationId: randomUUID(),
    location: target.location, role: "material", origin: fetched.data.origin });
  const ref = associated.contents[0]?.ref;
  assert(ref);
  assert.deepEqual((await f.client.call("content.get", { target: { kind: "content", ref } })).origin, fetched.data.origin);
  await f.reopen();
  assert.deepEqual((await f.client.call("content.get", { target: { kind: "content", ref } })).origin, fetched.data.origin);
});

test("在线文本、图片和未知格式使用现有读取器，损坏 PDF 仍保留已经取得的原件", async (t) => {
  const text = Buffer.from("第一行 η\r\n第二行 🌊\n");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6woAAAAASUVORK5CYII=", "base64");
  const pdf = pdfSample();
  const broken = Buffer.from("%PDF-1.4\nnot a valid PDF\n");
  const unknown = Buffer.from([0, 1, 2, 3]);
  const f = await fixture(t, (request, response) => {
    const formats: Record<string, { bytes: Buffer; type: string }> = {
      "/text": { bytes: text, type: "text/plain" }, "/image": { bytes: png, type: "image/png" },
      "/sample.pdf": { bytes: pdf, type: "application/pdf" },
      "/broken.pdf": { bytes: broken, type: "application/pdf" },
    };
    const item = formats[request.url ?? ""] ?? { bytes: unknown, type: "application/octet-stream" };
    response.writeHead(200, { "content-type": item.type });
    response.end(item.bytes);
  });
  const read = result(await f.finished(await f.invoke({ url: `${f.base}/text`, range: { kind: "lines", start: 2, end: 2 } })));
  assert.equal(read.data.extraction.segments[0]?.text, "第二行 🌊\n");
  assert.deepEqual(Buffer.from(await (await f.client.resource(read.original)).arrayBuffer()), text);
  const image = result(await f.finished(await f.invoke({ url: `${f.base}/image` })));
  assert.equal(image.data.extraction.image?.width, 1);
  assert.equal(image.data.extraction.image?.height, 1);
  const document = result(await f.finished(await f.invoke({ url: `${f.base}/sample.pdf`, range: { kind: "pages", start: 1, end: 1 } })));
  assert.equal(document.data.extraction.status, "ready");
  assert.equal(document.data.extraction.total, 1);
  assert.deepEqual(document.data.extraction.segments[0]?.locator.value, { page: 1 });
  assert.match(document.data.extraction.segments[0]?.text ?? "", /Actual HTTP PDF page/u);
  assert.deepEqual(Buffer.from(await (await f.client.resource(document.original)).arrayBuffer()), pdf);
  const invalid = result(await f.finished(await f.invoke({ url: `${f.base}/broken.pdf` })));
  assert.equal(invalid.data.extraction.status, "invalid");
  assert.deepEqual(Buffer.from(await (await f.client.resource(invalid.original)).arrayBuffer()), broken);
  const unsupported = result(await f.finished(await f.invoke({ url: `${f.base}/unknown` })));
  assert.equal(unsupported.data.extraction.status, "unsupported");
  assert.deepEqual(Buffer.from(await (await f.client.resource(unsupported.original)).arrayBuffer()), unknown);
});

test("HTTP 失败、非法协议及已知和流式超限不交付不完整原件", async (t) => {
  const large = Buffer.alloc(MAX_BYTES + 1, 120);
  const f = await fixture(t, (request, response) => {
    if (request.url === "/missing") { response.writeHead(404); response.end("missing"); }
    else if (request.url === "/known-large") {
      response.writeHead(200, { "content-length": String(MAX_BYTES + 1) });
      response.end();
    } else {
      response.writeHead(200);
      response.write(large);
      response.end();
    }
  });
  const blobs = path.join(f.directory, ".repa/content/blobs");
  const before = await readdir(blobs);
  for (const [url, code] of [
    [`${f.base}/missing`, "material_fetch_http"],
    ["file:///tmp/not-http", "invalid_material_url"],
    [`${f.base}/known-large`, "material_fetch_limit"],
    [`${f.base}/stream-large`, "material_fetch_limit"],
  ]) {
    assert(url && code);
    const stored = await f.finished(await f.invoke({ url }));
    assert.equal(stored.status, "failed");
    assert.equal(stored.error?.code, code);
    assert.equal(stored.result, undefined);
  }
  assert.deepEqual(await readdir(blobs), before);
});

test("HTTP 声明的 GB18030 由现成解码器读取，未声明编码不猜测，原字节仍保留", async (t) => {
  const chinese = Buffer.from("d6d0cec4", "hex");
  const html = Buffer.concat([Buffer.from("<article><h1>"), chinese, Buffer.from("</h1><p>"),
    ...Array.from({ length: 12 }, () => chinese), Buffer.from("</p></article>")]);
  const f = await fixture(t, (request, response) => {
    const types: Record<string, string> = { "/html": "text/html; charset=GB18030",
      "/unknown-encoding": "text/plain; charset=not-a-real-encoding", "/unspecified": "text/plain" };
    const type = types[request.url ?? ""] ?? "text/plain; charset=GB18030";
    response.writeHead(200, { "content-type": type });
    response.end(request.url === "/html" ? html : chinese);
  });
  const text = result(await f.finished(await f.invoke({ url: `${f.base}/text` })));
  assert.equal(text.data.extraction.status, "ready");
  assert.equal(text.data.extraction.segments[0]?.text, "中文");
  assert.equal(text.data.extraction.reader.encoding, "gb18030");
  assert.deepEqual(Buffer.from(await (await f.client.resource(text.original)).arrayBuffer()), chinese);
  const article = result(await f.finished(await f.invoke({ url: `${f.base}/html` })));
  assert.equal(article.data.extraction.status, "ready");
  assert.equal(article.data.extraction.reader.encoding, "gb18030");
  assert.match(article.data.extraction.segments.map(segment => segment.text).join("\n"), /中文/u);
  assert.deepEqual(Buffer.from(await (await f.client.resource(article.original)).arrayBuffer()), html);
  for (const endpoint of ["unspecified", "unknown-encoding"]) {
    const invalid = result(await f.finished(await f.invoke({ url: `${f.base}/${endpoint}` })));
    assert.equal(invalid.data.extraction.status, "invalid");
    assert.deepEqual(Buffer.from(await (await f.client.resource(invalid.original)).arrayBuffer()), chinese);
  }
});

test("实际连接断开保留简要网络诊断，不暴露堆栈或请求头", async (t) => {
  const f = await fixture(t, (_request, response) => { response.destroy(); });
  await assert.rejects(fetchBytes(`${f.base}/closed`, new AbortController().signal), error => {
    assert(error instanceof RepaFault);
    assert.equal(error.code, "material_fetch_failed");
    assert(error.details && typeof error.details === "object");
    assert("reason" in error.details && typeof error.details.reason === "string");
    assert("cause" in error.details && error.details.cause && typeof error.details.cause === "object");
    assert("code" in error.details.cause);
    assert("message" in error.details.cause);
    assert(!("stack" in error.details));
    assert(!("headers" in error.details));
    return true;
  });
});

test("取消后台 HTTP 获取会关闭实际响应流，不阻塞内容保存或留下部分原件", async (t) => {
  let entered = () => {};
  const started = new Promise<void>(resolve => { entered = resolve; });
  let exited = () => {};
  const closed = new Promise<void>(resolve => { exited = resolve; });
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("还未完成的正文\n");
    response.once("close", exited);
    entered();
  });
  const pending = await f.invoke({ url: `${f.base}/slow` });
  await started;
  const target = { kind: "file" as const, spaceId: f.space.id, location: { kind: "relative" as const, path: "during-fetch.md" } };
  await f.client.call("content.write", { target, base: { kind: "absent" }, operationId: randomUUID(), value: { kind: "text", text: "下载期间仍可保存" } });
  await f.client.call("request.cancel", { spaceId: f.space.id, requestId: pending.requestId });
  const cancelled = await f.finished(pending);
  assert.equal(cancelled.status, "cancelled");
  await closed;
  assert.equal(cancelled.result, undefined);
  assert.equal(await readFile(path.join(f.directory, "during-fetch.md"), "utf8"), "下载期间仍可保存");
});
