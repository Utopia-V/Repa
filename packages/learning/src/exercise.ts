import { isDeepStrictEqual } from "node:util";
import { Check } from "typebox/value";
import type { CapabilityDefinition, RepaCapabilityServices } from "repa/plugin";
import {
  ContentChangeResultSchema, ProcessDisplayResultInputSchema, RepaFault,
  type ResourceRef,
} from "repa/protocol";
import type { AttemptFactInput } from "./attempt-schema.js";
import { LearningAttempts } from "./attempts.js";
import { ExerciseInitialSchema, ExerciseSubmissionSchema } from "./exercise-schema.js";

const resourceKey = (resource: ResourceRef) => `${resource.spaceId}:${resource.id}:${resource.mediaType}`;
const uniqueResources = (resources: readonly ResourceRef[]) => [...new Map(resources.map(resource => [resourceKey(resource), resource])).values()];

/** 将已获授权展示的一次文本提交保存为事实，不把页面报告当作独立观察。 */
export function createExerciseCapability(): CapabilityDefinition<typeof ProcessDisplayResultInputSchema, typeof ContentChangeResultSchema, RepaCapabilityServices> {
  return {
    contract: { id: "repa.attempt.record-display", version: "1" }, implementationId: "official",
    inputSchema: ProcessDisplayResultInputSchema, outputSchema: ContentChangeResultSchema, scopes: ["space"], execution: "inline",
    inputResources: input => uniqueResources([
      ...input.result.resources, input.result.value.data.artifact.value.resource, ...input.result.value.data.artifact.resources,
    ]),
    outputResources: output => uniqueResources(output.contents.flatMap(content => content.resources)),
    async invoke(input, context) {
      if (context.source.kind !== "display" || context.scope.kind !== "space" || !context.content ||
        context.source.spaceId !== context.scope.spaceId ||
        !isDeepStrictEqual(input.result.value.data.source, context.source))
        throw new RepaFault("permission_required", "学习页面作答需要真实展示来源与所属空间。");
      const result = input.result;
      const initial = result.value.data.initialData;
      const submission = result.value.data.input;
      if (!Check(ExerciseInitialSchema, initial) || !Check(ExerciseSubmissionSchema, submission))
        throw new RepaFault("invalid_input", "学习页面的初始化参数或提交格式无效。");
      const artifact = result.value.data.artifact;
      const dependencies = uniqueResources([artifact.value.resource, ...artifact.resources]);
      for (const resource of [...dependencies, ...result.resources]) {
        if (resource.spaceId !== context.scope.spaceId)
          throw new RepaFault("permission_required", "学习页面证据不属于当前展示空间。");
      }
      const materials = initial.materials.map(descriptor => {
        const resource = dependencies.find(resource => resource.id === descriptor.resourceId);
        if (!resource) throw new RepaFault("permission_required", "题面资源不在当前展示的固定资源中。");
        return {
          resource: structuredClone(resource),
          ...(descriptor.selector !== undefined ? { selector: descriptor.selector } : {}),
          ...(descriptor.source !== undefined ? { source: descriptor.source } : {}),
        };
      });
      const resources = context.services?.resources;
      if (!resources) throw new RepaFault("capability_service_unavailable", "学习页面作答缺少资源保存服务。");
      const raw = await resources.create(new TextEncoder().encode(`${JSON.stringify(result)}\n`), "application/json");
      const fact: AttemptFactInput = {
        actor: structuredClone(initial.actor),
        response: { kind: "text", text: submission.response },
        materials,
        presentation: { resource: raw, resources: dependencies },
        initialConditions: {
          kind: "reported", text: "本次展示实例的初始化参数",
          sources: [{ resource: raw, selector: "/value/data/initialData" }],
        },
        assistance: submission.assistance.kind === "unknown" ? { kind: "unknown" } : {
          kind: "reported", text: submission.assistance.text,
          sources: [{ resource: raw, selector: "/value/data/input/assistance" }],
        },
        provenance: "原展示结果保存初始化参数与页面提交；页面帮助信息是报告，不是后端独立观察到的显示或使用。",
      };
      return new LearningAttempts(context.content).record({ operationId: input.operationId, fact }, context.source);
    },
  };
}
