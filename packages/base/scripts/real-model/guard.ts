import type { AgentRuntime, AgentSession } from "@repa/base";

// 在宿主同步收到助手终态时取消工具续轮；经 RPC 通知再取消会晚于工具执行。
export function guardProbeRuntime(runtime: AgentRuntime): AgentRuntime {
  return {
    listModels: () => runtime.listModels(),
    login: (...args) => runtime.login(...args),
    setKey: (...args) => runtime.setKey(...args),
    logout: (...args) => runtime.logout(...args),
    complete: (...args) => runtime.complete(...args),
    completeStructured: (...args) => runtime.completeStructured(...args),
    close: () => runtime.close(),
    async openSpace(options) {
      const sessions = new Map<string, AgentSession>();
      const cancellations = new Set<Promise<void>>();
      let cancellationFailed = false;
      const space = await runtime.openSpace({
        ...options,
        onEvent(event) {
          const stopReason = event.data !== null && typeof event.data === "object"
            && "stopReason" in event.data ? event.data.stopReason : undefined;
          if ((event.type === "message" && stopReason === "toolUse") || event.type === "toolStart") {
            const session = sessions.get(event.sessionId);
            if (session) {
              const cancelled = session.abort().catch(() => { cancellationFailed = true; });
              cancellations.add(cancelled);
              cancelled.then(() => cancellations.delete(cancelled));
            }
          }
          options.onEvent(event);
        },
      });
      const remember = (session: AgentSession) => {
        sessions.set(session.info().id, session);
        return session;
      };
      return {
        create: async model => remember(await space.create(model)),
        get: async id => remember(await space.get(id)),
        list: () => space.list(),
        preview: () => space.preview(),
        async runAgent() { throw new Error("probe_background_agent_blocked"); },
        async close() {
          await space.close();
          await Promise.all(cancellations);
          if (cancellationFailed) throw new Error("probe_cancellation_failed");
        },
      };
    },
  };
}
