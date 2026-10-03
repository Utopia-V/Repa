import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { Check } from "typebox/value";
import { Type } from "typebox";
import { IdSchema, object } from "./schema.js";
import type { RepaClient } from "./client.js";
import type { DisplayInstance } from "./display/schema.js";

export { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
export { SAVE_NEW_RESULT, SUBMIT_RESULT } from "./display/schema.js";
export type { DisplayArtifact, DisplayInstance } from "./display/schema.js";

const ActionArgumentsSchema = object({ requestId: IdSchema, input: Type.Unknown() });
const resourceUri = (instance: DisplayInstance, id: string) => `repa://display/${instance.instanceId}/resources/${id}`;

/** 只登记实例已经绑定的通道；页面不取得 RepaClient，也不自动转发其他 MCP 方法。 */
export function createDisplayBridge(client: RepaClient, instance: DisplayInstance): AppBridge {
  const view = structuredClone(instance);
  const key = { spaceId: view.spaceId, instanceId: view.instanceId };
  const bridge = new AppBridge(null, { name: "Repa", version: "1.0.0" }, { serverTools: {}, serverResources: {} });
  bridge.oncalltool = async params => {
    const action = view.actions.find(action => action.name === params.name);
    if (!action) throw new Error("当前展示没有该动作。");
    if (!Check(ActionArgumentsSchema, params.arguments)) throw new Error("动作需要一次请求的标识和明确结果参数。");
    const request = await client.call("display.invoke", {
      ...key, requestId: params.arguments.requestId, action: action.name, input: params.arguments.input,
    });
    const receipt = { requestId: request.requestId, status: request.status };
    return { content: [{ type: "text", text: JSON.stringify(receipt) }], structuredContent: receipt };
  };
  bridge.addEventListener("initialized", () => {
    // SDK 初始化完成后再交付参数和动作说明，宿主连接与完整实例留在外层。
    bridge.sendToolInput({ arguments: {
      initialData: view.initialData ?? null,
      actions: view.actions,
    } }).catch(error => bridge.onerror?.(error instanceof Error ? error : new Error(String(error))));
  });
  bridge.onlistresources = async () => ({ resources: view.hold.resources.map(resource => ({
    uri: resourceUri(view, resource.id), name: resource.id, mimeType: resource.mediaType,
  })) });
  bridge.onreadresource = async params => {
    const resource = view.hold.resources.find(ref => resourceUri(view, ref.id) === params.uri);
    if (!resource) throw new Error("资源不属于当前展示。");
    const result = await client.call("display.readResource", { ...key, resourceId: resource.id });
    return { contents: [{ uri: params.uri, mimeType: result.resource.mediaType, blob: result.base64 }] };
  };
  return bridge;
}
