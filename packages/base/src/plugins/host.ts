import { AsyncLocalStorage } from "node:async_hooks";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { AgentTool } from "../agent.js";
import { prepareItem, type AskRoute } from "../ask.js";
import {
  ASK_USER_TOOL,
  BUILTIN_TOOLS,
  RESERVED_TOOL_NAMES,
  type AgentDefinition,
  type AskOptions,
  type AskOutcome,
  type Host,
  type ModelScope,
  type PluginInstance,
  type Services,
} from "../plugin.js";
import type { PluginHost, PluginHostOptions } from "../plugins.js";
import { currentRun, withToolCall } from "../run-context.js";
import { object, parse, RepaFault } from "../schema.js";
import { createModelScope } from "./models.js";

const NO_ASK: AskRoute = () => Promise.reject(new RepaFault("ask_unavailable", "当前没有可以作答的连接"));
const NO_SERVICES: Services = {
  call: (service) => Promise.reject(new RepaFault("service_unavailable", "没有连接提供这项服务", { service })),
};

/**
 * 插件工具的 ToolContext.ask：来源写明插件、会话和工具调用，Item 按词汇整理后交给路由。
 * onSubmit 在提问时的上下文里执行：它属于这次工具调用，写入记在这次运行名下；
 * 带命令行的运行持有空间写锁等待回答，onSubmit 若在回复的上下文里写文件就会和它互相等待。
 */
async function askAs(route: AskRoute, pluginId: string, context: { signal: AbortSignal; callId: string }, options: AskOptions): Promise<AskOutcome> {
  const item = await prepareItem(options.item);
  const run = currentRun();
  const onSubmit = options.onSubmit;
  const inCall = AsyncLocalStorage.snapshot();
  return route({
    origin: { kind: "plugin", pluginId, ...(run === undefined ? {} : { sessionId: run.sessionId }), callId: context.callId },
    item,
  }, {
    signal: context.signal,
    ...(onSubmit === undefined ? {} : { onSubmit: (response) => inCall(() => onSubmit.call(options, response)) }),
  });
}

const AgentFieldsSchema = object({
  id: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
  description: Type.Optional(Type.String()),
  tools: Type.Array(Type.String()),
  subagents: Type.Optional(Type.Array(Type.String())),
  direct: Type.Optional(Type.Boolean()),
});

class AgentDefinitionFailure extends Error {
  constructor(readonly definition: AgentDefinition, readonly failure: unknown) {
    super("插件 Agent 定义无效");
  }
}

/**
 * 打开时一次核对全部定义：id 唯一，工具和子 Agent 都存在，子 Agent 的工具不超过父 Agent。
 * 定义可以互相列为子 Agent，也可以列自己；失控的递归由运行时的嵌套层数上限挡住。
 */
function checkAgents(definitions: AgentDefinition[], pluginTools: Set<string>): void {
  const ids = new Set<string>();
  for (const definition of definitions) {
    try {
      const { id, description, tools, subagents, direct } = definition;
      const fields = {
        id, tools,
        ...(description === undefined ? {} : { description }),
        ...(subagents === undefined ? {} : { subagents }),
        ...(direct === undefined ? {} : { direct }),
      };
      const functions = [definition.view, definition.beforeMessage, definition.beforeRun];
      if (!Check(AgentFieldsSchema, fields) || typeof definition.instructions !== "function" || functions.some(item => item !== undefined && typeof item !== "function")) {
        throw new RepaFault("invalid_agent", "Agent 定义不符合接口要求", { id });
      }
      if (id === "general" || ids.has(id)) throw new RepaFault("invalid_agent_id", "Agent id 必须唯一，且不能使用 general", { id });
      ids.add(id);
    } catch (error) {
      throw new AgentDefinitionFailure(definition, error);
    }
  }
  const builtins = new Set<string>([...BUILTIN_TOOLS, ASK_USER_TOOL]);
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  for (const definition of definitions) {
    try {
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
    } catch (error) {
      throw new AgentDefinitionFailure(definition, error);
    }
  }
}

export async function openPluginHost(options: PluginHostOptions): Promise<PluginHost> {
  const { space } = options;
  const instances = new Map<string, PluginInstance>();
  const pluginTools = new Map<string, AgentTool[]>();
  const askRoute = options.ask ?? NO_ASK;
  const serviceRoute = options.services ?? NO_SERVICES;
  let agentDefinitions: AgentDefinition[] = [];
  let pending: Promise<void> = Promise.resolve();
  let pendingError: unknown;
  let closed = false;
  let stopping = false;
  const calls = new Set<Promise<unknown>>();
  let started = false;
  let starting: Promise<void> | undefined;
  // start() 的追赶完成以后为 true；此后发起的变化处理出错照常报告，不再停用插件。
  let caughtUp = false;
  const waiting = new Set<string>();
  let closing: Promise<void> | undefined;

  function checkOpen(): void {
    if (closed || stopping) throw new RepaFault("plugins_closed", "插件宿主已经关闭");
  }

  const modelScopes = new Map<string, ModelScope>();
  const disabledPlugins: ReturnType<PluginHost["disabled"]> = [];
  const definitionsByPlugin = new Map<string, AgentDefinition[]>();

  async function closeModels(): Promise<void> {
    const results = await Promise.allSettled([...modelScopes.values()].map((scope) => scope.close()));
    const failures = results.flatMap((result) => {
      if (result.status === "fulfilled") return [];
      return result.reason instanceof AggregateError ? result.reason.errors : [result.reason];
    });
    if (failures.length > 0) throw new AggregateError(failures, "插件模型工作关闭失败");
  }

  async function disable(id: string, error: unknown): Promise<void> {
    // 失败插件的模型先停稳，再释放实例。Agent 运行时每次用到时才向宿主取工具和 Agent，移除以后，列出的 Agent 和新建的会话里都不再有它的声明。
    const failures: unknown[] = [];
    try {
      await modelScopes.get(id)?.close();
    } catch (closeError) {
      failures.push(closeError);
    }
    try {
      await instances.get(id)?.close?.();
    } catch (closeError) {
      failures.push(closeError);
    }
    instances.delete(id);
    modelScopes.delete(id);
    pluginTools.delete(id);
    definitionsByPlugin.delete(id);
    disabledPlugins.push({
      id,
      reason: {
        code: error instanceof RepaFault ? error.code : "plugin_open_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    options.onError(error);
    for (const failure of failures) options.onError(failure);
  }

  function track<T>(operation: Promise<T>): Promise<T> {
    calls.add(operation);
    operation.then(() => { calls.delete(operation); }, () => { calls.delete(operation); });
    return operation;
  }

  function wrapAgent(definition: AgentDefinition): AgentDefinition {
    const { view, beforeMessage, beforeRun } = definition;
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
      ...(beforeRun === undefined ? {} : {
        beforeRun() {
          checkOpen();
          return track(Promise.resolve().then(() => beforeRun.call(definition)));
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

  /** 插件可以引用别的插件的工具和 Agent。移除失败方以后重新核对，依赖缺失只停受影响的插件。 */
  async function checkDeclarations(): Promise<void> {
    for (;;) {
      const declaredAgents = [...definitionsByPlugin.values()].flat();
      const availableTools = new Set([...pluginTools.values()].flat().map((tool) => tool.name));
      try {
        checkAgents(declaredAgents, availableTools);
      } catch (error) {
        if (!(error instanceof AgentDefinitionFailure)) throw error;
        const owner = [...definitionsByPlugin].find(([, definitions]) => definitions.includes(error.definition));
        if (!owner) throw error;
        await disable(owner[0], error.failure);
        continue;
      }
      // Agent 定义有效后才按装配顺序分配工具名，避免坏插件先占名而拖停无关插件。
      const names = new Set<string>();
      let conflict: { id: string; name: string } | undefined;
      for (const [id, tools] of pluginTools) {
        const duplicate = tools.find((tool) => names.has(tool.name));
        if (duplicate) {
          conflict = { id, name: duplicate.name };
          break;
        }
        for (const tool of tools) names.add(tool.name);
      }
      if (conflict) {
        await disable(conflict.id, new RepaFault("tool_name_conflict", "插件工具名称重复或覆盖内置工具", { name: conflict.name }));
        continue;
      }
      agentDefinitions = declaredAgents.map(wrapAgent).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      return;
    }
  }

  function wake(revision: string): void {
    if (stopping || closed) return;
    if (!started) {
      waiting.add(revision);
      return;
    }
    const opening = !caughtUp;
    pending = pending.then(async () => {
      const failures: [string, unknown][] = [];
      for (const [id, instance] of instances) {
        try {
          await instance.onChange?.(revision);
        } catch (error) {
          failures.push([id, error]);
        }
      }
      if (failures.length === 0) return;
      if (!opening) throw new AggregateError(failures.map(([, error]) => error), "插件变化处理失败");
      // start() 追赶完成之前，变化处理也是打开空间的一部分：出错和 open 失败一样，只停这个插件，再核对依赖它的插件。
      for (const [id, error] of failures) await disable(id, error);
      await checkDeclarations();
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
    const reservedNames = new Set(RESERVED_TOOL_NAMES);
    for (const plugin of options.plugins) {
      const ownedModels = createModelScope(typeof options.models === "function" ? options.models(plugin.id) : options.models, options.onError);
      modelScopes.set(plugin.id, ownedModels);
      try {
        const dataDir = await space.pluginDataDir(plugin.id);
        const ownedAgents = new Set<string>();
        const host: Host = {
          now: options.now ?? Date.now,
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
          abortAgent(agent) {
            checkOpen();
            if (!ownedAgents.has(agent)) {
              return Promise.reject(new RepaFault("agent_not_owned", "插件只能中止自己声明的 Agent", { agent }));
            }
            if (!options.abortAgent) {
              return Promise.reject(new RepaFault("space_not_ready", "空间尚未接入 Agent 中止入口"));
            }
            return track(Promise.resolve().then(() => options.abortAgent?.(agent)));
          },
          services: {
            call(service, input, callOptions) {
              checkOpen();
              return track(Promise.resolve().then(() => serviceRoute.call(service, input, callOptions)));
            },
          },
          emit: (event) => { options.emit(plugin.id, event); },
        };
        const instance = await plugin.open(host);
        instances.set(plugin.id, instance);
        const localNames = new Set<string>();
        const tools = (instance.tools?.() ?? []).map((tool): AgentTool => {
          if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(tool.name)) {
            throw new RepaFault("invalid_tool_name", "插件工具名称必须有效且不能重复", { name: tool.name });
          }
          if (localNames.has(tool.name) || reservedNames.has(tool.name)) {
            throw new RepaFault("tool_name_conflict", "插件工具名称重复或覆盖内置工具", { name: tool.name });
          }
          localNames.add(tool.name);
          return {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            execute(input, context) {
              checkOpen();
              const checked = parse(tool.parameters, input);
              const ask = (askOptions: AskOptions) => {
                checkOpen();
                return askAs(askRoute, plugin.id, context, askOptions);
              };
              return track(Promise.resolve().then(() => withToolCall(context.callId, () => tool.execute(checked, { ...context, ask }))));
            },
          };
        });
        pluginTools.set(plugin.id, tools);
        const definitions = instance.agents?.() ?? [];
        for (const definition of definitions) {
          ownedAgents.add(definition.id);
        }
        definitionsByPlugin.set(plugin.id, definitions);
      } catch (error) {
        await disable(plugin.id, error);
      }
    }
    await checkDeclarations();
  } catch (error) {
    stopping = true;
    unsubscribe();
    const failures = [error];
    try {
      await closeModels();
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
          caughtUp = true;
        })());
      }
      return starting;
    },
    disabled() {
      checkOpen();
      return disabledPlugins.map((plugin) => ({ ...plugin, reason: { ...plugin.reason } })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
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
    call(pluginId, methodName, input, caller) {
      checkOpen();
      const operation = (async () => {
        const instance = instances.get(pluginId);
        if (!instance) throw new RepaFault("plugin_not_found", "插件不存在", { pluginId });
        const method = Object.hasOwn(instance.methods ?? {}, methodName) ? instance.methods?.[methodName] : undefined;
        if (!method) throw new RepaFault("plugin_method_not_found", "插件方法不存在", { pluginId, methodName });
        const result = await method.invoke(parse(method.parameters, input), caller === undefined ? {} : { caller });
        // 返回前按声明校验结果，多带的字段也在这里拦下。
        if (method.result !== undefined && !Check(method.result, result)) {
          throw new RepaFault("invalid_plugin_result", "插件方法的返回值不符合它声明的 schema", { pluginId, methodName });
        }
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
            await closeModels();
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
