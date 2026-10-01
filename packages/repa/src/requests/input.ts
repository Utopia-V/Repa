import type { ImageContent } from "@earendil-works/pi-ai";
import type { ContentStore } from "../content/store.js";
import type { ResourceRef } from "../content/schema.js";
import type { Input } from "./schema.js";

export interface PreparedInput { text: string; images: ImageContent[] }

export function inputText(input: Input): string {
  return input.parts.map(part => {
    if ("text" in part) return part.text;
    if (part.kind === "resource") return part.description ?? part.resource.mediaType;
    if (part.kind === "data") return part.representation.summary ?? part.representation.format.id;
    return JSON.stringify(part.target);
  }).join("\n\n");
}

export function inputResources(input: Input): ResourceRef[] {
  return input.parts.flatMap(part => {
    if (part.kind === "resource") return [part.resource];
    if (part.kind !== "data") return [];
    return [...part.representation.resources, ...(part.representation.value.kind === "resource" ? [part.representation.value.resource] : [])];
  });
}

/** 草稿采用提交的文字；引用在实际开始时读取，沿用内容模块的授权和修订。 */
export async function prepareInput(input: Input, content: ContentStore, requestId: string): Promise<PreparedInput> {
  const owner = `request:${requestId}`;
  const texts: string[] = [];
  const images: ImageContent[] = [];
  const resources = inputResources(input);
  const addResource = async (resource: ResourceRef) => {
    if (resource.mediaType.startsWith("image/")) images.push({
      type: "image", mimeType: resource.mediaType, data: (await content.blobs.get(resource.id)).toString("base64"),
    });
    else texts.push(`资源：${JSON.stringify(resource)}`);
  };
  for (const part of input.parts) {
    if (part.kind === "text") texts.push(part.text);
    else if (part.kind === "selection") {
      texts.push(`草稿选区（提交时文字）：\n${part.text}\n来源：${JSON.stringify(part.source)}`);
    } else if (part.kind === "resource") {
      if (part.description) texts.push(part.description);
      await addResource(part.resource);
    } else if (part.kind === "data") {
      texts.push(`提交的表示：${JSON.stringify(part.representation)}`);
      if (part.representation.value.kind === "resource") await addResource(part.representation.value.resource);
    } else {
      const result = await content.read({ target: part.target }, requestId);
      texts.push(`引用：${JSON.stringify({ target: part.target, revision: result.content.revision, locator: part.locator })}`);
      if (result.text !== undefined) texts.push(result.text);
      if (result.truncated) texts.push("以上为内容入口返回的片段，后续内容需按需读取。");
      if (result.resource) {
        resources.push(result.resource);
        await addResource(result.resource);
      }
    }
  }
  content.retention.retain(owner, resources);
  return { text: texts.join("\n\n"), images };
}
