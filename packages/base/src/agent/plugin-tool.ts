import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PluginRequestOrigin, PluginRequestRoute } from "../agent.js";
import { RepaFault } from "../schema.js";

/** 通用 Agent 的插件装卸工具名，插件工具不能使用。 */
export const PLUGIN_TOOL = "plugin";

const id = Type.String({ pattern: "^[a-z][a-z0-9-]*$" });

/**
 * 通用 Agent 的 plugin 工具：list 当场列出插件；load、unload 只记下请求，本次运行结束后由装配处理，结果之后交回会话。
 * origin 给出当前运行；运行之外调用时为 undefined。
 */
export function pluginTool(route: PluginRequestRoute, origin: () => PluginRequestOrigin | undefined): ToolDefinition {
  return defineTool({
    name: PLUGIN_TOOL,
    label: PLUGIN_TOOL,
    description: [
      "管理这个空间的自写插件。插件文件夹放在 .agents/plugins/<id>/，文件夹名就是插件 id。",
      "list：列出插件、运行状态、源文件夹相对已记录版本的状态，以及最近一次装卸请求的阶段或结局。",
      "load：请求启用插件，或让文件夹当前的内容生效；from 为 recorded 时让记录里的版本重新生效，为 previous 时让上一次选定的版本重新生效。",
      "unload：请求卸载。",
      "load 与 unload 只记下请求，本次运行结束后处理，通常要使用者批准；处理完以后结果会交回这个会话，新插件的工具从下一次运行起可用。",
    ].join("\n"),
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("load"), Type.Literal("unload")]),
      ids: Type.Optional(Type.Array(id, { minItems: 1, maxItems: 32 })),
      from: Type.Optional(Type.Union([Type.Literal("folder"), Type.Literal("recorded"), Type.Literal("previous")])),
    }, { additionalProperties: false }),
    async execute(_callId, input) {
      if (input.action === "list") return { content: [{ type: "text" as const, text: await route.list() }], details: undefined };
      if (input.ids === undefined) throw new RepaFault("invalid_input", "load 与 unload 要给出 ids");
      if (input.action === "unload" && input.from !== undefined) throw new RepaFault("invalid_input", "unload 不接受 from");
      const current = origin();
      if (current === undefined) throw new RepaFault("run_not_active", "只能在运行中提出装卸");
      const text = route.request({ action: input.action, ids: input.ids, ...(input.from === undefined ? {} : { from: input.from }) }, current);
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  });
}
