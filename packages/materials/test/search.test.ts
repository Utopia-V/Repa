import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http, { type RequestListener } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Check } from "typebox/value";
import { RepaClient, startRepaServer, type BackgroundRequest } from "repa";
import { RepresentationSchema } from "repa/protocol";
import { SEARCH_CONTRACT, SEARCH_FORMAT, SearchDataSchema, type SearchInput } from "../dist/index.js";

async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) assert.fail(`百科搜索超时：${JSON.stringify(value)}`);
    await delay(10);
  }
}

function data(request: BackgroundRequest) {
  assert.equal(request.status, "completed", JSON.stringify(request));
  assert(request.result?.value.kind === "inline");
  assert(Check(RepresentationSchema, request.result.value.data));
  const representation = request.result.value.data;
  assert.deepEqual(representation.format, SEARCH_FORMAT);
  assert(representation.value.kind === "inline");
  assert(Check(SearchDataSchema, representation.value.data));
  assert.deepEqual(representation.resources, []);
  assert.deepEqual(representation.sources, []);
  return representation.value.data;
}

async function fixture(t: TestContext, handler: RequestListener) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-wikipedia-search-"));
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [],
    extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"] }));
  const web = http.createServer(handler);
  await new Promise<void>(resolve => { web.listen(0, "127.0.0.1", resolve); });
  const address = web.address();
  assert(address && typeof address !== "string");
  const local = `http://127.0.0.1:${address.port}`;
  const fetch = globalThis.fetch;
  const calls: { url: URL; userAgent: string | null }[] = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname.endsWith(".wikipedia.org") && url.pathname === "/w/api.php") {
      calls.push({ url, userAgent: new Headers(init?.headers).get("user-agent") });
      const redirected = new URL(url.pathname + url.search, local);
      const response = await fetch(redirected, init);
      // 只替换测试网络路由；生产固定端点、HTTP 流与解析保持实际路径。
      Object.defineProperty(response, "url", { value: url.href });
      return response;
    }
    return fetch(input, init);
  });
  const server = await startRepaServer({ agentDir, appDirectory: path.join(root, "app") });
  const client = await RepaClient.connect(server.connection);
  t.after(async () => {
    try { await server.close("cancel"); await client.close(); }
    finally {
      web.closeAllConnections();
      await new Promise<void>((resolve, reject) => { web.close(error => error ? reject(error) : resolve()); });
      await rm(root, { recursive: true, force: true });
    }
  });
  const space = await client.call("space.open", { path: path.join(root, "space") });
  const scope = { kind: "space" as const, spaceId: space.id };
  const described = await client.call("capability.describe", { scope });
  const capability = described.capabilities.find(item => item.contract.id === SEARCH_CONTRACT.id);
  assert(capability);
  assert.equal(capability.implementationId, "wikipedia");
  assert.equal(capability.tool?.name, "search_wikipedia");
  assert.match(capability.tool?.description ?? "", /不是全网搜索/u);
  const invoke = async (input: SearchInput, requestId: string = randomUUID()) => {
    const accepted = await client.call("capability.invoke", { scope, requestId, contract: SEARCH_CONTRACT,
      implementationId: "wikipedia", input });
    assert(accepted.kind === "background");
    return accepted.request;
  };
  const finished = async (request: BackgroundRequest) => {
    const result = await until(() => client.call("request.get", { spaceId: space.id, requestId: request.requestId }),
      value => ["completed", "failed", "cancelled", "interrupted"].includes(value.status));
    assert("operation" in result);
    return result;
  };
  return { client, space, invoke, finished, calls };
}

test("官方 Wikipedia 查询保留编码、百科范围、真实页面 URL 与 API 分页，片段不是已读正文", async (t) => {
  const f = await fixture(t, (request, response) => {
    const query = new URL(request.url ?? "", "http://local").searchParams;
    response.setHeader("content-type", "application/json");
    if (query.get("sroffset") === "0") response.end(JSON.stringify({ batchcomplete: true,
      continue: { sroffset: 2, continue: "-||" }, query: {
        searchinfo: { totalhits: 3 }, search: [{ pageid: 42, title: "Tide & current",
          snippet: '<span class="searchmatch">月球</span> &amp; 太阳引力', timestamp: "2026-10-03T00:00:00Z" }],
      } }));
    else response.end(JSON.stringify({ query: { searchinfo: { totalhits: 3 }, search: [{
      pageid: 43, title: "海流", snippet: "第二页的索引片段",
    }] } }));
  });
  const input = { query: '潮汐 & "太阳" + 100%', language: "en", limit: 2, offset: 0 };
  const request = await f.invoke(input);
  const first = data(await f.finished(request));
  assert.deepEqual(first.provider, { id: "wikipedia", name: "Wikipedia", scope: "encyclopedia" });
  assert.equal(first.query, input.query);
  assert.equal(first.language, "en");
  assert.equal(first.offset, 0);
  assert.equal(first.limit, 2);
  assert.equal(first.total, 3);
  assert(Number.isFinite(first.fetchedAt));
  assert.deepEqual(first.results, [{ pageId: 42, title: "Tide & current", snippet: "月球 & 太阳引力",
    url: "https://en.wikipedia.org/w/index.php?curid=42", pageUpdatedAt: Date.parse("2026-10-03T00:00:00Z") }]);
  assert.deepEqual(first.next, { ...input, offset: 2 });
  const call = f.calls[0];
  assert(call);
  assert.equal(call.url.origin, "https://en.wikipedia.org");
  assert.equal(call.url.pathname, "/w/api.php");
  assert.equal(call.url.searchParams.get("action"), "query");
  assert.equal(call.url.searchParams.get("list"), "search");
  assert.equal(call.url.searchParams.get("srsearch"), input.query);
  assert.equal(call.url.searchParams.get("srlimit"), "2");
  assert.match(call.userAgent ?? "", /^RepaMaterials\//u);
  assert.match(call.userAgent ?? "", /https:\/\/github\.com\/Utopia-V\/repa\/issues/u);
  await f.invoke(input, request.requestId);
  assert.equal(f.calls.length, 1, "后台受理重传不再次查询索引");
  assert(first.next);
  const second = data(await f.finished(await f.invoke(first.next)));
  assert.equal(second.offset, 2);
  assert.equal(second.results[0]?.pageId, 43);
  assert.equal(second.next, undefined);
  assert.equal(f.calls[1]?.url.searchParams.get("sroffset"), "2");
});

test("百科空结果与 HTTP、API 和响应格式错误分别返回，默认语言与页数不依赖新账号", async (t) => {
  const f = await fixture(t, (request, response) => {
    const query = new URL(request.url ?? "", "http://local").searchParams.get("srsearch");
    response.setHeader("content-type", "application/json");
    if (query === "http-error") { response.writeHead(503); response.end("not available"); }
    else if (query === "api-error") response.end(JSON.stringify({ error: { code: "badvalue", info: "Invalid query" } }));
    else if (query === "invalid-json") response.end("not JSON");
    else if (query === "invalid-shape") response.end(JSON.stringify({ query: { search: [{ pageid: "wrong" }] } }));
    else response.end(JSON.stringify({ query: { searchinfo: { totalhits: 0 }, search: [] } }));
  });
  const empty = data(await f.finished(await f.invoke({ query: "empty" })));
  assert.deepEqual(empty.results, []);
  assert.equal(empty.total, 0);
  assert.equal(empty.language, "zh");
  assert.equal(empty.limit, 10);
  assert.equal(empty.offset, 0);
  assert.equal(f.calls[0]?.url.origin, "https://zh.wikipedia.org");
  for (const [query, code] of [
    ["http-error", "material_fetch_http"], ["api-error", "material_search_api"],
    ["invalid-json", "material_search_response"], ["invalid-shape", "material_search_response"],
    ["   ", "invalid_material_query"],
  ]) {
    assert(query && code);
    const result = await f.finished(await f.invoke({ query }));
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, code);
    assert.equal(result.result, undefined);
  }
  assert.equal(f.calls.length, 5, "空白输入在 HTTP 请求前结束");
});

test("取消百科后台搜索停止实际 HTTP 流，不阻塞同空间内容保存", async (t) => {
  let entered = () => {};
  const started = new Promise<void>(resolve => { entered = resolve; });
  let exited = () => {};
  const closed = new Promise<void>(resolve => { exited = resolve; });
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"query":{"search":[');
    response.once("close", exited);
    entered();
  });
  const request = await f.invoke({ query: "等待百科搜索" });
  await started;
  await f.client.call("content.write", { target: { kind: "file", spaceId: f.space.id,
    location: { kind: "relative", path: "during-search.md" } }, base: { kind: "absent" },
    operationId: randomUUID(), value: { kind: "text", text: "搜索期间可以保存" } });
  await f.client.call("request.cancel", { spaceId: f.space.id, requestId: request.requestId });
  assert.equal((await f.finished(request)).status, "cancelled");
  await closed;
});
