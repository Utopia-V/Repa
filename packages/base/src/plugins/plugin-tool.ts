import { Type } from "typebox";

import type { AgentTool } from "../agent.js";
import { PluginLoadFromSchema, type PluginInfo } from "../protocol.js";
import { parse, RepaFault, type Confirmation } from "../schema.js";
import type { PluginControl } from "./control.js";
import { PLUGIN_ID } from "../schema.js";

/** 通用 Agent 管理自写插件的工具名，由装配提供；插件工具同样不能用这个名字。 */
export const PLUGIN_TOOL = "plugin";

const STATES: Record<PluginInfo["state"], string> = {
  disabled: "未启用",
  running: "运行中",
  pending: "待批准",
  failed: "失败",
};
const FOLDERS: Record<NonNullable<PluginInfo["folder"]>, string> = {
  same: "与记下的版本相同",
  modified: "相对记下的版本有改动",
  missing: "不在",
  unreadable: "读不了",
};

/** 插件列表的分行文字，交给模型。 */
export function listText(plugins: PluginInfo[]): string {
  if (plugins.length === 0) return "这个空间没有插件。自写插件放在 .agents/plugins/<id>/。";
  return plugins.map((plugin) => {
    const parts = [`${plugin.id}（${plugin.source === "bundled" ? "随产品附带" : "自写"}）`, STATES[plugin.state]];
    if (plugin.reason !== undefined) parts.push(`原因：${plugin.reason.message}（${plugin.reason.code}）`);
    if (plugin.version !== undefined) parts.push(`版本 ${plugin.version}`);
    if (plugin.folder !== undefined) parts.push(`文件夹${FOLDERS[plugin.folder]}`);
    if (plugin.tools.length > 0) parts.push(`工具 ${plugin.tools.join("、")}`);
    if (plugin.previous !== undefined) parts.push("有上一次选定的版本");
    return parts.join("；");
  }).join("\n");
}

// 随底座附带的写插件 Skill，见 skills/plugin-authoring/SKILL.md；写法只在那里写一份，这里只指过去。
const AUTHORING_SKILL = "plugin-authoring";

const DESCRIPTION = `管理这个空间的自写插件：list 列出插件及状态，load 加载，unload 卸载。
插件文件夹在 .agents/plugins/<id>/，文件夹名就是插件 id。写或改插件之前先读 Skill ${AUTHORING_SKILL}，那里有文件夹的写法、模板和常见报错。
load 把文件夹当前的内容复制一份，通常要使用者批准，然后导入并打开；这次调用就是结果：成功时插件已生效，列出它的工具和说明，下一次回复就能调用这些工具；失败时给出原因，改好以后再 load。
插件已在运行时，load 用新内容替换它。from 为 previous 时让上一次选定的版本重新生效，为 recorded 时让启用记录里的版本重新生效。
unload 卸载插件，它的工具从下一次回复起不再出现；文件夹和数据都保留。`;

const Parameters = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("load"), Type.Literal("unload")]),
  id: Type.Optional(Type.String({ pattern: PLUGIN_ID.source, description: "插件 id，load 与 unload 必填" })),
  from: Type.Optional({ ...PluginLoadFromSchema, description: "load 取哪个版本，省略时为文件夹当前的内容；unload 不看它" }),
}, { additionalProperties: false });

/**
 * 通用 Agent 的 plugin 工具。load 与 unload 在这一次调用里完成，返回值就是结局；失败时抛错，模型读到原因。
 * confirm 把批准发给发起这次运行的连接，signal 是运行的中止信号。
 */
export function pluginTool(control: PluginControl, confirm: (request: Confirmation, signal?: AbortSignal) => Promise<string | boolean | null>): AgentTool {
  return {
    name: PLUGIN_TOOL,
    description: DESCRIPTION,
    parameters: Parameters,
    async execute(input, context) {
      const { action, id, from } = parse(Parameters, input);
      if (action === "list") return { text: listText(await control.list()) };
      if (id === undefined) throw new RepaFault("invalid_input", "load 与 unload 要给出 id");
      if (action === "unload") {
        await control.unload(id);
        return { text: `插件 ${id} 已卸载，它的工具从下一次回复起不再出现。文件夹和数据都保留。` };
      }
      const result = await control.load(id, { kind: "agent", confirm, signal: context.signal }, from);
      const { plugin } = result;
      const lines = [
        `插件 ${id} 已生效${plugin.version === undefined ? "" : `（版本 ${plugin.version}）`}。`,
        plugin.tools.length > 0 ? `工具：${plugin.tools.join("、")}，下一次回复起可以调用。` : "这个插件没有工具。",
      ];
      if (result.instructions !== undefined) lines.push(`插件说明（下一次运行起进入系统提示）：\n${result.instructions}`);
      return { text: lines.join("\n") };
    },
  };
}
