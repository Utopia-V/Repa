import { isDeepStrictEqual } from "node:util";
import { Check } from "typebox/value";
import { displayResultArtifact, type CapabilityDefinition, type RepaCapabilityServices } from "repa/plugin";
import { ContentRefSchema, DisplayResultSchema, RepaFault, object, type DisplayResult, type ResourceRef } from "repa/protocol";
import { AttemptFactSchema, type AttemptFact, type LocalResource } from "./attempt-schema.js";
import { LearningAttempts, factResources } from "./attempts.js";
import {
  ExerciseDisplayResultSchema, ExerciseInitialV2Schema, ExerciseSubmissionSchema,
  type ExerciseInitialV2,
} from "./exercise-schema.js";

const unsupported = (message: string) => new RepaFault("unsupported_format", message);
const key = (resource: LocalResource) => `${resource.id}:${resource.mediaType}`;
const localResource = ({ id, mediaType }: LocalResource): LocalResource => ({ id, mediaType });

/** 明确事实字段的资源闭包；不引入候选判断，也不扫描业务 JSON。 */
function exerciseFactResources(fact: AttemptFact, factId: string): LocalResource[] {
  const resources = [{ id: factId, mediaType: "application/json" }, ...factResources(fact)];
  return [...new Map(resources.map(resource => [key(resource), localResource(resource)])).values()];
}

function parseExerciseBytes(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError) throw unsupported("作答恢复依据不是有效的 UTF-8 JSON。");
    throw error;
  }
}

// 这是 v2 事实投影的持久值，调整时须解释已有记录，不能按普通界面文案替换。
export function exerciseInitialConditionsText(continuing: boolean): string {
  return continuing
    ? "本次展示实例初始化提供了此前回答与帮助报告；这不是独立首答，也不证明页面实际显示。"
    : "本次展示实例的初始化参数";
}

/** 原表示只提供可核对的历史声明，录入来源可以与显示来源不同。 */
function validateExercisePresentation(fact: AttemptFact, raw: unknown, spaceId: string) {
  if (!Check(DisplayResultSchema, raw)) throw unsupported("原作答呈现不是展示结果。");
  const initial = raw.value.data.initialData;
  const submission = raw.value.data.input;
  if (!Check(ExerciseInitialV2Schema, initial) || !Check(ExerciseSubmissionSchema, submission))
    throw unsupported("原组件没有提供 v2 作答恢复格式。");
  const presentation = fact.presentation;
  if (!presentation || presentation.resource.mediaType !== "application/json")
    throw unsupported("原作答缺少固定 JSON 呈现依据。");
  const initialConditions = {
    kind: "reported", text: exerciseInitialConditionsText(initial.previous !== undefined),
    sources: [{ resource: presentation.resource, selector: "/value/data/initialData" }],
  };
  const assistanceSources = [{ resource: presentation.resource, selector: "/value/data/input/assistance" }];
  // 此恢复格式只支持完整的 exercise 投影；导入者可以不同，但条件与报告依据不能替换。
  if (!isDeepStrictEqual(fact.initialConditions, initialConditions) ||
    (fact.assistance.kind === "reported" && !isDeepStrictEqual(fact.assistance.sources, assistanceSources)))
    throw unsupported("原事实的初始条件或帮助报告没有绑定本次固定呈现。");
  const artifact = displayResultArtifact(raw, spaceId);
  const dependencies = [artifact.value.resource, ...artifact.resources];
  if (dependencies.some(resource => resource.spaceId !== spaceId))
    throw new RepaFault("permission_required", "原作答呈现包含不属于当前空间的资源。");
  if (artifact.value.resource.mediaType !== "text/html") throw unsupported("原作答呈现缺少 HTML。");
  const held = new Set((fact.presentation?.resources ?? []).map(key));
  if (dependencies.some(resource => !held.has(key(resource))))
    throw unsupported("原作答呈现缺少明确的附属资源闭包。");
  const materials = initial.materials.map(descriptor => {
    const resource = dependencies.find(resource => resource.id === descriptor.resourceId);
    if (!resource) throw unsupported("原作答题面不属于固定呈现资源。");
    return {
      resource: localResource(resource),
      ...(descriptor.selector !== undefined ? { selector: descriptor.selector } : {}),
      ...(descriptor.source !== undefined ? { source: descriptor.source } : {}),
    };
  });
  if (!isDeepStrictEqual(fact.actor, initial.actor) ||
    !isDeepStrictEqual(fact.response, { kind: "text", text: submission.response }) ||
    !isDeepStrictEqual(fact.materials, materials) || fact.assistance.kind !== submission.assistance.kind ||
    (fact.assistance.kind === "reported" && submission.assistance.kind === "reported" && fact.assistance.text !== submission.assistance.text))
    throw unsupported("原事实与呈现中的回答、帮助、产生者或题面不一致。");
  return { raw, initial, submission, artifact };
}

export async function validatePreviousExercise(initial: ExerciseInitialV2, artifact: DisplayResult["value"]["data"]["artifact"],
  services: NonNullable<RepaCapabilityServices["resources"]>, spaceId: string): Promise<void> {
  const previous = initial.previous;
  if (!previous) return;
  const allowed = new Set([artifact.value.resource, ...artifact.resources].map(key));
  const read = async (resource: LocalResource) => {
    if (!allowed.has(key(resource))) throw new RepaFault("permission_required", "前次作答依据不在当前展示资源中。");
    return services.read({ spaceId, ...resource });
  };
  const fact = parseExerciseBytes(await read(previous.fact));
  if (!Check(AttemptFactSchema, fact) || !fact.presentation ||
    !isDeepStrictEqual(fact.presentation.resource, previous.presentation))
    throw unsupported("前次事实与呈现引用不一致。");
  const raw = parseExerciseBytes(await read(previous.presentation));
  const saved = validateExercisePresentation(fact, raw, spaceId);
  if (!isDeepStrictEqual(previous.submission, saved.submission) ||
    !isDeepStrictEqual(initial.actor, saved.initial.actor) || !isDeepStrictEqual(initial.materials, saved.initial.materials) ||
    !isDeepStrictEqual(initial.data, saved.initial.data) ||
    !isDeepStrictEqual(localResource(artifact.value.resource), localResource(saved.artifact.value.resource)))
    throw unsupported("继续作答的原回答、条件或组件与前件不一致。");
  for (const resource of exerciseFactResources(fact, previous.fact.id)) await read(resource);
}

const inputSchema = object({ ref: ContentRefSchema });
export function createExerciseRestoreCapability(): CapabilityDefinition<typeof inputSchema, typeof ExerciseDisplayResultSchema, RepaCapabilityServices> {
  return {
    contract: { id: "repa.attempt.display", version: "1" }, implementationId: "official",
    inputSchema, outputSchema: ExerciseDisplayResultSchema, scopes: ["space"], execution: "inline",
    outputResources: output => [output.source.artifact.value.resource, ...output.source.artifact.resources],
    async invoke(input, context) {
      if (context.scope.kind !== "space" || !context.content)
        throw new RepaFault("capability_scope", "恢复作答需要所属学习空间。");
      const spaceId = context.scope.spaceId;
      const services = context.services?.resources;
      if (!services) throw new RepaFault("capability_service_unavailable", "恢复作答缺少资源读取服务。");
      const view = await new LearningAttempts(context.content).get(input.ref);
      const presentation = view.fact.presentation;
      if (!presentation || presentation.resource.mediaType !== "application/json") throw unsupported("作答没有可恢复的页面呈现。");
      const raw = parseExerciseBytes(await services.read({ spaceId, ...presentation.resource }));
      const saved = validateExercisePresentation(view.fact, raw, spaceId);
      if (saved.initial.previous) await validatePreviousExercise(saved.initial, saved.artifact, services, spaceId);
      const closure = exerciseFactResources(view.fact, view.factId).map(resource => ({ spaceId, ...resource }));
      const held = new Set(view.resources.map(key));
      if (closure.some(resource => !held.has(key(resource)))) throw unsupported("作答恢复缺少已登记依据。");
      services.retain(closure);
      const initialData: ExerciseInitialV2 = {
        format: { id: "repa.learning-response", version: "2" }, actor: structuredClone(saved.initial.actor),
        materials: structuredClone(saved.initial.materials), data: structuredClone(saved.initial.data),
        previous: { fact: { id: view.factId, mediaType: "application/json" },
          presentation: { id: presentation.resource.id, mediaType: "application/json" }, submission: structuredClone(saved.submission) },
      };
      const resources: ResourceRef[] = [...new Map([...saved.artifact.resources, ...closure].map(resource => [key(resource), resource])).values()];
      return { source: { kind: "artifact", artifact: { ...saved.artifact, resources }, initialData } };
    },
  };
}
