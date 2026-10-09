import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Check } from "typebox/value";
import { RepaApplication } from "repa";
import { canonicalJson, digest, Type, type BackendPluginRegistration, type ContentStore } from "repa/plugin";
import { RepaFault, type CapabilitySource, type ContentChangeResult, type ContentRef, type ResourceRef } from "repa/protocol";
import { AttemptRecordSchema, type AttemptView, type JudgmentInput, type RecordAttemptInput, type SaveJudgmentInput } from "../src/attempt-schema.js";
import { LearningAttempts } from "../src/attempts.js";

const source: CapabilitySource = { kind: "client", hostId: "fixture" };
const laterSource: CapabilitySource = { kind: "client", hostId: "later-fixture" };
const code = (expected: string) => (error: unknown) => error instanceof RepaFault && error.code === expected;
const target = (ref: ContentRef) => ({ kind: "content" as const, ref });

function resultRef(result: ContentChangeResult) {
  assert.equal(result.contents.length, 1);
  const ref = result.contents[0]?.ref;
  assert(ref);
  return ref;
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-attempts-"));
  const directory = path.join(root, "space");
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [],
    extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"] }));
  let application: RepaApplication | undefined;
  const captured = new Map<string, ContentStore>();
  const contract = { id: "fixture.attempt-content", version: "1" };
  const registration: BackendPluginRegistration = { id: "attempt-fixture", enabled: true, factory: () => ({
    capabilities: [{ contract, implementationId: "local", scopes: ["space"], execution: "query",
      inputSchema: Type.Object({}, { additionalProperties: false }), outputSchema: Type.Null(),
      invoke(_input, context) {
        assert(context.content);
        captured.set("current", context.content);
        return null;
      },
    }],
  }) };
  const open = async () => {
    if (application) {
      application.shutdown("cancel");
      await application.closed;
    }
    captured.clear();
    application = new RepaApplication({ appDirectory: path.join(root, "app"), agentDir,
      plugins: [registration], bundledPackages: [] });
    const space = await application.openSpace(directory);
    await application.invokeCapability({ scope: { kind: "space", spaceId: space.id },
      requestId: randomUUID(), contract, input: {} }, "fixture");
    const content = captured.get("current");
    assert(content);
    return { content, attempts: new LearningAttempts(content) };
  };
  t.after(async () => {
    try {
      application?.shutdown("cancel");
      await application?.closed;
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  const initial = await open();
  const raw: ResourceRef[] = [];
  const sourceDocuments: ContentRef[] = [];
  for (const [index, text] of ["固定题目：化简2(x+3)。\n", "原始回答：2x+3\n", "实际呈现与初值\n"].entries()) {
    const resource: ResourceRef = { spaceId: initial.content.options.spaceId,
      id: await initial.content.blobs.put(text), mediaType: "text/plain" };
    raw.push(resource);
    const file = `source-${index}.txt`;
    const result = await initial.content.applyPatch({ operationId: randomUUID(),
      patch: ["*** Begin Patch", `*** Add File: ${file}`, ...text.slice(0, -1).split("\n").map(line => `+${line}`), "*** End Patch"].join("\n"),
      registrations: [{ path: file, role: "document", resources: [resource] }] });
    sourceDocuments.push(resultRef(result));
  }
  const material = raw[0];
  const response = raw[1];
  const presentation = raw[2];
  assert(material && response && presentation);
  const input = (): RecordAttemptInput => ({ operationId: randomUUID(), fact: {
    actor: { kind: "synthetic", label: "确定性夹具" },
    response: { kind: "resource", resource: response },
    materials: [{ resource: material, selector: "题目1", source: "fixture:original-material" }],
    presentation: { resource: presentation }, initialConditions: { kind: "unknown" }, assistance: { kind: "unknown" },
  } });
  const record = async () => {
    const params = input();
    const result = await initial.attempts.record(params, source);
    const ref = resultRef(result);
    return { params, result, ref, view: await initial.attempts.get(ref) };
  };
  return { root, directory, ...initial, open, material, response, presentation, sourceDocuments, input, record };
}

function judgment(view: AttemptView, basis: ResourceRef, explanation = "原回答遗漏分配项"): JudgmentInput {
  return { factId: view.factId, method: { kind: "program", name: "fixture-rule", version: "1" },
    basis: [{ resource: basis }], conclusions: [{ criterion: "分配律", verdict: "not-met", explanation }] };
}

function saveInput(view: AttemptView, basis: ResourceRef, explanation?: string): SaveJudgmentInput {
  return { operationId: randomUUID(), ref: view.ref, base: view.base, judgment: judgment(view, basis, explanation) };
}

async function index(content: ContentStore, ref: ContentRef) {
  const read = await content.observe(scope => scope.read(ref));
  assert(read.bytes);
  const value: unknown = JSON.parse(read.bytes.toString("utf8"));
  assert(Check(AttemptRecordSchema, value));
  return { content: read.content, bytes: read.bytes, record: value };
}

test("固定材料、原始回答和实际呈现独立保存，synthetic作答者与录入来源分开，判断不覆盖事实", async t => {
  const f = await fixture(t);
  const { ref, view } = await f.record();
  assert.equal(view.base, (await f.content.get(target(ref))).bodyRevision);
  assert.equal(view.fact.actor.kind, "synthetic");
  assert.deepEqual(view.fact.recordedBy, source);
  assert.deepEqual(view.fact.assistance, { kind: "unknown" });
  assert.deepEqual(view.fact.initialConditions, { kind: "unknown" });
  assert.equal(view.fact.materials[0]?.resource.id, f.material.id);
  assert.deepEqual(view.fact.response, { kind: "resource", resource: { id: f.response.id, mediaType: f.response.mediaType } });
  assert.equal(view.fact.presentation?.resource.id, f.presentation.id);
  const before = await f.content.blobs.get(view.factId);
  await writeFile(path.join(f.directory, "source-0.txt"), "后来修改的材料文件\n");
  await f.attempts.saveJudgment(saveInput(view, f.material), laterSource);
  const after = await f.attempts.get(ref);
  assert.deepEqual(after.fact, view.fact);
  assert.deepEqual(await f.content.blobs.get(after.factId), before);
  assert.equal((await f.content.blobs.get(f.material.id)).toString("utf8"), "固定题目：化简2(x+3)。\n");
  assert.equal((await f.content.blobs.get(f.response.id)).toString("utf8"), "原始回答：2x+3\n");
  assert.deepEqual(after.judgments[0]?.recordedBy, laterSource);
  assert.equal(after.current, null);
  assert.deepEqual(after.selections, []);
});

test("文本原回答与明确空帮助报告保留原文，不把unknown推断成无帮助", async t => {
  const f = await fixture(t);
  const params = f.input();
  params.fact.response = { kind: "text", text: "  2x+3\r\n我的原始尝试  " };
  params.fact.assistance = { kind: "reported", text: "", sources: [{ resource: f.presentation }] };
  const ref = resultRef(await f.attempts.record(params, source));
  const view = await f.attempts.get(ref);
  assert.deepEqual(view.fact.response, params.fact.response);
  assert.deepEqual(view.fact.assistance, { kind: "reported", text: "",
    sources: [{ resource: { id: f.presentation.id, mediaType: f.presentation.mediaType } }] });
});

test("候选不自动采用，supersedes仅接受本事实已有判断，明确采用与撤销追加完整历史链", async t => {
  const f = await fixture(t);
  const { ref, view } = await f.record();
  await f.attempts.saveJudgment(saveInput(view, f.material), source);
  const first = await f.attempts.get(ref);
  const prior = first.judgments[0];
  assert(prior);
  assert.equal(first.current, null);
  const wrongFact = saveInput(first, f.material);
  wrongFact.judgment.factId = "0".repeat(64);
  await assert.rejects(f.attempts.saveJudgment(wrongFact, source), code("invalid_input"));
  const unknownPrior = saveInput(first, f.material);
  unknownPrior.judgment.supersedes = { id: randomUUID(), reason: "引用未知候选" };
  await assert.rejects(f.attempts.saveJudgment(unknownPrior, source), code("invalid_input"));
  await assert.rejects(f.attempts.selectJudgment({ operationId: randomUUID(), ref, base: first.base,
    judgmentId: randomUUID(), reason: "未知采用目标" }, source), code("invalid_input"));
  const otherInput = f.input();
  otherInput.fact.response = { kind: "text", text: "另一份独立作答" };
  const otherRef = resultRef(await f.attempts.record(otherInput, source));
  const otherView = await f.attempts.get(otherRef);
  await f.attempts.saveJudgment(saveInput(otherView, f.material), source);
  const otherPrior = (await f.attempts.get(otherRef)).judgments[0];
  assert(otherPrior);
  const crossFactPrior = saveInput(first, f.material);
  crossFactPrior.judgment.supersedes = { id: otherPrior.id, reason: "不能替代别的作答判断" };
  await assert.rejects(f.attempts.saveJudgment(crossFactPrior, source), code("invalid_input"));
  assert.deepEqual(await f.attempts.get(ref), first);
  const correction = saveInput(first, f.material, "根据原始材料更正解释");
  correction.judgment.supersedes = { id: prior.id, reason: "解释需要更正" };
  correction.adopt = { reason: "明确采用更正" };
  await f.attempts.saveJudgment(correction, laterSource);
  const adopted = await f.attempts.get(ref);
  const replacement = adopted.judgments[1];
  assert(replacement);
  assert.equal(adopted.current, replacement.id);
  assert.deepEqual(adopted.judgments[0], prior);
  await f.attempts.selectJudgment({ operationId: randomUUID(), ref, base: adopted.base,
    judgmentId: prior.id, reason: "明确改回此前判断" }, source);
  const reselected = await f.attempts.get(ref);
  await f.attempts.selectJudgment({ operationId: randomUUID(), ref, base: reselected.base,
    judgmentId: null, reason: "撤销当前采用" }, laterSource);
  const revoked = await f.attempts.get(ref);
  assert.equal(revoked.current, null);
  assert.deepEqual(revoked.selections.map(item => [item.from, item.to]),
    [[null, replacement.id], [replacement.id, prior.id], [prior.id, null]]);
  assert.deepEqual(revoked.fact, view.fact);
});

test("旧正文基准拒绝判断，两份同基准竞争仅保存一个候选", async t => {
  const f = await fixture(t);
  const { ref, view } = await f.record();
  const a = saveInput(view, f.material, "候选A");
  const b = saveInput(view, f.material, "候选B");
  const results = await Promise.allSettled([f.attempts.saveJudgment(a, source), f.attempts.saveJudgment(b, laterSource)]);
  assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
  const failure = results.find(item => item.status === "rejected");
  assert(failure?.status === "rejected" && code("revision_conflict")(failure.reason));
  const current = await f.attempts.get(ref);
  assert.equal(current.judgments.length, 1);
  assert.equal(current.current, null);
  await assert.rejects(f.attempts.selectJudgment({ operationId: randomUUID(), ref, base: view.base,
    judgmentId: current.judgments[0]?.id ?? null, reason: "旧基准采用" }, source), code("revision_conflict"));
  assert.deepEqual(await f.attempts.get(ref), current);
  const observed = await index(f.content, ref);
  assert(observed.content.location.kind === "relative");
  await writeFile(path.join(f.directory, observed.content.location.path), Buffer.concat([observed.bytes, Buffer.from(" ")]));
  const externallyChanged = await f.attempts.get(ref);
  assert.notEqual(externallyChanged.base, current.base);
  assert.equal((await f.content.get(target(ref))).revision, observed.content.revision);
  await assert.rejects(f.attempts.saveJudgment(saveInput(current, f.material), source), code("revision_conflict"));
  assert.deepEqual(await f.attempts.get(ref), externallyChanged);
});

test("record/save/select按原业务操作重传，不因新来源时间或后来状态而重复追加", async t => {
  const f = await fixture(t);
  const clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const { params, result, ref, view } = await f.record();
  const saving = saveInput(view, f.material);
  const saved = await f.attempts.saveJudgment(saving, source);
  const candidate = await f.attempts.get(ref);
  const id = candidate.judgments[0]?.id;
  assert(id);
  const selecting = { operationId: randomUUID(), ref, base: candidate.base, judgmentId: id, reason: "明确选择" };
  const selected = await f.attempts.selectJudgment(selecting, source);
  const adopted = await f.attempts.get(ref);
  await f.attempts.selectJudgment({ operationId: randomUUID(), ref, base: adopted.base,
    judgmentId: null, reason: "后来撤销" }, laterSource);
  const final = await f.attempts.get(ref);
  t.mock.method(Date, "now", () => clock + 1000);
  assert.deepEqual(await f.attempts.record(params, laterSource), result);
  assert.deepEqual(await f.attempts.saveJudgment(saving, laterSource), saved);
  assert.deepEqual(await f.attempts.selectJudgment(selecting, laterSource), selected);
  assert.deepEqual(await f.attempts.get(ref), final);
  assert.deepEqual(final.fact.recordedBy, source);
  assert.equal(final.fact.recordedAt, clock);
  assert.equal(final.judgments[0]?.recordedAt, clock);
  assert.deepEqual(final.selections[0]?.recordedBy, source);
  const changed = structuredClone(params);
  changed.fact.provenance = "不同原意";
  await assert.rejects(f.attempts.record(changed, source), code("operation_id_conflict"));
  const reopened = await f.open();
  assert.deepEqual(await reopened.attempts.record(params, laterSource), result);
  assert.deepEqual(await reopened.attempts.saveJudgment(saving, laterSource), saved);
  assert.deepEqual(await reopened.attempts.selectJudgment(selecting, laterSource), selected);
  assert.deepEqual(await reopened.attempts.get(ref), final);
});

test("来源文档移除并清理操作历史后，重开和资源回收仍保留事实及候选证据", async t => {
  const f = await fixture(t);
  const { params, ref, view } = await f.record();
  const saving = saveInput(view, f.material);
  await f.attempts.saveJudgment(saving, source);
  const expected = await f.attempts.get(ref);
  const bytes = await Promise.all(expected.resources.map(resource => f.content.blobs.get(resource.id)));
  for (const sourceRef of f.sourceDocuments) {
    const info = await f.content.get(target(sourceRef));
    assert(info.bodyRevision);
    await f.content.remove({ target: target(sourceRef), base: info.bodyRevision, operationId: randomUUID() });
  }
  await f.content.pruneHistory([...f.content.journal.entries.keys()]);
  const reopened = await f.open();
  await reopened.content.collectResources();
  assert.deepEqual(await reopened.attempts.get(ref), expected);
  for (const [index, resource] of expected.resources.entries())
    assert.deepEqual(await reopened.content.blobs.get(resource.id), bytes[index]);
  await assert.rejects(reopened.attempts.record(params, laterSource), code("history_pruned"));
  await assert.rejects(reopened.attempts.saveJudgment(saving, laterSource), code("history_pruned"));
});

test("content.copy创建独立身份，保持原事实和历史来源字节，副本可独立追加更正", async t => {
  const f = await fixture(t);
  const { ref, view } = await f.record();
  const saving = saveInput(view, f.material);
  saving.adopt = { reason: "初次明确采用" };
  await f.attempts.saveJudgment(saving, source);
  const original = await f.attempts.get(ref);
  const originalIndex = await index(f.content, ref);
  const copyInfo = await f.content.get(target(ref));
  assert(copyInfo.revision);
  const copied = await f.content.transfer("copy", { operationId: randomUUID(), target: target(ref), base: copyInfo.revision,
    destination: { kind: "relative", path: "copied-attempt.json" } });
  const copyRef = resultRef(copied);
  assert.notEqual(copyRef.id, ref.id);
  const copy = await f.attempts.get(copyRef);
  assert.equal(copy.factId, original.factId);
  assert.deepEqual(copy.fact, original.fact);
  assert.deepEqual(copy.judgments, original.judgments);
  assert.deepEqual((await index(f.content, copyRef)).bytes, originalIndex.bytes);
  const correction = saveInput(copy, f.material, "副本中的独立更正");
  correction.judgment.supersedes = { id: copy.judgments[0]?.id ?? "missing", reason: "仅更正副本" };
  correction.adopt = { reason: "副本明确采用" };
  await f.attempts.saveJudgment(correction, laterSource);
  assert.deepEqual(await f.attempts.get(ref), original);
  assert.equal((await f.attempts.get(copyRef)).judgments.length, 2);
  assert.equal((await f.attempts.get(copyRef)).factId, original.factId);
});

test("损坏索引与缺失资源持有关系明确拒绝，读取不修补原记录", async t => {
  const f = await fixture(t);
  const { ref } = await f.record();
  const original = await index(f.content, ref);
  assert(original.content.location.kind === "relative");
  const file = path.join(f.directory, original.content.location.path);
  await writeFile(file, "{损坏JSON\n");
  await assert.rejects(f.attempts.get(ref), code("invalid_learning_record"));
  assert.equal(await readFile(file, "utf8"), "{损坏JSON\n");
  const encodingRecord = structuredClone(original.record);
  encodingRecord.selections.push({ id: randomUUID(), from: null, to: null, reason: "ENCODING_MARKER",
    recordedAt: Date.now(), recordedBy: source });
  const encodingText = `${canonicalJson(encodingRecord)}\n`;
  const [prefix, suffix] = encodingText.split("ENCODING_MARKER");
  assert(prefix && suffix);
  const invalidEncoding = Buffer.concat([Buffer.from(prefix), Buffer.from([0xff]), Buffer.from(suffix)]);
  await writeFile(file, invalidEncoding);
  await assert.rejects(f.attempts.get(ref), code("invalid_learning_record"));
  assert.deepEqual(await readFile(file), invalidEncoding);
  const invalidChain = structuredClone(original.record);
  invalidChain.selections.push({ id: randomUUID(), from: randomUUID(), to: null, reason: "损坏链",
    recordedAt: Date.now(), recordedBy: source });
  await writeFile(file, `${canonicalJson(invalidChain)}\n`);
  await assert.rejects(f.attempts.get(ref), code("invalid_learning_record"));
  await writeFile(file, original.bytes);
  const info = await f.content.get(target(ref));
  assert(info.revision);
  await f.content.setComposition({ operationId: randomUUID(), ref, base: info.revision,
    members: info.members, resources: info.resources.filter(resource => resource.id !== f.response.id) });
  await assert.rejects(f.attempts.get(ref), code("invalid_learning_record"));
  assert.deepEqual(await readFile(file), original.bytes);
});

test("真实证据blob缺失或跨空间证据拒绝录入，不建立部分作答文档", async t => {
  const f = await fixture(t);
  const before = await f.content.observe(async scope => scope.targets());
  const invalid = f.input();
  invalid.fact.materials[0] = { resource: { ...f.material, spaceId: randomUUID() } };
  await assert.rejects(f.attempts.record(invalid, source), code("permission_required"));
  assert.equal((await f.content.operation(invalid.operationId)).status, "unknown");
  assert.deepEqual(await f.content.observe(async scope => scope.targets()), before);
  const { ref } = await f.record();
  await rm(path.join(f.content.blobs.directory, f.response.id));
  await assert.rejects(f.attempts.get(ref), code("revision_unavailable"));
  const registered = await f.content.observe(async scope => scope.targets());
  const missing = f.input();
  await assert.rejects(f.attempts.record(missing, source), code("revision_unavailable"));
  assert.equal((await f.content.operation(missing.operationId)).status, "unknown");
  assert.deepEqual(await f.content.observe(async scope => scope.targets()), registered);
});

for (const method of ["save", "select"] as const) {
  test(`合法导入记录已有${method}派生ID时提交前拒绝，正文与证据持有不改变`, async t => {
    const f = await fixture(t);
    const collisions = method === "save" ? ["judgment", "selection", "adopt"] as const : ["judgment", "selection"] as const;
    for (const collision of collisions) {
      const { ref, view } = await f.record();
      await f.attempts.saveJudgment(saveInput(view, f.material), source);
      const candidateView = await f.attempts.get(ref);
      const loaded = await index(f.content, ref);
      const candidate = candidateView.judgments[0];
      assert(candidate && loaded.record.judgments[0]);
      const operationId = randomUUID();
      const prefix = method === "select" ? "repa.attempt.judgment.select"
        : collision === "adopt" ? "repa.attempt.judgment.save.adopt" : "repa.attempt.judgment.save";
      const collidingId = digest(`${prefix}:${operationId}`);
      const record = structuredClone(loaded.record);
      const resources = [...candidateView.resources];
      if (collision === "selection") {
        record.selections.push({ id: collidingId, from: null, to: null, reason: "合法导入的此前撤销记录",
          recordedAt: candidate.recordedAt, recordedBy: source });
      } else {
        const imported = { ...candidate, id: collidingId };
        const bytes = Buffer.from(`${canonicalJson(imported)}\n`);
        const resource = { id: await f.content.blobs.put(bytes), mediaType: "application/json" };
        record.judgments[0] = { id: collidingId, resource };
        resources.push({ spaceId: ref.spaceId, ...resource });
      }
      assert(loaded.content.location.kind === "relative" && loaded.content.revision);
      const file = path.join(f.directory, loaded.content.location.path);
      await writeFile(file, `${canonicalJson(record)}\n`);
      await f.content.setComposition({ operationId: randomUUID(), ref, base: loaded.content.revision,
        members: loaded.content.members, resources });
      const legal = await f.attempts.get(ref);
      assert.equal(legal.judgments.length, 1, "导入记录本身必须先能完整读取");
      assert.equal((await f.content.operation(operationId)).status, "unknown");
      const before = await readFile(file);
      const blobs = (await readdir(f.content.blobs.directory)).sort();
      if (method === "save") {
        const input = { ...saveInput(legal, f.material), operationId };
        if (collision === "adopt") input.adopt = { reason: "新判断同次明确采用" };
        await assert.rejects(f.attempts.saveJudgment(input, laterSource), code("invalid_input"));
      } else {
        await assert.rejects(f.attempts.selectJudgment({ operationId, ref, base: legal.base,
          judgmentId: legal.judgments[0]?.id ?? null, reason: "明确选择已有候选" }, laterSource), code("invalid_input"));
      }
      assert.deepEqual(await readFile(file), before);
      assert.deepEqual(await f.attempts.get(ref), legal);
      assert.deepEqual((await f.content.get(target(ref))).resources, resources);
      assert.deepEqual((await readdir(f.content.blobs.directory)).sort(), blobs);
      assert.equal((await f.content.operation(operationId)).status, "unknown");
    }
  });
}
