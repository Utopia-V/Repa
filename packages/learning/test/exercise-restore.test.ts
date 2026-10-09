import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Check } from "typebox/value";
import { RepaClient, RpcError } from "repa/client";
import { ContentChangeResultSchema, DisplayResultSchema, PROCESS_RESULT,
  RepaFault, type ContentRef, type DisplayResult, type Params, type ResourceRef } from "repa/protocol";
import { startLearningServer } from "@repa/learning/product";
import { callLearning } from "@repa/learning/client";
import { canonicalJson, Type, type BackendPluginRegistration, type ContentStore } from "repa/plugin";
import { LearningAttempts } from "../src/attempts.js";
import { AttemptRecordSchema, type AttemptView } from "../src/attempt-schema.js";
import { ExerciseInitialV2Schema, ExerciseSubmissionSchema, type ExerciseInitialV2, type ExerciseSubmission } from "../src/exercise-schema.js";

const contract = { id: "repa.attempt.record-display", version: "1" };
const fault = (code: string) => (error: unknown) => error instanceof RpcError && error.data !== null &&
  typeof error.data === "object" && "code" in error.data && error.data.code === code;
type Source = Params<"display.open">["source"];

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-exercise-restore-"));
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [],
    extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"] }));
  const contents = new Map<string, ContentStore>();
  const probeContract = { id: "fixture.exercise.content", version: "1" };
  const probe: BackendPluginRegistration = { id: "exercise-content-fixture", enabled: true, factory: () => ({
    capabilities: [{ contract: probeContract, implementationId: "local", scopes: ["space"], execution: "query",
      inputSchema: Type.Object({}, { additionalProperties: false }), outputSchema: Type.Null(),
      invoke(_input, context) {
        assert(context.content && context.scope.kind === "space");
        contents.set(context.scope.spaceId, context.content);
        return null;
      },
    }],
  }) };
  const options = { appDirectory: path.join(root, "app"), agentDir, plugins: [probe], bundledPackages: [], trustExtensions: false };
  let server = await startLearningServer(options);
  let client = await RepaClient.connect(server.connection);
  t.after(async () => { await server.close("cancel"); await client.close(); await rm(root, { recursive: true, force: true }); });
  const space = await client.call("space.open", { path: path.join(root, "space") });
  const texts = ["<!doctype html><p>固定原HTML：2+3</p>", "固定题目：2+3", "p { color: navy; }"];
  const uploads = await Promise.all(texts.map((text, index) => client.uploadResource(space.id, Buffer.from(text),
    index === 0 ? "text/html" : index === 1 ? "text/plain" : "text/css")));
  const [html, material, css] = uploads.map(item => item.resource);
  assert(html && material && css);
  const artifact = { format: { id: "repa.display-html" as const, version: "1" as const },
    value: { kind: "resource" as const, resource: html }, sources: [], resources: [material, css] };
  const initial: ExerciseInitialV2 = { format: { id: "repa.learning-response", version: "2" },
    actor: { kind: "synthetic", label: "恢复夹具" },
    materials: [{ resourceId: material.id, selector: "addition", source: "fixture:original-material" }],
    data: { prompt: "2+3", parameters: { count: 1 } } };
  const source: Source = { kind: "artifact", artifact, initialData: initial };
  const open = (input: Source = source, spaceId = space.id) => client.call("display.open", {
    spaceId, instanceId: randomUUID(), source: input,
    processResult: { selection: { contract, implementationId: "official" }, inputSchema: { ...ExerciseSubmissionSchema } },
  });
  const finish = async (requestId: string, spaceId = space.id) => {
    const deadline = Date.now() + 10000;
    for (;;) {
      const request = await client.call("request.get", { spaceId, requestId });
      assert("operation" in request);
      if (["completed", "failed", "cancelled", "interrupted"].includes(request.status)) return request;
      if (Date.now() >= deadline) assert.fail(`学习作答请求超时：${JSON.stringify(request)}`);
      await delay(10);
    }
  };
  const submit = async (input: Source = source, submission: ExerciseSubmission = { response: "5", assistance: { kind: "unknown" } }, spaceId = space.id) => {
    const instance = await open(input, spaceId);
    const params: Params<"display.invoke"> = { spaceId, instanceId: instance.instanceId, requestId: randomUUID(), action: PROCESS_RESULT, input: submission };
    await client.call("display.invoke", params);
    await client.call("display.close", { spaceId, instanceId: instance.instanceId });
    const completed = await finish(params.requestId, spaceId);
    assert.equal(completed.status, "completed", JSON.stringify(completed));
    assert(completed.result?.value.kind === "inline");
    const result = completed.result.value.data;
    assert(Check(ContentChangeResultSchema, result));
    const ref = result.contents[0]?.ref;
    assert(ref);
    const view = await callLearning(client, "attempt.get", { spaceId, ref });
    return { ref, view, params, completed, submission };
  };
  const bytes = async (resource: ResourceRef) => Buffer.from(await (await client.resource(resource)).arrayBuffer());
  const raw = async (view: AttemptView): Promise<DisplayResult> => {
    assert(view.fact.presentation);
    const parsed: unknown = JSON.parse((await bytes({ spaceId: view.ref.spaceId, ...view.fact.presentation.resource })).toString("utf8"));
    assert(Check(DisplayResultSchema, parsed));
    return parsed;
  };
  const display = (ref: ContentRef) => callLearning(client, "attempt.display", { spaceId: ref.spaceId, ref });
  const count = async () => (await client.call("content.list", { spaceId: space.id, path: "learning/attempts" }))
    .filter(item => item.location.kind === "relative" && item.location.path.startsWith("learning/attempts/")).length;
  const independentContent = async () => {
    const independent = await client.call("space.open", { path: path.join(root, "independent-content") });
    await client.call("capability.invoke", { scope: { kind: "space", spaceId: independent.id },
      contract: probeContract, requestId: randomUUID(), input: {} });
    const content = contents.get(independent.id);
    assert(content);
    return content;
  };
  return { root, space, html, material, css, uploads, artifact, initial, source, open, finish, submit, bytes, raw, display, count, independentContent,
    get client() { return client; },
    async reopen() {
      await server.close("cancel");
      await client.close();
      server = await startLearningServer(options);
      client = await RepaClient.connect(server.connection);
      assert.equal((await client.call("space.open", { path: space.path })).id, space.id);
    },
  };
}

test("fresh→恢复→提交→恢复只携带直接前件，原事实帮助不改写且新作答不继承判断", async t => {
  const f = await fixture(t);
  assert(!Object.hasOwn(f.initial, "previous"));
  const first = await f.submit(f.source, { response: "  4\n", assistance: { kind: "reported", text: "前次看过提示" }, data: { events: ["hint"] } });
  const firstBytes = await f.bytes({ spaceId: f.space.id, id: first.view.factId, mediaType: "application/json" });
  await callLearning(f.client, "attempt.judgment.save", { spaceId: f.space.id, operationId: randomUUID(), ref: first.ref, base: first.view.base,
    judgment: { factId: first.view.factId, method: { kind: "human", name: "fixture", version: null }, basis: [{ resource: f.material }],
      conclusions: [{ criterion: "夹具判断", verdict: "undetermined", explanation: "不评测学习效果" }] }, adopt: { reason: "夹具显式采用" } });
  const original = await callLearning(f.client, "attempt.get", { spaceId: f.space.id, ref: first.ref });
  assert(original.current);
  const before = await f.count();
  const restored = await f.display(first.ref);
  const judgmentOnly = original.resources.filter(resource => !first.view.resources.some(before =>
    before.id === resource.id && before.mediaType === resource.mediaType));
  assert.equal(judgmentOnly.length, 1);
  for (const resource of judgmentOnly)
    assert.equal(restored.source.artifact.resources.some(item => item.id === resource.id), false, "恢复只携带事实闭包，不带旧判断blob");
  assert(Check(ExerciseInitialV2Schema, restored.source.initialData));
  assert.equal(restored.source.artifact.value.resource.id, f.html.id);
  assert.deepEqual(restored.source.initialData.data, f.initial.data);
  assert.deepEqual(restored.source.initialData.previous, { fact: { id: first.view.factId, mediaType: "application/json" },
    presentation: first.view.fact.presentation?.resource, submission: first.submission });
  const opened = await f.open(restored.source);
  assert.deepEqual(opened.initialData, restored.source.initialData);
  await f.client.call("display.close", { spaceId: f.space.id, instanceId: opened.instanceId });
  assert.equal(await f.count(), before, "只恢复、打开和关闭不录入新的作答");
  assert.deepEqual(await callLearning(f.client, "attempt.get", { spaceId: f.space.id, ref: first.ref }), original);
  const second = await f.submit(restored.source, { response: "5", assistance: { kind: "unknown" } });
  assert.equal(second.view.current, null);
  assert.deepEqual(second.view.judgments, []);
  assert.deepEqual(second.view.selections, []);
  assert.deepEqual(second.view.fact.assistance, { kind: "unknown" });
  assert.equal(second.view.fact.actor.kind, "synthetic");
  assert(second.view.fact.recordedBy.kind === "display");
  assert.equal(second.view.fact.recordedBy.instanceId, second.params.instanceId);
  const rawSecond = await f.raw(second.view);
  assert.deepEqual(rawSecond.value.data.initialData, restored.source.initialData);
  assert.deepEqual(rawSecond.value.data.input, second.submission);
  const again = await f.display(second.ref);
  assert.deepEqual(again.source.initialData.previous, { fact: { id: second.view.factId, mediaType: "application/json" },
    presentation: second.view.fact.presentation?.resource, submission: second.submission });
  assert.deepEqual(Object.keys(again.source.initialData.previous ?? {}).sort(), ["fact", "presentation", "submission"]);
  assert.deepEqual(again.source.initialData.data, f.initial.data);
  assert.equal(again.source.artifact.value.resource.id, f.html.id);
  assert.deepEqual(await f.client.call("display.invoke", second.params), second.completed);
  assert.equal(await f.count(), before + 1);
  assert.deepEqual(await f.bytes({ spaceId: f.space.id, id: first.view.factId, mediaType: "application/json" }), firstBytes);
  assert.deepEqual(await callLearning(f.client, "attempt.get", { spaceId: f.space.id, ref: first.ref }), original);
  await f.reopen();
  assert.deepEqual(await f.display(second.ref), again);
});

test("删去前次聚合并prune后新作答登记完整前件闭包，content.copy与space.copy均能继续恢复", async t => {
  const f = await fixture(t);
  const first = await f.submit();
  const restored = await f.display(first.ref);
  const second = await f.submit(restored.source);
  const expected = await f.display(second.ref);
  assert(first.view.fact.presentation);
  const resources = [f.html, f.material, f.css,
    { spaceId: f.space.id, id: first.view.factId, mediaType: "application/json" },
    { spaceId: f.space.id, ...first.view.fact.presentation.resource },
  ];
  const registered = await f.client.call("content.get", { target: { kind: "content", ref: second.ref } });
  for (const resource of resources) assert(registered.resources.some(item => item.id === resource.id && item.mediaType === resource.mediaType));
  const isolated = await f.independentContent();
  const index = await f.client.readText({ kind: "content", ref: second.ref });
  const importedBytes = new Map<string, Buffer>();
  for (const resource of registered.resources) {
    const bytes = await f.bytes(resource);
    assert.equal(await isolated.blobs.put(bytes), resource.id);
    importedBytes.set(resource.id, bytes);
  }
  const writing = randomUUID();
  await isolated.write({ operationId: writing, target: isolated.target("attempt.json"), base: { kind: "absent" },
    value: { kind: "text", text: index.text } });
  const registering = randomUUID();
  const isolatedResources = registered.resources.map(resource => ({ ...resource, spaceId: isolated.options.spaceId }));
  const imported = await isolated.applyPatch({ operationId: registering, patch: "*** Begin Patch\n*** End Patch",
    registrations: [{ path: "attempt.json", role: "document", resources: isolatedResources }] });
  const isolatedRef = imported.contents[0]?.ref;
  assert(isolatedRef);
  await isolated.pruneHistory([writing, registering]);
  assert.equal(isolated.journal.entries.size, 0);
  assert.deepEqual(await readdir(path.join(isolated.options.root, ".repa/runtime/processing")), []);
  assert.deepEqual(await readdir(path.join(isolated.options.root, ".repa/sessions")), []);
  await assert.rejects(readFile(isolated.retention.file), { code: "ENOENT" });
  assert.deepEqual(isolated.retention.snapshot().state.owners, {});
  const unowned = await isolated.blobs.put("没有owner的回收对照");
  await isolated.collectResources();
  await assert.rejects(isolated.blobs.get(unowned), error => error instanceof RepaFault && error.code === "revision_unavailable");
  const isolatedView = await new LearningAttempts(isolated).get(isolatedRef);
  assert.equal(isolatedView.factId, second.view.factId);
  assert.deepEqual(isolatedView.fact, second.view.fact);
  assert.deepEqual(isolatedView.resources, isolatedResources);
  for (const resource of isolatedView.resources) assert.deepEqual(await isolated.blobs.get(resource.id), importedBytes.get(resource.id));
  assert.deepEqual((await isolated.observe(scope => scope.read(isolatedRef))).bytes, Buffer.from(index.text));
  await assert.rejects(readFile(isolated.retention.file), { code: "ENOENT" });
  const originalBytes = await Promise.all(resources.map(resource => f.bytes(resource)));
  const old = await f.client.call("content.get", { target: { kind: "content", ref: first.ref } });
  assert(old.bodyRevision);
  const removeId = randomUUID();
  await f.client.call("content.remove", { target: { kind: "content", ref: first.ref }, operationId: removeId, base: old.bodyRevision });
  for (const upload of f.uploads) await f.client.call("resource.release", { spaceId: f.space.id, id: upload.id });
  await f.client.call("operation.prune", { spaceId: f.space.id, operationIds: [first.params.requestId, second.params.requestId, removeId] });
  await f.client.call("resource.collect", { spaceId: f.space.id });
  for (const [index, resource] of resources.entries()) assert.deepEqual(await f.bytes(resource), originalBytes[index]);
  assert.deepEqual(await f.display(second.ref), expected);
  const info = await f.client.call("content.get", { target: { kind: "content", ref: second.ref } });
  assert(info.revision);
  const copied = await f.client.call("content.copy", { target: { kind: "content", ref: second.ref }, base: info.revision,
    operationId: randomUUID(), destination: { kind: "relative", path: "copied-attempt.json" } });
  const copiedRef = copied.contents[0]?.ref;
  assert(copiedRef && copiedRef.id !== second.ref.id);
  assert.deepEqual(await f.display(copiedRef), expected);
  const spaceCopy = await f.client.call("space.copy", { spaceId: f.space.id, operationId: randomUUID(), destination: path.join(f.root, "space-copy") });
  assert.equal(spaceCopy.status, "completed");
  await f.client.call("space.open", { path: spaceCopy.destination });
  const copyRef = { spaceId: spaceCopy.spaceId, id: second.ref.id };
  const inCopy = await f.display(copyRef);
  assert.deepEqual(inCopy.source.initialData, expected.source.initialData);
  assert.equal(inCopy.source.artifact.value.resource.id, f.html.id);
  assert(inCopy.source.artifact.resources.every(resource => resource.spaceId === spaceCopy.spaceId));
  const copyView = await callLearning(f.client, "attempt.get", { spaceId: spaceCopy.spaceId, ref: copyRef });
  assert.deepEqual(copyView.fact, second.view.fact);
  const third = await f.submit(inCopy.source, { response: "新的副本回答", assistance: { kind: "reported", text: "" } }, spaceCopy.spaceId);
  assert.equal(third.view.current, null);
  assert.equal(third.view.fact.recordedBy.kind, "display");
  assert.deepEqual((await f.display(third.ref)).source.initialData.previous?.submission, third.submission);
  assert.deepEqual(await callLearning(f.client, "attempt.get", { spaceId: f.space.id, ref: second.ref }), second.view);
});

async function importedAttempt(f: Awaited<ReturnType<typeof fixture>>, baseline: AttemptView, bytes: Uint8Array,
  alter?: (fact: AttemptView["fact"]) => void) {
  const rawUpload = await f.client.uploadResource(f.space.id, bytes, "application/json");
  const fact = structuredClone(baseline.fact);
  assert(fact.presentation);
  const oldRawId = fact.presentation.resource.id;
  fact.presentation.resource = { id: rawUpload.resource.id, mediaType: "application/json" };
  const newRawResource = { ...fact.presentation.resource };
  for (const report of [fact.initialConditions, fact.assistance]) {
    if (report.kind === "reported" && report.sources) report.sources = report.sources.map(snapshot => ({
      ...snapshot, resource: snapshot.resource.id === oldRawId ? { ...newRawResource } : snapshot.resource,
    }));
  }
  alter?.(fact);
  const factUpload = await f.client.uploadResource(f.space.id, Buffer.from(`${canonicalJson(fact)}\n`), "application/json");
  const record = { format: "repa.learning-attempt", version: 1,
    fact: { id: factUpload.resource.id, mediaType: "application/json" }, judgments: [], selections: [] };
  assert(Check(AttemptRecordSchema, record));
  const indexUpload = await f.client.uploadResource(f.space.id, Buffer.from(`${canonicalJson(record)}\n`), "application/json");
  const file = `imported-${randomUUID()}.json`;
  await f.client.call("content.write", { target: { kind: "file", spaceId: f.space.id, location: { kind: "relative", path: file } },
    operationId: randomUUID(), base: { kind: "absent" }, value: { kind: "resource", resource: indexUpload.resource } });
  const resources = [...new Map([...baseline.resources, rawUpload.resource, factUpload.resource, indexUpload.resource]
    .map(resource => [`${resource.id}:${resource.mediaType}`, resource])).values()];
  const registered = await f.client.call("content.applyPatch", { spaceId: f.space.id, operationId: randomUUID(),
    patch: "*** Begin Patch\n*** End Patch", registrations: [{ path: file, role: "document", resources }] });
  const ref = registered.contents[0]?.ref;
  assert(ref);
  for (const upload of [rawUpload, factUpload, indexUpload])
    await f.client.call("resource.release", { spaceId: f.space.id, id: upload.id });
  assert.deepEqual((await callLearning(f.client, "attempt.get", { spaceId: f.space.id, ref })).fact, fact,
    "反例必须先是可读取的通用作答记录，而不是被另一种格式错误提前拦住");
  return { ref, target: { kind: "content" as const, ref } };
}

test("v1仍可录入但不能冒充v2恢复，坏UTF8、格式、字段和呈现闭包明确拒绝且不修补原件", async t => {
  const f = await fixture(t);
  const legacy = { ...f.initial, format: { id: "repa.learning-response" as const, version: "1" as const } };
  const v1 = await f.submit({ ...f.source, initialData: legacy });
  await assert.rejects(f.display(v1.ref), fault("unsupported_format"));
  const fresh = await f.submit(f.source, { response: "5", assistance: { kind: "reported", text: "本次帮助报告" } });
  const baseline = await f.raw(fresh.view);
  const humanImport = await importedAttempt(f, fresh.view, Buffer.from(JSON.stringify(baseline)), fact => {
    fact.recordedBy = { kind: "client", hostId: "fixture-import" };
  });
  assert((await f.display(humanImport.ref)).source.initialData.previous, "人工导入来源与历史display来源不同仍可恢复");
  const cases: { bytes: Uint8Array; alter?: (fact: AttemptView["fact"]) => void }[] = [
    { bytes: Buffer.from([0xff, 0x7b, 0x7d]) },
    { bytes: Buffer.from("{坏JSON\n") },
    { bytes: Buffer.from(JSON.stringify({ ...baseline, format: { id: "not-a-display-result", version: "1" } })) },
    { bytes: Buffer.from(JSON.stringify({ ...baseline, value: { ...baseline.value,
      data: { ...baseline.value.data, initialData: { ...f.initial, unexpected: true } } } })) },
    { bytes: Buffer.from(JSON.stringify(baseline)), alter: fact => { fact.actor = { kind: "assistant" }; } },
    { bytes: Buffer.from(JSON.stringify(baseline)), alter: fact => { fact.response = { kind: "text", text: "不相同的原回答" }; } },
    { bytes: Buffer.from(JSON.stringify(baseline)), alter: fact => { fact.materials[0] = { resource: { id: f.css.id, mediaType: f.css.mediaType } }; } },
    { bytes: Buffer.from(JSON.stringify(baseline)), alter: fact => { assert(fact.presentation); fact.presentation.resources = []; } },
    { bytes: Buffer.from(JSON.stringify(baseline)), alter: fact => { fact.initialConditions = { kind: "unknown" }; } },
    { bytes: Buffer.from(JSON.stringify(baseline)), alter: fact => {
      assert(fact.initialConditions.kind === "reported" && fact.presentation);
      fact.initialConditions.sources = [{ resource: fact.presentation.resource, selector: "/value/data/input" }];
    } },
    { bytes: Buffer.from(JSON.stringify(baseline)), alter: fact => {
      assert(fact.assistance.kind === "reported" && fact.presentation);
      fact.assistance.sources = [{ resource: fact.presentation.resource, selector: "/value/data/initialData" }];
    } },
    { bytes: Buffer.from(JSON.stringify(baseline)), alter: fact => {
      assert(fact.initialConditions.kind === "reported");
      fact.initialConditions.sources = [{ resource: { id: f.material.id, mediaType: f.material.mediaType }, selector: "/value/data/initialData" }];
    } },
    { bytes: Buffer.from(JSON.stringify(baseline)), alter: fact => {
      assert(fact.assistance.kind === "reported");
      fact.assistance.sources = [{ resource: { id: f.material.id, mediaType: f.material.mediaType }, selector: "/value/data/input/assistance" }];
    } },
  ];
  for (const item of cases) {
    const imported = await importedAttempt(f, fresh.view, item.bytes, item.alter);
    const before = await f.client.readText(imported.target);
    const count = await f.count();
    await assert.rejects(f.display(imported.ref), fault("unsupported_format"));
    assert.deepEqual(await f.client.readText(imported.target), before);
    assert.equal(await f.count(), count);
  }
});

test("继续提交核对前件事实、呈现、原submission、条件和获准闭包，伪造不产生新作答", async t => {
  const f = await fixture(t);
  const first = await f.submit();
  const restored = await f.display(first.ref);
  const previous = restored.source.initialData.previous;
  assert(previous);
  const variants: { source: typeof restored.source; code: string }[] = [];
  const wrongSubmission = structuredClone(restored.source);
  assert(wrongSubmission.initialData.previous);
  wrongSubmission.initialData.previous.submission.response = "伪造前次回答";
  variants.push({ source: wrongSubmission, code: "unsupported_format" });
  const wrongFact = structuredClone(restored.source);
  assert(wrongFact.initialData.previous);
  wrongFact.initialData.previous.fact = { ...previous.presentation };
  variants.push({ source: wrongFact, code: "unsupported_format" });
  const wrongPresentation = structuredClone(restored.source);
  assert(wrongPresentation.initialData.previous);
  wrongPresentation.initialData.previous.presentation = { ...previous.fact };
  variants.push({ source: wrongPresentation, code: "unsupported_format" });
  const wrongActor = structuredClone(restored.source);
  wrongActor.initialData.actor.kind = "assistant";
  variants.push({ source: wrongActor, code: "unsupported_format" });
  const wrongMaterials = structuredClone(restored.source);
  wrongMaterials.initialData.materials[0] = { resourceId: f.css.id, selector: "not-the-old-material" };
  variants.push({ source: wrongMaterials, code: "unsupported_format" });
  const wrongConditions = structuredClone(restored.source);
  wrongConditions.initialData.data = { prompt: "偷偷改题" };
  variants.push({ source: wrongConditions, code: "unsupported_format" });
  const absentPermission = structuredClone(restored.source);
  absentPermission.artifact.resources = absentPermission.artifact.resources.filter(resource => resource.id !== previous.fact.id);
  variants.push({ source: absentPermission, code: "permission_required" });
  const missingDependency = structuredClone(restored.source);
  missingDependency.artifact.resources = missingDependency.artifact.resources.filter(resource => resource.id !== f.css.id);
  variants.push({ source: missingDependency, code: "permission_required" });
  const badFields = structuredClone(restored.source);
  assert(badFields.initialData.previous);
  Object.assign(badFields.initialData.previous, { unknownField: true });
  variants.push({ source: badFields, code: "invalid_input" });
  const count = await f.count();
  for (const item of variants) {
    const instance = await f.open(item.source);
    const requestId = randomUUID();
    await f.client.call("display.invoke", { spaceId: f.space.id, instanceId: instance.instanceId, requestId,
      action: PROCESS_RESULT, input: { response: "合法的新回答", assistance: { kind: "unknown" } } });
    await f.client.call("display.close", { spaceId: f.space.id, instanceId: instance.instanceId });
    const request = await f.finish(requestId);
    assert.equal(request.status, "failed", JSON.stringify(request));
    assert.equal(request.error?.code, item.code);
    assert.equal((await f.client.call("operation.get", { spaceId: f.space.id, operationId: requestId })).status, "unknown");
    assert.equal(await f.count(), count);
  }
  assert.deepEqual(await callLearning(f.client, "attempt.get", { spaceId: f.space.id, ref: first.ref }), first.view);
});

test("已保存v2呈现的直接previous也必须存在且原submission一致，不递归祖先来填补坏前件", async t => {
  const f = await fixture(t);
  const first = await f.submit();
  const second = await f.submit((await f.display(first.ref)).source);
  const baseline = await f.raw(second.view);
  const initial = baseline.value.data.initialData;
  assert(Check(ExerciseInitialV2Schema, initial) && initial.previous);
  const missing = structuredClone(initial);
  assert(missing.previous);
  missing.previous.fact.id = "0".repeat(64);
  const wrong = structuredClone(initial);
  assert(wrong.previous);
  wrong.previous.submission.response = "不是前次原回答";
  for (const [changed, error] of [[missing, "permission_required"], [wrong, "unsupported_format"]] as const) {
    const raw = { ...baseline, value: { ...baseline.value, data: { ...baseline.value.data, initialData: changed } } };
    const imported = await importedAttempt(f, second.view, Buffer.from(JSON.stringify(raw)));
    const before = await f.client.readText(imported.target);
    await assert.rejects(f.display(imported.ref), fault(error));
    assert.deepEqual(await f.client.readText(imported.target), before);
  }
  assert.deepEqual(await callLearning(f.client, "attempt.get", { spaceId: f.space.id, ref: first.ref }), first.view);
  assert.deepEqual(await callLearning(f.client, "attempt.get", { spaceId: f.space.id, ref: second.ref }), second.view);
});
