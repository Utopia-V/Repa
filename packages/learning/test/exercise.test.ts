import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Check } from "typebox/value";
import { RepaClient, RpcError, ContentChangeResultSchema, DisplayResultSchema } from "repa";
import { startLearningServer } from "@repa/learning/product";
import { callLearning } from "@repa/learning/client";
import { type AttemptFactInput, type JudgmentInput, AttemptRecordSchema } from "../src/attempt-schema.js";
import { ExerciseSubmissionSchema, type ExerciseInitial } from "../src/exercise-schema.js";
import { attemptInputResources, judgmentInputResources } from "../src/attempts.js";

const contract = { id: "repa.attempt.record-display", version: "1" };
const fault = (code: string) => (error: unknown) => error instanceof RpcError &&
  error.data !== null && typeof error.data === "object" && "code" in error.data && error.data.code === code;

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-exercise-"));
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [],
    extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"] }));
  const server = await startLearningServer({ appDirectory: path.join(root, "app"), agentDir, bundledPackages: [], trustExtensions: false });
  const client = await RepaClient.connect(server.connection);
  t.after(async () => { await server.close("cancel"); await client.close(); await rm(root, { recursive: true, force: true }); });
  const space = await client.call("space.open", { path: path.join(root, "space") });
  const originals = ["<!doctype html><p>学习页面</p>", "固定题面：计算 2+3", "p { color: navy; }"];
  const uploads = await Promise.all(originals.map((text, index) => {
    const mediaType = ["text/html", "text/plain", "text/css"][index];
    assert(mediaType);
    return client.uploadResource(space.id, new TextEncoder().encode(text), mediaType);
  }));
  const [html, material, asset] = uploads.map(upload => upload.resource);
  assert(html && material && asset);
  const artifact = { format: { id: "repa.display-html" as const, version: "1" as const },
    value: { kind: "resource" as const, resource: html }, sources: [], resources: [material, asset] };
  const initial: ExerciseInitial = {
    format: { id: "repa.learning-response", version: "1" }, actor: { kind: "synthetic", label: "fixture" },
    materials: [{ resourceId: material.id, selector: "addition", source: "fixture:original" }], data: { prompt: "2+3" },
  };
  const open = (initialData: unknown = initial) => client.call("display.open", {
    spaceId: space.id, instanceId: randomUUID(), source: { kind: "artifact", artifact, initialData },
    processResult: { selection: { contract, implementationId: "official" }, inputSchema: { ...ExerciseSubmissionSchema } },
  });
  const finish = async (requestId: string) => {
    const deadline = Date.now() + 8000;
    for (;;) {
      const request = await client.call("request.get", { spaceId: space.id, requestId });
      if (["completed", "failed", "cancelled", "interrupted"].includes(request.status)) return request;
      if (Date.now() >= deadline) assert.fail(`展示处理超时：${JSON.stringify(request)}`);
      await delay(10);
    }
  };
  return { client, space, artifact, initial, open, finish, originals, uploads };
}

test("真实页面绑定固定原展示条件，空回答与帮助报告连同附属字节长期保存", async t => {
  const f = await fixture(t);
  for (const assistance of [{ kind: "unknown" as const }, { kind: "reported" as const, text: "  看过一次提示\n原样保留  " }]) {
    const initial = structuredClone(f.initial);
    const instance = await f.open(initial);
    initial.actor.kind = "assistant";
    initial.data = { prompt: "调用方后来改写" };
    const requestId = randomUUID();
    const input = { response: "", assistance, data: { events: [{ kind: "hint", sequence: 1 }] } };
    const submitted = { spaceId: f.space.id, instanceId: instance.instanceId, requestId, action: "process-display-result" as const, input };
    await f.client.call("display.invoke", submitted);
    await f.client.call("display.close", { spaceId: f.space.id, instanceId: instance.instanceId });
    const finished = await f.finish(requestId);
    assert.equal(finished.status, "completed", JSON.stringify(finished));
    assert("operation" in finished && finished.result?.value.kind === "inline");
    const result: unknown = finished.result.value.data;
    assert(Check(ContentChangeResultSchema, result));
    const ref = result.contents[0]?.ref;
    assert(ref);
    const view = await callLearning(f.client, "attempt.get", { spaceId: f.space.id, ref });
    assert.deepEqual(view.fact.actor, f.initial.actor);
    assert.deepEqual(view.fact.response, { kind: "text", text: "" });
    assert.equal(view.fact.recordedBy.kind, "display");
    assert(view.fact.recordedBy.kind === "display");
    assert.equal(view.fact.recordedBy.instanceId, instance.instanceId);
    assert.equal(view.fact.recordedBy.spaceId, f.space.id);
    assert(view.fact.presentation);
    const rawRef = { spaceId: f.space.id, ...view.fact.presentation.resource };
    const raw: unknown = JSON.parse(await (await f.client.resource(rawRef)).text());
    assert(Check(DisplayResultSchema, raw));
    assert.deepEqual(raw.value.data.source, view.fact.recordedBy);
    assert.deepEqual(raw.value.data.initialData, f.initial);
    assert.deepEqual(raw.value.data.input, input);
    assert.deepEqual(raw.value.data.artifact, f.artifact);
    assert.deepEqual(view.fact.presentation.resources, [f.artifact.value.resource, ...f.artifact.resources].map(({ id, mediaType }) => ({ id, mediaType })));
    assert.equal(view.fact.materials.length, 1, "HTML和CSS属于呈现依赖，不冒充题面");
    assert.deepEqual(view.fact.assistance.kind === "unknown" ? view.fact.assistance : { kind: view.fact.assistance.kind, text: view.fact.assistance.text }, assistance);
    const held = await f.client.call("content.get", { target: { kind: "content", ref } });
    for (const resource of [rawRef, f.artifact.value.resource, ...f.artifact.resources]) assert(held.resources.some(item => item.id === resource.id));
    for (const upload of f.uploads) await f.client.call("resource.release", { spaceId: f.space.id, id: upload.id });
    await f.client.call("operation.prune", { spaceId: f.space.id, operationIds: [requestId] });
    await f.client.call("resource.collect", { spaceId: f.space.id });
    for (const [index, resource] of [f.artifact.value.resource, ...f.artifact.resources].entries())
      assert.equal(await (await f.client.resource(resource)).text(), f.originals[index]);
    assert.deepEqual((await callLearning(f.client, "attempt.get", { spaceId: f.space.id, ref })).fact, view.fact);
    assert.equal((await f.client.call("display.invoke", submitted)).status, "completed");
    await assert.rejects(f.client.call("capability.invoke", { scope: { kind: "space", spaceId: f.space.id },
      requestId: randomUUID(), contract, input: { operationId: randomUUID(), result: raw } }), fault("permission_required"));
  }
});

test("绑定作答拒绝越界题面与坏初始化，坏提交先于领域保存拒绝", async t => {
  const f = await fixture(t);
  const other = await f.client.call("space.open", { path: path.join(f.space.path, "..", "other") });
  const foreign = await f.client.uploadResource(other.id, new TextEncoder().encode("外部题面"), "text/plain");
  for (const [initial, error] of [
    [{ ...f.initial, materials: [{ resourceId: foreign.resource.id }] }, "permission_required"],
    [{ ...f.initial, materials: [{ resourceId: "0".repeat(64) }] }, "permission_required"],
    [{ ...f.initial, actor: { kind: "invalid" } }, "invalid_input"],
  ] as const) {
    const instance = await f.open(initial);
    const requestId = randomUUID();
    await f.client.call("display.invoke", { spaceId: f.space.id, instanceId: instance.instanceId, requestId,
      action: "process-display-result", input: { response: "5", assistance: { kind: "unknown" } } });
    const request = await f.finish(requestId);
    assert.equal(request.status, "failed", JSON.stringify(request));
    assert("error" in request && request.error?.code === error);
    await f.client.call("display.close", { spaceId: f.space.id, instanceId: instance.instanceId });
  }
  const instance = await f.open();
  await assert.rejects(f.client.call("display.invoke", { spaceId: f.space.id, instanceId: instance.instanceId,
    requestId: randomUUID(), action: "process-display-result", input: { response: 5, assistance: { kind: "unknown" } } }), fault("invalid_input"));
  assert.equal((await f.client.call("content.get", { target: { kind: "file", spaceId: f.space.id,
    location: { kind: "relative", path: "learning/attempts" } } })).status, "missing");
});

test("显式snapshot闭包经公共事实与判断遍历持有，旧省略字段不补空依赖", async t => {
  const f = await fixture(t);
  const [primary, dependency] = f.artifact.resources;
  assert(primary && dependency);
  const snapshot = { resource: primary, resources: [dependency], source: "fixture:dependencies" };
  const fact: AttemptFactInput = {
    actor: { kind: "unknown" }, response: { kind: "text", text: "原回答" }, materials: [snapshot],
    presentation: snapshot, initialConditions: { kind: "unknown" },
    assistance: { kind: "reported", text: "原报告", sources: [snapshot] },
  };
  assert.equal(attemptInputResources(fact).filter(resource => resource.id === dependency.id).length, 3);
  const result = await callLearning(f.client, "attempt.record", { spaceId: f.space.id, operationId: randomUUID(), fact });
  const ref = result.contents[0]?.ref;
  assert(ref);
  const view = await callLearning(f.client, "attempt.get", { spaceId: f.space.id, ref });
  const localDependency = { id: dependency.id, mediaType: dependency.mediaType };
  assert.deepEqual(view.fact.materials[0]?.resources, [localDependency]);
  assert.deepEqual(view.fact.presentation?.resources, [localDependency]);
  assert(view.fact.assistance.kind === "reported");
  assert.deepEqual(view.fact.assistance.sources?.[0]?.resources, [localDependency]);
  const judgment: JudgmentInput = {
    factId: view.factId, method: { kind: "human", name: "fixture", version: null, execution: snapshot },
    basis: [snapshot], report: snapshot, conclusions: [{ criterion: "核对", verdict: "undetermined", explanation: "待研究" }],
  };
  assert.equal(judgmentInputResources(judgment).filter(resource => resource.id === dependency.id).length, 3);
  await callLearning(f.client, "attempt.judgment.save", { spaceId: f.space.id, operationId: randomUUID(), ref, base: view.base, judgment });
  const updated = await callLearning(f.client, "attempt.get", { spaceId: f.space.id, ref });
  assert.deepEqual(updated.judgments[0]?.method.execution?.resources, [localDependency]);
  assert.deepEqual(updated.judgments[0]?.basis[0]?.resources, [localDependency]);
  assert.deepEqual(updated.judgments[0]?.report?.resources, [localDependency]);
  const oldFact = { actor: fact.actor, response: fact.response, materials: [{ resource: primary }],
    initialConditions: fact.initialConditions, assistance: { kind: "unknown" as const } };
  const oldResult = await callLearning(f.client, "attempt.record", { spaceId: f.space.id, operationId: randomUUID(), fact: oldFact });
  const oldRef = oldResult.contents[0]?.ref;
  assert(oldRef);
  const old = await callLearning(f.client, "attempt.get", { spaceId: f.space.id, ref: oldRef });
  const oldMaterial = old.fact.materials[0];
  assert(oldMaterial);
  assert(!Object.hasOwn(oldMaterial, "resources"));
  const info = await f.client.call("content.get", { target: { kind: "content", ref: oldRef } });
  assert.equal(info.location.kind, "relative");
  const record: unknown = JSON.parse(await readFile(path.join(f.space.path, info.location.path), "utf8"));
  assert(Check(AttemptRecordSchema, record));
  const bytes = await (await f.client.resource({ spaceId: f.space.id, ...record.fact })).text();
  assert.equal(bytes.includes('"resources"'), false);
});
