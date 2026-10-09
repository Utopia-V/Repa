import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Check } from "typebox/value";
import type { ContentStore } from "../content/store.js";
import type { BackgroundRequests, ProcessingContext } from "../requests/background.js";
import type { BackgroundRequest, ProcessingResult, RequestRecord, Submit } from "../requests/schema.js";
import type { CapabilitySelection } from "../capabilities/schema.js";
import type { ResourceRef } from "../content/schema.js";
import { capabilityRepresentation } from "../capabilities/resources.js";
import { RepaFault } from "../errors.js";
import {
  DisplayOpenSchema, DisplayResultSchema, SAVE_NEW_RESULT, SUBMIT_RESULT, PROCESS_RESULT,
  type DisplayOpen, type DisplayInstance, type DisplayParams, type DisplayResult, type ProcessDisplayResultInput,
} from "./schema.js";

interface InstanceRecord {
  hostId: string;
  input: DisplayOpen;
  view: DisplayInstance;
  pending: AbortController;
  processor?: CapabilitySelection;
}
interface DisplaySpace {
  content: ContentStore;
  processing: BackgroundRequests;
  request(requestId: string): RequestRecord | undefined;
  assertRequestAvailable(requestId: string): void;
}

/** 只持有展示实例的临时动作授权；字节、持久请求与保存仍由原 owner 承担。 */
export class DisplayService {
  readonly #instances = new Map<string, InstanceRecord>();
  readonly #opening = new Map<string, Promise<DisplayInstance>>();
  readonly #hostEpochs = new Map<string, number>();

  constructor(readonly options: {
    space(spaceId: string): DisplaySpace;
    hostActive(hostId: string): boolean;
    submit(input: Submit, source: DisplayResult["value"]["data"]["source"], signal: AbortSignal): Promise<RequestRecord>;
    bindProcess(spaceId: string, selection: CapabilitySelection): Promise<CapabilitySelection>;
    prepareProcess(input: ProcessDisplayResultInput & { selection: CapabilitySelection }, signal: AbortSignal): Promise<{
      selection: CapabilitySelection;
      pluginId: string;
      inputResources: readonly ResourceRef[];
      execute(context: ProcessingContext): Promise<ProcessingResult>;
    }>;
  }) {}

  #key(spaceId: string, instanceId: string): string { return `${spaceId}/${instanceId}`; }

  #assertHost(hostId: string): void {
    if (!this.options.hostActive(hostId)) throw new RepaFault("display_closed", "展示宿主已经断开，请重新打开实例。");
  }

  async open(input: DisplayOpen, hostId: string): Promise<DisplayInstance> {
    this.#assertHost(hostId);
    const params = structuredClone(input);
    if (!Check(DisplayOpenSchema, params)) throw new RepaFault("invalid_input", "展示输入无效。");
    const key = this.#key(params.spaceId, params.instanceId);
    const pending = this.#opening.get(key);
    if (pending) await pending;
    const previous = this.#instances.get(key);
    if (previous) {
      if (previous.hostId !== hostId) throw new RepaFault("permission_required", "展示实例不属于当前宿主。");
      if (!isDeepStrictEqual(previous.input, params)) throw new RepaFault("request_id_conflict", "展示实例标识已经绑定另一份输入或动作。");
      return this.get(params, hostId);
    }
    const epoch = this.#hostEpochs.get(hostId) ?? 0;
    const content = this.options.space(params.spaceId).content;
    if (params.saveNewResult) {
      const relative = path.relative(content.options.root, path.resolve(content.options.root, params.saveNewResult.path));
      if (!relative || params.saveNewResult.path !== params.saveNewResult.path.trim() || path.isAbsolute(params.saveNewResult.path) || relative === ".." || relative.startsWith(`..${path.sep}`))
        throw new RepaFault("permission_required", "新结果文档必须保存在当前空间内的绑定位置。");
    }
    const holdId = randomUUID();
    const opening = (async () => {
      try {
        const processor = params.processResult
          ? await this.options.bindProcess(params.spaceId, params.processResult.selection) : undefined;
        if (params.saveNewResult) {
          const destination = await content.inspect({ kind: "file", spaceId: params.spaceId,
            location: { kind: "relative", path: params.saveNewResult.path } });
          if (destination.status !== "missing")
            throw new RepaFault("revision_conflict", "新结果文档的绑定位置必须不存在。");
        }
        const hold = await content.hold({ id: holdId,
          ...(params.source.kind === "content" ? { targets: [params.source.target] }
            : { resources: [params.source.artifact.value.resource, ...params.source.artifact.resources] }),
        }, hostId);
        this.#assertHost(hostId);
        if ((this.#hostEpochs.get(hostId) ?? 0) !== epoch) throw new RepaFault("display_closed", "原展示宿主已经结束，请重新打开实例。");
        const snapshot = hold.contents[0];
        let initialData = params.source.kind === "artifact" ? params.source.initialData : undefined;
        const artifact = params.source.kind === "artifact" ? params.source.artifact : await (async () => {
          if (!snapshot?.resource || !snapshot.content.bodyRevision)
            throw new RepaFault("unsupported_format", "展示需要可保留的 HTML 文件版本。");
          if (snapshot.resource.mediaType === "application/json") {
            const raw: unknown = JSON.parse((await content.blobs.get(snapshot.resource.id)).toString("utf8"));
            if (!Check(DisplayResultSchema, raw)) throw new RepaFault("unsupported_format", "该 JSON 不是已保存的展示结果。");
            initialData = raw.value.data.input;
            const saved = structuredClone(raw.value.data.artifact);
            const origin = raw.value.data.source.spaceId;
            // 格式 owner 解释副本中的标准引用，保存的字节版本和页面参数不换成当前输入。
            for (const source of saved.sources) {
              if (source.target.kind === "content" && source.target.ref.spaceId === origin) source.target.ref.spaceId = params.spaceId;
              else if (source.target.kind === "file" && source.target.spaceId === origin) source.target.spaceId = params.spaceId;
            }
            for (const ref of [saved.value.resource, ...saved.resources]) if (ref.spaceId === origin) ref.spaceId = params.spaceId;
            return saved;
          }
          return {
            format: { id: "repa.display-html" as const, version: "1" as const },
            value: { kind: "resource" as const, resource: snapshot.resource },
            sources: [{ target: snapshot.target, revision: snapshot.content.bodyRevision }],
            resources: hold.resources,
          };
        })();
        for (const ref of [artifact.value.resource, ...artifact.resources]) {
          if (ref.spaceId !== params.spaceId || !hold.resources.some(held => held.id === ref.id))
            throw new RepaFault("permission_required", "保存表示使用的资源不在当前内容的持有范围内。");
        }
        if (artifact.value.resource.mediaType !== "text/html")
          throw new RepaFault("unsupported_format", "当前展示入口只支持 HTML 表示。");
        const actions: DisplayInstance["actions"] = [];
        if (params.saveNewResult) actions.push({ name: SAVE_NEW_RESULT, inputSchema: params.saveNewResult.inputSchema });
        if (params.submitResult) actions.push({ name: SUBMIT_RESULT, inputSchema: params.submitResult.inputSchema });
        if (params.processResult) actions.push({ name: PROCESS_RESULT, inputSchema: params.processResult.inputSchema });
        const view: DisplayInstance = { spaceId: params.spaceId, instanceId: params.instanceId, artifact, hold, actions,
          ...(initialData !== undefined ? { initialData } : {}),
        };
        this.#instances.set(key, { hostId, input: params, view: structuredClone(view), pending: new AbortController(),
          ...(processor ? { processor } : {}),
        });
        return structuredClone(view);
      } catch (error) {
        content.retention.release(hostId, holdId);
        throw error;
      }
    })();
    this.#opening.set(key, opening);
    try { return await opening; } finally { this.#opening.delete(key); }
  }

  #record(key: { spaceId: string; instanceId: string }, hostId: string): InstanceRecord {
    this.#assertHost(hostId);
    const record = this.#instances.get(this.#key(key.spaceId, key.instanceId));
    if (!record) throw new RepaFault("display_closed", "展示实例已经关闭或失效，请重新取得版本并打开。");
    if (record.hostId !== hostId) throw new RepaFault("permission_required", "展示实例不属于当前宿主。");
    this.options.space(key.spaceId).content.retention.get(hostId, record.view.hold.id);
    return record;
  }

  get(key: { spaceId: string; instanceId: string }, hostId: string): DisplayInstance {
    const record = this.#record(key, hostId);
    const hold = this.options.space(key.spaceId).content.retention.renew(hostId, record.view.hold.id);
    return structuredClone({ ...record.view, hold });
  }

  async close(key: { spaceId: string; instanceId: string }, hostId: string): Promise<void> {
    await this.#opening.get(this.#key(key.spaceId, key.instanceId))?.catch(() => {});
    const record = this.#instances.get(this.#key(key.spaceId, key.instanceId));
    if (!record) return;
    if (record.hostId !== hostId) throw new RepaFault("permission_required", "展示实例不属于当前宿主。");
    record.pending.abort();
    this.options.space(key.spaceId).content.retention.release(hostId, record.view.hold.id);
    this.#instances.delete(this.#key(key.spaceId, key.instanceId));
  }

  detach(hostId: string): void {
    this.#hostEpochs.set(hostId, (this.#hostEpochs.get(hostId) ?? 0) + 1);
    for (const [key, record] of this.#instances) if (record.hostId === hostId) {
      record.pending.abort();
      this.#instances.delete(key);
    }
    // 未确认离开的 hold 由已有 TTL 保留；确认关闭则由 Application.releaseHost 统一释放。
  }

  dispose(): void {
    for (const record of this.#instances.values()) record.pending.abort();
    this.#instances.clear();
    this.#hostEpochs.clear();
  }

  async readResource(input: DisplayParams<"display.readResource">, hostId: string) {
    const content = this.options.space(input.spaceId).content;
    return content.queue.run(async () => {
      const record = this.#record(input, hostId);
      const resource = record.view.hold.resources.find(ref => ref.id === input.resourceId);
      if (!resource) throw new RepaFault("permission_required", "资源不在当前展示实例的持有范围内。");
      return { resource: structuredClone(resource), base64: (await content.blobs.get(resource.id)).toString("base64") };
    });
  }

  async invoke(input: DisplayParams<"display.invoke">, hostId: string): Promise<BackgroundRequest | RequestRecord> {
    this.#assertHost(hostId);
    const params = structuredClone(input);
    const space = this.options.space(params.spaceId);
    const { requestId, ...options } = params;
    const submitted = space.request(requestId);
    if (submitted) {
      const data = submitted.input.parts.find(part => part.kind === "data");
      if (params.action !== SUBMIT_RESULT || submitted.source.kind !== "display" ||
          submitted.source.hostId !== hostId || submitted.source.instanceId !== params.instanceId ||
          submitted.source.spaceId !== params.spaceId || data?.kind !== "data" ||
          !Check(DisplayResultSchema, data.representation) || !isDeepStrictEqual(data.representation.value.data.input, params.input))
        throw new RepaFault("request_id_conflict", "相同请求标识已经用于另一项展示操作。");
      return structuredClone(submitted);
    }
    const previous = space.processing.requests.get(requestId);
    if (previous) {
      const configuration = previous.configuration;
      const expectedOperation = params.action === PROCESS_RESULT ? "repa.display.process-result" : "repa.display.save-result";
      if (previous.operation !== expectedOperation || !isDeepStrictEqual(previous.options, options) ||
          configuration === null || typeof configuration !== "object" || !("hostId" in configuration) || configuration.hostId !== hostId)
        throw new RepaFault("request_id_conflict", "相同请求标识已经用于另一项展示操作。");
      return structuredClone(previous);
    }
    space.assertRequestAvailable(requestId);
    const record = this.#record(params, hostId);
    const action = {
      [SAVE_NEW_RESULT]: record.input.saveNewResult,
      [SUBMIT_RESULT]: record.input.submitResult,
      [PROCESS_RESULT]: record.input.processResult,
    }[params.action];
    if (!action) throw new RepaFault("permission_required", "当前展示没有获准的动作。");
    if (!Check(action.inputSchema, params.input)) throw new RepaFault("invalid_input", "结果参数不符合绑定的 schema。");
    const artifact = structuredClone(record.view.artifact);
    const source = { kind: "display" as const, hostId, spaceId: params.spaceId, instanceId: params.instanceId };
    const representation: DisplayResult = {
      format: { id: "repa.display-result", version: "1" },
      value: { kind: "inline", data: {
        source, artifact, input: params.input,
        ...(record.view.initialData !== undefined ? { initialData: structuredClone(record.view.initialData) } : {}),
      } },
      sources: artifact.sources, resources: [artifact.value.resource, ...artifact.resources],
    };
    if ("sessionId" in action) {
      // 实例只取消尚未受理的投递；受理后由 Request 持有输入、运行和资源。
      return this.options.submit({
        target: { spaceId: params.spaceId, sessionId: action.sessionId }, requestId,
        input: { parts: [{ kind: "text", text: action.instruction }, { kind: "data", representation }] },
        dispatch: { kind: "queue" },
      }, source, record.pending.signal);
    }
    if ("selection" in action) {
      if (!record.processor) throw new RepaFault("permission_required", "当前展示没有绑定处理能力。");
      const prepared = await this.options.prepareProcess({ operationId: requestId, result: representation,
        selection: record.processor }, record.pending.signal);
      if (record.pending.signal.aborted) throw new RepaFault("display_closed", "展示实例已经结束，处理请求尚未受理。");
      this.#record(params, hostId);
      space.assertRequestAvailable(requestId);
      for (const ref of prepared.inputResources) {
        if (ref.spaceId !== params.spaceId || !record.view.hold.resources.some(held => held.id === ref.id))
          throw new RepaFault("permission_required", "处理能力的输入资源超出当前展示实例。");
      }
      const submitted = capabilityRepresentation(prepared.selection.contract,
        { operationId: requestId, result: representation }, [...representation.resources, ...prepared.inputResources]);
      return space.processing.submit({ requestId, operation: "repa.display.process-result",
        input: { parts: [{ kind: "data", representation: submitted }] }, options,
        configuration: { hostId, source, operationId: requestId, ...prepared.selection, pluginId: prepared.pluginId },
      }, (_input, context) => prepared.execute(context));
    }
    // 受理先由请求 owner 接续资源，关闭展示不取消已明确发起的保存。
    return space.processing.submit({ requestId, operation: "repa.display.save-result",
      input: { parts: [{ kind: "data", representation }] }, options, configuration: { hostId, source, path: action.path },
    }, async () => {
      const text = `${JSON.stringify(representation, null, 2)}\n`;
      const result = await space.content.applyPatch({ operationId: requestId,
        patch: `*** Begin Patch\n*** Add File: ${action.path}\n${text.split("\n").slice(0, -1).map(line => `+${line}`).join("\n")}\n*** End Patch`,
        registrations: [{ path: action.path, role: "document", resources: representation.resources }],
      });
      return { format: { id: "repa.display-save-result", version: "1" },
        value: { kind: "inline", data: { source, result } }, sources: artifact.sources, resources: representation.resources };
    });
  }
}
