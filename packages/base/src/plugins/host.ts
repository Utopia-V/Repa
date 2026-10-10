import type { Host, PluginInstance, Tool } from "../plugin.js";
import type { PluginHost, PluginHostOptions } from "../plugins.js";
import { parse, RepaFault } from "../schema.js";

export async function openPluginHost(options: PluginHostOptions): Promise<PluginHost> {
  const { space, models } = options;
  const instances = new Map<string, PluginInstance>();
  const pluginTools = new Map<string, Tool[]>();
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

  function wake(revision: string): void {
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
    const names = new Set<string>();
    for (const plugin of options.plugins) {
      if (!/^[a-z][a-z0-9-]*$/.test(plugin.id) || instances.has(plugin.id)) {
        throw new RepaFault("invalid_plugin_id", "插件 id 必须唯一，且仅含小写字母、数字和连字符", { id: plugin.id });
      }
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
        models,
        emit: (event) => { options.emit(plugin.id, event); },
      };
      const instance = await plugin.open(host);
      instances.set(plugin.id, instance);
      const tools = (instance.tools?.() ?? []).map((tool): Tool => {
        if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(tool.name) || names.has(tool.name)) {
          throw new RepaFault("invalid_tool_name", "插件工具名称必须有效且不能重复", { name: tool.name });
        }
        names.add(tool.name);
        return {
          ...tool,
          execute(input, context) {
            checkOpen();
            const checked = parse(tool.parameters, input);
            return tool.execute(checked, context);
          },
        };
      });
      pluginTools.set(plugin.id, tools);
    }
  } catch (error) {
    unsubscribe();
    const failures = [error];
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
        starting = (async () => {
          const [latest] = await space.history.list(1);
          if (latest) waiting.add(latest.id);
          started = true;
          for (const revision of waiting) wake(revision);
          waiting.clear();
          await flush();
        })();
      }
      return starting;
    },
    list() {
      checkOpen();
      return [...instances].map(([id, instance]) => ({
        id,
        methods: Object.keys(instance.methods ?? {}),
        tools: (pluginTools.get(id) ?? []).map((tool) => tool.name),
      }));
    },
    instructions() {
      checkOpen();
      const result: { id: string; text: string }[] = [];
      for (const [id, instance] of instances) {
        const text = instance.instructions?.();
        if (text !== undefined) result.push({ id: `plugin:${id}`, text });
      }
      return result;
    },
    tools() {
      checkOpen();
      return [...pluginTools.values()].flat();
    },
    async views() {
      checkOpen();
      const result: { id: string; text: string }[] = [];
      for (const [id, instance] of instances) {
        const text = await instance.view?.();
        if (text !== undefined) result.push({ id: `plugin:${id}`, text });
      }
      return result;
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
      calls.add(operation);
      operation.then(() => { calls.delete(operation); }, () => { calls.delete(operation); });
      return operation;
    },
    flush,
    close() {
      if (closing === undefined) {
        stopping = true;
        closing = (async () => {
          await Promise.allSettled([...calls]);
          const failures: unknown[] = [];
          try {
            await flush();
          } catch (error) {
            failures.push(error);
          }
          unsubscribe();
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
