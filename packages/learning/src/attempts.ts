import { Check } from "typebox/value";
import { canonicalJson, digest, type ContentPatchScope, type ContentStore, type DerivedContentPatch } from "repa/plugin";
import {
  CapabilitySourceSchema, ContentRefSchema, RepaFault,
  type CapabilitySource, type ContentChangeResult, type ContentInfo, type ContentRef, type ResourceRef,
} from "repa/protocol";
import {
  AttemptFactSchema, AttemptJudgmentSchema, AttemptRecordSchema,
  LocalResourceSchema, RecordAttemptInputSchema, SaveJudgmentInputSchema, SelectJudgmentInputSchema,
  type AttemptFact, type AttemptFactInput, type AttemptJudgment, type AttemptRecord, type AttemptSelection,
  type AttemptView, type JudgmentInput, type LocalResource, type RecordAttemptInput,
  type SaveJudgmentInput, type SelectJudgmentInput,
} from "./attempt-schema.js";

type InputSnapshot = AttemptFactInput["materials"][number];
type LocalSnapshot = AttemptFact["materials"][number];
type InputReport = AttemptFactInput["assistance"];
const mediaType = "application/json";
const json = (value: unknown) => `${canonicalJson(value)}\n`;
const resourceKey = (resource: LocalResource) => `${resource.id}:${resource.mediaType}`;
const invalid = (message: string) => new RepaFault("invalid_learning_record", message);

function reportResources(report: InputReport): ResourceRef[] {
  return report.kind === "reported" ? (report.sources ?? []).map(source => source.resource) : [];
}

export function attemptInputResources(fact: AttemptFactInput): ResourceRef[] {
  return [
    ...(fact.response.kind === "resource" ? [fact.response.resource] : []),
    ...fact.materials.map(snapshot => snapshot.resource),
    ...(fact.presentation ? [fact.presentation.resource] : []),
    ...reportResources(fact.initialConditions), ...reportResources(fact.assistance),
  ];
}

export function judgmentInputResources(input: JudgmentInput): ResourceRef[] {
  return [
    ...(input.method.execution ? [input.method.execution.resource] : []),
    ...input.basis.map(snapshot => snapshot.resource),
    ...(input.report ? [input.report.resource] : []),
  ];
}

function local(resource: ResourceRef): LocalResource {
  return { id: resource.id, mediaType: resource.mediaType };
}

function localSnapshot(snapshot: InputSnapshot): LocalSnapshot {
  return {
    resource: local(snapshot.resource),
    ...(snapshot.selector !== undefined ? { selector: snapshot.selector } : {}),
    ...(snapshot.source !== undefined ? { source: snapshot.source } : {}),
  };
}

function localReport(report: InputReport): AttemptFact["assistance"] {
  return report.kind === "unknown" ? { kind: "unknown" } : {
    kind: "reported", text: report.text,
    ...(report.sources !== undefined ? { sources: report.sources.map(localSnapshot) } : {}),
  };
}

function factValue(input: AttemptFactInput, recordedBy: CapabilitySource): AttemptFact {
  return {
    format: "repa.learning-attempt-fact", version: 1,
    actor: structuredClone(input.actor),
    response: input.response.kind === "text" ? { kind: "text", text: input.response.text }
      : { kind: "resource", resource: local(input.response.resource) },
    materials: input.materials.map(localSnapshot),
    ...(input.presentation !== undefined ? { presentation: localSnapshot(input.presentation) } : {}),
    initialConditions: localReport(input.initialConditions), assistance: localReport(input.assistance),
    ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {}),
    ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
    recordedAt: Date.now(), recordedBy,
  };
}

function judgmentValue(input: JudgmentInput, id: string, recordedBy: CapabilitySource): AttemptJudgment {
  return {
    format: "repa.learning-judgment", version: 1, id, factId: input.factId,
    method: {
      kind: input.method.kind, name: input.method.name, version: input.method.version,
      ...(input.method.execution !== undefined ? { execution: localSnapshot(input.method.execution) } : {}),
    },
    basis: input.basis.map(localSnapshot), conclusions: structuredClone(input.conclusions),
    ...(input.report !== undefined ? { report: localSnapshot(input.report) } : {}),
    ...(input.supersedes !== undefined ? { supersedes: structuredClone(input.supersedes) } : {}),
    recordedAt: Date.now(), recordedBy,
  };
}

function factResources(fact: AttemptFact): LocalResource[] {
  const reports = [fact.initialConditions, fact.assistance].flatMap(report =>
    report.kind === "reported" ? (report.sources ?? []).map(snapshot => snapshot.resource) : []);
  return [
    ...(fact.response.kind === "resource" ? [fact.response.resource] : []),
    ...fact.materials.map(snapshot => snapshot.resource),
    ...(fact.presentation ? [fact.presentation.resource] : []), ...reports,
  ];
}

function judgmentResources(judgment: AttemptJudgment): LocalResource[] {
  return [
    ...(judgment.method.execution ? [judgment.method.execution.resource] : []),
    ...judgment.basis.map(snapshot => snapshot.resource),
    ...(judgment.report ? [judgment.report.resource] : []),
  ];
}

function parse(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw invalid("学习作答记录不是有效的 UTF-8 JSON。");
    throw error;
  }
}

function lines(text: string): string[] {
  const result = text.split(/\r\n|\r|\n/u);
  if (/[\r\n]$/u.test(text)) result.pop();
  return result;
}

function addPatch(path: string, text: string): string {
  return ["*** Begin Patch", `*** Add File: ${path}`, ...lines(text).map(line => `+${line}`), "*** End Patch"].join("\n");
}

function replacePatch(path: string, before: string, after: string): string {
  if (/[\r\n]/u.test(path)) throw new RepaFault("invalid_input", "作答记录路径不能包含换行。");
  return ["*** Begin Patch", `*** Update File: ${path}`, "@@", ...lines(before).map(line => `-${line}`),
    ...lines(after).map(line => `+${line}`), "*** End of File", "*** End Patch"].join("\n");
}

interface LoadedAttempt {
  record: AttemptRecord;
  info: ContentInfo;
  bytes: Buffer;
  revision: string;
  view: AttemptView;
}

/** 原始作答与判断分别追加为不可变资源，采用记录只改变当前判断的投影。 */
export class LearningAttempts {
  constructor(readonly content: ContentStore) {}

  #ref(resource: LocalResource): ResourceRef {
    return { spaceId: this.content.options.spaceId, ...resource };
  }

  #source(source: CapabilitySource): CapabilitySource {
    if (!Check(CapabilitySourceSchema, source)) throw new RepaFault("invalid_input", "作答记录来源无效。");
    return structuredClone(source);
  }

  async #checkResources(scope: ContentPatchScope, resources: readonly ResourceRef[]): Promise<void> {
    for (const resource of resources) {
      if (resource.spaceId !== this.content.options.spaceId)
        throw new RepaFault("permission_required", "作答证据不属于当前空间。");
      if (!Check(LocalResourceSchema, local(resource))) throw new RepaFault("invalid_input", "作答证据资源标识无效。");
      await scope.readResource(resource);
    }
  }

  async #load(scope: ContentPatchScope, ref: ContentRef): Promise<LoadedAttempt> {
    if (!Check(ContentRefSchema, ref)) throw new RepaFault("invalid_input", "作答记录引用无效。");
    const { content: info, bytes } = await scope.read({ kind: "content", ref });
    if (info.status !== "available" || info.role !== "document" || info.location.kind !== "relative" ||
      info.fileType !== "file" || !info.bodyRevision || !info.revision || !bytes || !info.ref)
      throw invalid("作答记录必须是当前空间内可用的文档。");
    const record = parse(bytes);
    if (!Check(AttemptRecordSchema, record)) throw invalid("作答记录索引格式无效。");
    const verified = new Set<string>();
    const readResource = async (resource: LocalResource) => {
      const bytes = await scope.readResource(this.#ref(resource));
      verified.add(resource.id);
      return bytes;
    };
    const required = [record.fact, ...record.judgments.map(item => item.resource)];
    const fact = parse(await readResource(record.fact));
    if (!Check(AttemptFactSchema, fact)) throw invalid("原始作答事实格式无效。");
    required.push(...factResources(fact));
    const judgments: AttemptJudgment[] = [];
    const ids = new Set<string>();
    for (const item of record.judgments) {
      if (verified.has(item.resource.id)) throw invalid("事实与各判断必须指向不同的不可变资源。");
      const candidate = parse(await readResource(item.resource));
      if (!Check(AttemptJudgmentSchema, candidate) || candidate.id !== item.id || candidate.factId !== record.fact.id ||
        ids.has(item.id) || (candidate.supersedes !== undefined && !ids.has(candidate.supersedes.id)))
        throw invalid("判断必须唯一对应本次作答，替代关系只能引用此前判断。");
      ids.add(item.id);
      judgments.push(candidate);
      required.push(...judgmentResources(candidate));
    }
    let current: string | null = null;
    const selectionIds = new Set<string>();
    for (const selection of record.selections) {
      if (selectionIds.has(selection.id) || ids.has(selection.id) || selection.from !== current ||
        (selection.to !== null && !ids.has(selection.to)))
        throw invalid("判断采用记录的标识、目标或前后关系无效。");
      selectionIds.add(selection.id);
      current = selection.to;
    }
    const registered = new Set(info.resources.filter(resource => resource.spaceId === ref.spaceId).map(resourceKey));
    for (const resource of new Map(required.map(resource => [resourceKey(resource), resource])).values()) {
      if (!registered.has(resourceKey(resource))) throw invalid("作答记录缺少证据资源的持有关系。");
      if (!verified.has(resource.id)) await readResource(resource);
    }
    return { record, info, bytes, revision: info.revision, view: {
      ref: info.ref, base: info.bodyRevision, factId: record.fact.id, fact, judgments,
      selections: structuredClone(record.selections), current, resources: structuredClone(info.resources),
    } };
  }

  get(ref: ContentRef): Promise<AttemptView> {
    const input = structuredClone(ref);
    return this.content.observe(scope => this.#load({
      read: target => scope.readTarget(target),
      readResource: async resource => {
        if (resource.spaceId !== this.content.options.spaceId)
          throw new RepaFault("permission_required", "作答证据不属于当前空间。");
        return this.content.blobs.get(resource.id);
      },
    }, input).then(loaded => loaded.view));
  }

  record(params: RecordAttemptInput, source: CapabilitySource): Promise<ContentChangeResult> {
    if (!Check(RecordAttemptInputSchema, params)) throw new RepaFault("invalid_input", "原始作答输入无效。");
    const recordedBy = this.#source(source);
    return this.content.applyDerivedPatch({ operationId: params.operationId,
      request: { method: "repa.attempt.record", version: "1", input: params } }, async (request, scope) => {
      await this.#checkResources(scope, attemptInputResources(request.input.fact));
      const fact = factValue(request.input.fact, recordedBy);
      const bytes = Buffer.from(json(fact));
      const resource = { id: digest(bytes), mediaType };
      const id = digest(`repa.attempt:${request.input.operationId}`);
      const path = `learning/attempts/${id}.json`;
      const record: AttemptRecord = { format: "repa.learning-attempt", version: 1, fact: resource, judgments: [], selections: [] };
      const resources = [this.#ref(resource), ...attemptInputResources(request.input.fact)];
      return { resources: [bytes], patch: {
        patch: addPatch(path, json(record)),
        bases: [{ target: { kind: "file", spaceId: this.content.options.spaceId, location: { kind: "relative", path } }, base: { kind: "absent" } }],
        registrations: [{ path, role: "document", id, resources }],
      } };
    });
  }

  #update(loaded: LoadedAttempt, record: AttemptRecord, resources: readonly ResourceRef[], bytes: Uint8Array[] = []): DerivedContentPatch {
    const merged = [...new Map([...loaded.info.resources, ...resources].map(resource => [resourceKey(resource), resource])).values()];
    return { resources: bytes, patch: {
      patch: replacePatch(loaded.info.location.path, loaded.bytes.toString("utf8"), json(record)),
      bases: [{ target: { kind: "content", ref: loaded.view.ref }, base: loaded.view.base }],
      compositions: [{ ref: loaded.view.ref, base: loaded.revision, members: loaded.info.members, resources: merged }],
    } };
  }

  #checkIds(record: AttemptRecord, added: readonly string[]): void {
    const ids = new Set([...record.judgments, ...record.selections].map(item => item.id));
    for (const id of added) {
      if (ids.has(id)) throw new RepaFault("invalid_input", "新增判断或采用记录的标识已存在。");
      ids.add(id);
    }
  }

  #selection(method: string, operationId: string, from: string | null, to: string | null, reason: string, recordedBy: CapabilitySource): AttemptSelection {
    return { id: digest(`${method}:${operationId}`), from, to, reason, recordedAt: Date.now(), recordedBy };
  }

  saveJudgment(params: SaveJudgmentInput, source: CapabilitySource): Promise<ContentChangeResult> {
    if (!Check(SaveJudgmentInputSchema, params)) throw new RepaFault("invalid_input", "作答判断输入无效。");
    const recordedBy = this.#source(source);
    return this.content.applyDerivedPatch({ operationId: params.operationId,
      request: { method: "repa.attempt.judgment.save", version: "1", input: params } }, async (request, scope) => {
      const input = request.input;
      const loaded = await this.#load(scope, input.ref);
      if (input.base !== loaded.view.base) throw new RepaFault("revision_conflict", "作答记录正文已改变，请重新读取。");
      const supersedes = input.judgment.supersedes;
      if (input.judgment.factId !== loaded.record.fact.id || (supersedes !== undefined &&
        !loaded.record.judgments.some(item => item.id === supersedes.id)))
        throw new RepaFault("invalid_input", "判断事实或替代关系不属于本次作答。");
      await this.#checkResources(scope, judgmentInputResources(input.judgment));
      const id = digest(`repa.attempt.judgment.save:${input.operationId}`);
      const selection = input.adopt ? this.#selection("repa.attempt.judgment.save.adopt", input.operationId,
        loaded.view.current, id, input.adopt.reason, recordedBy) : undefined;
      this.#checkIds(loaded.record, [id, ...(selection ? [selection.id] : [])]);
      const candidate = judgmentValue(input.judgment, id, recordedBy);
      const bytes = Buffer.from(json(candidate));
      const resource = { id: digest(bytes), mediaType };
      const record = structuredClone(loaded.record);
      record.judgments.push({ id, resource });
      if (selection) record.selections.push(selection);
      return this.#update(loaded, record, [this.#ref(resource), ...judgmentInputResources(input.judgment)], [bytes]);
    });
  }

  selectJudgment(params: SelectJudgmentInput, source: CapabilitySource): Promise<ContentChangeResult> {
    if (!Check(SelectJudgmentInputSchema, params)) throw new RepaFault("invalid_input", "采用判断输入无效。");
    const recordedBy = this.#source(source);
    return this.content.applyDerivedPatch({ operationId: params.operationId,
      request: { method: "repa.attempt.judgment.select", version: "1", input: params } }, async (request, scope) => {
      const input = request.input;
      const loaded = await this.#load(scope, input.ref);
      if (input.base !== loaded.view.base) throw new RepaFault("revision_conflict", "作答记录正文已改变，请重新读取。");
      if (input.judgmentId !== null && !loaded.record.judgments.some(item => item.id === input.judgmentId))
        throw new RepaFault("invalid_input", "采用目标不属于本次作答。");
      const record = structuredClone(loaded.record);
      const selection = this.#selection("repa.attempt.judgment.select", input.operationId,
        loaded.view.current, input.judgmentId, input.reason, recordedBy);
      this.#checkIds(record, [selection.id]);
      record.selections.push(selection);
      return this.#update(loaded, record, []);
    });
  }
}
