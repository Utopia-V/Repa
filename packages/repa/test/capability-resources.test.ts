import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Type } from "typebox";
import { CapabilityHost } from "../src/capabilities/host.js";
import { capabilityRepresentation } from "../src/capabilities/resources.js";
import type { CapabilityDefinition } from "../src/capabilities/types.js";
import { ContentStore } from "../src/content/store.js";
import { ResourceRefSchema } from "../src/content/schema.js";
import { RepaFault } from "../src/errors.js";
import { BackgroundRequests } from "../src/requests/background.js";
import { prepareInput } from "../src/requests/input.js";
import type { ProcessingResult } from "../src/requests/schema.js";
import { object } from "../src/schema.js";

const contract = { id: "example.resource-transform", version: "1" };
const scope = { kind: "space" as const, spaceId: "space" };

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-capability-resources-"));
  const host = new CapabilityHost();
  const stores: ContentStore[] = [];
  const processing: BackgroundRequests[] = [];
  let now = 1000;
  const open = async () => {
    const content = await ContentStore.open({ root, spaceId: scope.spaceId, now: () => now, preparationTtlMs: 10, assertOwned() {} });
    stores.push(content);
    return content;
  };
  const content = await open();
  t.after(async () => {
    for (const requests of processing) requests.cancelAll();
    await host.close();
    await Promise.all(processing.map(requests => requests.settled()));
    await Promise.all(stores.map(store => store.settled()));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root, host, content, open,
    expireUploads() {
      now += 100;
      content.retention.releaseHost("uploader");
    },
    processing() {
      const requests = new BackgroundRequests({
        directory: path.join(root, ".repa/runtime/processing"), spaceId: scope.spaceId, content,
        assertOwned() {}, changed() {}, ask: async () => null,
      });
      processing.push(requests);
      return requests;
    },
  };
}

test("同一父请求两次准备输入后取消，上传准备期结束与重开回收不丢失此前使用的字节", async (t) => {
  const f = await fixture(t);
  const first = await f.content.upload(Buffer.from("第一次输入"), "text/plain", "uploader");
  const second = await f.content.upload(Buffer.from("第二次输入"), "text/plain", "uploader");
  const requestId = randomUUID();
  const owner = `request:${requestId}`;
  const prepared = deferred();
  await f.host.register({ id: "transform", enabled: true, factory: () => ({ capabilities: [{
    contract, implementationId: "test", inputSchema: object({}), outputSchema: Type.Null(),
    scopes: ["space"], execution: "background",
    async invoke(_input, context) {
      assert(context.content);
      await prepareInput({ parts: [{ kind: "resource", resource: first.resource }] }, context.content, requestId, owner);
      await prepareInput({ parts: [{ kind: "resource", resource: second.resource }] }, context.content, requestId, owner);
      prepared.resolve();
      await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      context.signal.throwIfAborted();
      return null;
    },
  }] }) });
  const controller = new AbortController();
  const call = f.host.invoke({ contract }, {}, {
    scope, source: { kind: "agent", spaceId: scope.spaceId, sessionId: "session", runId: "run", requestId },
    content: f.content, signal: controller.signal,
  });
  const cancelled = assert.rejects(call, (error: unknown) => error instanceof Error && error.name === "AbortError");
  await prepared.promise;
  controller.abort();
  await cancelled;
  await f.host.settled();
  f.expireUploads();
  const reopened = await f.open();
  await reopened.collectResources();
  assert.equal((await reopened.blobs.get(first.resource.id)).toString(), "第一次输入");
  assert.equal((await reopened.blobs.get(second.resource.id)).toString(), "第二次输入");
  reopened.retention.releaseOwner(owner);
  await reopened.collectResources();
  await assert.rejects(reopened.blobs.get(first.resource.id));
  await assert.rejects(reopened.blobs.get(second.resource.id));
});

test("后台执行期间共同持有多次输入，完成后只保留原输入与最终表示明确交付的资源", async (t) => {
  const f = await fixture(t);
  const original = await f.content.upload(Buffer.from("公开原始输入"), "text/plain", "uploader");
  const intermediate = await f.content.upload(Buffer.from("仅执行期间使用的中间输入"), "text/plain", "uploader");
  const delivered = await f.content.upload(Buffer.from("最终交付"), "text/plain", "uploader");
  const requestId = randomUUID();
  const owner = `processing:${requestId}`;
  const prepared = deferred();
  const finish = deferred();
  const raw: ProcessingResult = {
    format: { id: "example.document", version: "1" },
    value: { kind: "resource", resource: delivered.resource },
    sources: [{ target: { kind: "file", spaceId: scope.spaceId, location: { kind: "relative", path: "source.txt" } }, revision: "source-revision" }],
    resources: [], summary: "交付说明",
  };
  const requests = f.processing();
  requests.submit({ requestId, operation: contract.id, input: { parts: [{ kind: "resource", resource: original.resource }] } }, async (_input, context) => {
    assert(context.content);
    await prepareInput({ parts: [{ kind: "resource", resource: intermediate.resource }] }, context.content, requestId, owner);
    await prepareInput({ parts: [{ kind: "resource", resource: delivered.resource }] }, context.content, requestId, owner);
    prepared.resolve();
    await finish.promise;
    return capabilityRepresentation(contract, raw);
  });
  try {
    await prepared.promise;
    f.expireUploads();
    await f.content.collectResources();
    assert.equal((await f.content.blobs.get(original.resource.id)).toString(), "公开原始输入");
    assert.equal((await f.content.blobs.get(intermediate.resource.id)).toString(), "仅执行期间使用的中间输入");
    assert.equal((await f.content.blobs.get(delivered.resource.id)).toString(), "最终交付");
  } finally { finish.resolve(); }
  await requests.settled(requestId);
  const completed = requests.get(requestId);
  assert.equal(completed.status, "completed", completed.error?.message);
  assert.deepEqual(completed.result, {
    format: contract, value: { kind: "inline", data: raw },
    sources: raw.sources, resources: [delivered.resource], summary: raw.summary,
  });
  await f.content.collectResources();
  await assert.rejects(f.content.blobs.get(intermediate.resource.id));
  assert.equal((await f.content.blobs.get(original.resource.id)).toString(), "公开原始输入");
  assert.equal((await f.content.blobs.get(delivered.resource.id)).toString(), "最终交付");
});

test("能力按自身输入输出格式声明资源，已绑定声明在关闭后仍可提升引用而不扫描任意 JSON", async (t) => {
  const f = await fixture(t);
  const uploaded = await f.content.upload(Buffer.from("声明的文档"), "text/plain", "uploader");
  const InputSchema = object({ artifact: ResourceRefSchema });
  const OutputSchema = object({ result: object({ artifact: ResourceRefSchema }) });
  let declared = 0;
  let invoked = 0;
  let opened = 0;
  const definition: CapabilityDefinition<typeof InputSchema, typeof OutputSchema> = {
    contract, implementationId: "nested", inputSchema: InputSchema, outputSchema: OutputSchema,
    scopes: ["space"], execution: "inline",
    inputResources: input => { declared++; return [input.artifact]; },
    outputResources: output => [output.result.artifact],
    invoke(input) { invoked++; return { result: { artifact: input.artifact } }; },
  };
  await f.host.register({ id: "nested", enabled: true, factory: () => ({
    capabilities: [definition], openSpace() { opened++; return {}; },
  }) });
  const declarations = f.host.resourceDeclarations({ contract }, scope);
  const invalid = { artifact: { ...uploaded.resource, id: 0 } };
  const invalidInput = (error: unknown) => error instanceof RepaFault && error.code === "invalid_capability_input";
  assert.throws(() => declarations.inputResources(invalid), invalidInput);
  await assert.rejects(f.host.invoke({ contract }, invalid, {
    scope, source: { kind: "client", hostId: "frontend" }, content: f.content, signal: new AbortController().signal,
  }), invalidInput);
  assert.equal(declared, 0, "无效输入不能交给所属能力的资源 hook");
  assert.equal(invoked, 0);
  assert.equal(opened, 0);
  const input = { artifact: uploaded.resource };
  const representedInput = capabilityRepresentation(contract, input, declarations.inputResources(input));
  assert.deepEqual(representedInput.resources, [uploaded.resource]);
  assert.equal(declared, 1);
  assert.equal(invoked, 0);
  assert.equal(opened, 0);
  assert.equal(Object.hasOwn(f.host.list()[0] ?? {}, "inputResources"), false);
  const output = await f.host.invoke({ contract }, input, {
    scope, source: { kind: "client", hostId: "frontend" }, content: f.content, signal: new AbortController().signal,
  });
  await f.host.close();
  assert.deepEqual(capabilityRepresentation(contract, output).resources, []);
  const representedOutput = capabilityRepresentation(contract, output, declarations.outputResources(output));
  assert.deepEqual(representedOutput.resources, [uploaded.resource]);
  assert.deepEqual(representedOutput.value, { kind: "inline", data: output });
  assert.equal(invoked, 1);
  assert.equal(opened, 1);
  const standard: ProcessingResult = { format: { id: "example.model-result", version: "1" }, value: { kind: "inline", data: "正文" }, sources: [], resources: [uploaded.resource] };
  assert.deepEqual(capabilityRepresentation(contract, standard).resources, [uploaded.resource]);
});
