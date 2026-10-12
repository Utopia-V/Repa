import { Type } from "typebox";
import { Check } from "typebox/value";
import { BUILTIN_TOOLS, RESERVED_TOOL_NAMES, type AgentDefinition, type Host, type PluginInstance, type Tool } from "../plugin.js";
import type { PluginHost, PluginHostOptions } from "../plugins.js";
import { object, parse, RepaFault } from "../schema.js";
import { createModelScope } from "./models.js";

const AgentFieldsSchema = object({
  id: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
  description: Type.Optional(Type.String()),
  tools: Type.Array(Type.String()),
  subagents: Type.Optional(Type.Array(Type.String())),
  direct: Type.Optional(Type.Boolean()),
});

/**
 * 打开时一次核对全部定义：id 唯一，工具和子 Agent 都存在，子 Agent 的工具不超过父 Agent。
 * 定义可以互相列为子 Agent，也可以列自己；失控的递归由运行时的嵌套层数上限挡住。
 */
function checkAgents(definitions: AgentDefinition[], pluginTools: Set<string>): void {
  const ids = new Set<string>();
  for (const definition of definitions) {
    const { id, description, tools, subagents, direct } = definition;
    const fields = {
      id, tools,
      ...(description === undefined ? {} : { description }),
      ...(subagents === undefined ? {} : { subagents }),
      ...(direct === undefined ? {} : { direct }),
    };
    const functions = [definition.view, definition.beforeMessage];
    if (!Check(AgentFieldsSchema, fields) || typeof definition.instructions !== "function" || functions.some(item => item !== undefined && typeof item !== "function")) {
      throw new RepaFault("invalid_agent", "Agent 定义不符合接口要求", { id });
    }
    if (id === "general" || ids.has(id)) throw new RepaFault("invalid_agent_id", "Agent id 必须唯一，且不能使用 general", { id });
    ids.add(id);
  }
  const builtins = new Set<string>(BUILTIN_TOOLS);
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  for (const definition of definitions) {
    for (const tool of definition.tools) {
      if (!builtins.has(tool) && !pluginTools.has(tool)) {
        throw new RepaFault("unknown_agent_tool", "Agent 定义引用了不存在的工具", { agent: definition.id, tool });
      }
      // Pi 的 grep 把模型给的 glob 原样交给 ripgrep 的 --glob，后者越过忽略文件，.repa/.ignore 挡不住它；
      // 底座又不另写一套搜索，所以插件 Agent 不提供 grep。
      if (tool === "grep") {
        throw new RepaFault("agent_tool_unavailable", "插件 Agent 不提供 grep：它会越过 .repa/.ignore 读到会话记录和插件数据。需要搜索课程内容时，请由插件提供自己的工具", { agent: definition.id, tool });
      }
    }
    const allowed = new Set(definition.tools);
    for (const subagent of definition.subagents ?? []) {
      const child = byId.get(subagent);
      if (child === undefined) throw new RepaFault("unknown_subagent", "Agent 定义引用了不存在的子 Agent", { agent: definition.id, subagent });
      // 更高权限的工作由插件程序触发，不能靠 Agent 之间转托取得。
      const beyond = child.tools.filter((tool) => !allowed.has(tool));
      if (beyond.length > 0) {
        throw new RepaFault("subagent_exceeds_parent", "子 Agent 的工具超过父 Agent", { agent: definition.id, subagent, tools: beyond });
      }
    }
  }
}

export async function openPluginHost(options: PluginHostOptions): Promise<PluginHost> {
  const { space } = options;
  const instances = new Map<string, PluginInstance>();
  const pluginTools = new Map<string, Tool[]>();
  let agentDefinitions: AgentDefinition[] = [];
  let pending: Promise<void> = Promise.resolve();
  let pendingError: unknown;
  let closed = false;
  let stopping = false;
  const calls = new Set<Promise<unknown>>();
  let started = false;
  let starting: Promise<void> | undefined;
  const waiting = new Set<string>();
  let closing: Promise<void> | undefined;

  function checkOpen(): void {
    if (closed || stopping) throw new RepaFault("plugins_closed", "插件宿主已经关闭");
  }

  const ownedModels = createModelScope(options.models, options.onError);

  function track<T>(operation: Promise<T>): Promise<T> {
    calls.add(operation);
    operation.then(() => { calls.delete(operation); }, () => { calls.delete(operation); });
    return operation;
  }

  function wrapAgent(definition: AgentDefinition): AgentDefinition {
    const { view, beforeMessage } = definition;
    return {
      id: definition.id,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      instructions() {
        checkOpen();
        return definition.instructions();
      },
      tools: [...definition.tools],
      ...(definition.subagents === undefined ? {} : { subagents: [...definition.subagents] }),
      ...(definition.direct === undefined ? {} : { direct: definition.direct }),
      ...(view === undefined ? {} : {
        view() {
          checkOpen();
          return track(Promise.resolve().then(() => view.call(definition)));
        },
      }),
      ...(beforeMessage === undefined ? {} : {
        beforeMessage(message) {
          checkOpen();
          return track(Promise.resolve().then(() => beforeMessage.call(definition, message)));
        },
      }),
    };
  }

  function orderedInstances(): [string, PluginInstance][] {
    return [...instances].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  }

  function wake(revision: string): void {
    if (stopping || closed) return;
    if (!started) {
      waiting.add(revision);
      return;
    }
    pending = pending.then(async () => {
      const failures: unknown[] = [];
      for (const instance of instances.values()) {
        try {
          await instance.onChange?.(revision);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, "插件变化处理失败");
    }).catch((error: unknown) => {
      pendingError = error;
      options.onError(error);
    });
  }

  async function flush(): Promise<void> {
    let current: Promise<void>;
    do {
      await space.flush();
      current = pending;
      await current;
    } while (current !== pending);
    if (pendingError !== undefined) {
      const error = pendingError;
      pendingError = undefined;
      throw error;
    }
  }

  // 监听先登记，但在运行时接好并 start 之前只积累唤醒。
  const unsubscribe = space.onRevision((revision) => { wake(revision.id); });
  try {
    const ids = new Set<string>();
    for (const plugin of options.plugins) {
      if (!/^[a-z][a-z0-9-]*$/.test(plugin.id) || ids.has(plugin.id)) {
        throw new RepaFault("invalid_plugin_id", "插件 id 必须唯一，且仅含小写字母、数字和连字符", { id: plugin.id });
      }
      ids.add(plugin.id);
    }
    const names = new Set<string>();
    const reservedNames = new Set(RESERVED_TOOL_NAMES);
    const declaredAgents: AgentDefinition[] = [];
    for (const plugin of options.plugins) {
      const dataDir = await space.pluginDataDir(plugin.id);
      const host: Host = {
        space: { root: space.root, dataDir },
        files: space.filesFor({ kind: "plugin", pluginId: plugin.id }),
        history: {
          changes: (since) => space.history.changes(since),
          list: (limit) => space.history.list(limit),
          record: (source, action) => {
            if (source.kind !== "plugin" || source.pluginId !== plugin.id) {
              throw new RepaFault("invalid_history_source", "插件只能以自己的来源记录历史");
            }
            return space.record(source, action);
          },
        },
        models: ownedModels.models,
        emit: (event) => { options.emit(plugin.id, event); },
      };
      const instance = await plugin.open(host);
      instances.set(plugin.id, instance);
      const tools = (instance.tools?.() ?? []).map((tool): Tool => {
        if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(tool.name)) {
          throw new RepaFault("invalid_tool_name", "插件工具名称必须有效且不能重复", { name: tool.name });
        }
        if (names.has(tool.name) || reservedNames.has(tool.name)) {
          throw new RepaFault("tool_name_conflict", "插件工具名称重复或覆盖内置工具", { name: tool.name });
        }
        names.add(tool.name);
        return {
          ...tool,
          execute(input, context) {
            checkOpen();
            const checked = parse(tool.parameters, input);
            return track(Promise.resolve().then(() => tool.execute(checked, context)));
          },
        };
      });
      pluginTools.set(plugin.id, tools);
      declaredAgents.push(...(instance.agents?.() ?? []));
    }
    checkAgents(declaredAgents, names);
    agentDefinitions = declaredAgents.map(wrapAgent).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  } catch (error) {
    stopping = true;
    unsubscribe();
    const failures = [error];
    try {
      await ownedModels.close();
    } catch (closeError) {
      failures.push(closeError);
    }
    for (const instance of [...instances.values()].reverse()) {
      try {
        await instance.close?.();
      } catch (closeError) {
        failures.push(closeError);
      }
    }
    if (failures.length > 1) throw new AggregateError(failures, "插件打开与清理都失败了");
    throw error;
  }

  return {
    start() {
      checkOpen();
      if (starting === undefined) {
        starting = track((async () => {
          const [latest] = await space.history.list(1);
          if (latest) waiting.add(latest.id);
          started = true;
          for (const revision of waiting) wake(revision);
          waiting.clear();
          await flush();
        })());
      }
      return starting;
    },
    list() {
      checkOpen();
      return orderedInstances().map(([id, instance]) => ({
        id,
        methods: Object.keys(instance.methods ?? {}),
        tools: (pluginTools.get(id) ?? []).map((tool) => tool.name),
      }));
    },
    instructions() {
      checkOpen();
      const result: { id: string; text: string }[] = [];
      for (const [id, instance] of orderedInstances()) {
        const text = instance.instructions?.();
        if (text !== undefined) result.push({ id: `plugin:${id}`, text });
      }
      return result;
    },
    tools() {
      checkOpen();
      return [...pluginTools.values()].flat().sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    },
    agents() {
      checkOpen();
      return [...agentDefinitions];
    },
    views() {
      checkOpen();
      return track((async () => {
        const result: { id: string; text: string }[] = [];
        for (const [id, instance] of orderedInstances()) {
          const text = await instance.view?.();
          if (text !== undefined) result.push({ id: `plugin:${id}`, text });
        }
        return result;
      })());
    },
    call(pluginId, methodName, input) {
      checkOpen();
      const operation = (async () => {
        const instance = instances.get(pluginId);
        if (!instance) throw new RepaFault("plugin_not_found", "插件不存在", { pluginId });
        const method = Object.hasOwn(instance.methods ?? {}, methodName) ? instance.methods?.[methodName] : undefined;
        if (!method) throw new RepaFault("plugin_method_not_found", "插件方法不存在", { pluginId, methodName });
        const result = await method.invoke(parse(method.parameters, input));
        // 插件自有目录不在影子历史中，但界面方法仍然是一次状态唤醒。
        const [latest] = await space.history.list(1);
        if (latest) wake(latest.id);
        await flush();
        return result;
      })();
      return track(operation);
    },
    flush,
    close() {
      if (closing === undefined) {
        stopping = true;
        unsubscribe();
        closing = (async () => {
          const failures: unknown[] = [];
          try {
            await ownedModels.close();
          } catch (error) {
            failures.push(error);
          }
          await Promise.allSettled([...calls]);
          try {
            await flush();
          } catch (error) {
            failures.push(error);
          }
          closed = true;
          for (const instance of [...instances.values()].reverse()) {
            try {
              await instance.close?.();
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length > 0) throw new AggregateError(failures, "插件宿主关闭失败");
        })();
      }
      return closing;
    },
  };
}
