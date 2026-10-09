import type { DisplayArtifact, DisplayResult } from "./schema.js";

/** 在当前空间解释固定展示结果的标准引用；原来源与页面参数仍属于历史记录。 */
export function displayResultArtifact(result: DisplayResult, spaceId: string): DisplayArtifact {
  const artifact = structuredClone(result.value.data.artifact);
  const origin = result.value.data.source.spaceId;
  for (const source of artifact.sources) {
    if (source.target.kind === "content" && source.target.ref.spaceId === origin) source.target.ref.spaceId = spaceId;
    else if (source.target.kind === "file" && source.target.spaceId === origin) source.target.spaceId = spaceId;
  }
  for (const resource of [artifact.value.resource, ...artifact.resources])
    if (resource.spaceId === origin) resource.spaceId = spaceId;
  return artifact;
}
