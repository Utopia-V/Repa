import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createBashTool, createBashToolDefinition, type BashToolDetails, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { CapabilitySource } from "../capabilities/schema.js";
import type { ConfigStore } from "../configuration/store.js";
import type { ContentStore } from "../content/store.js";
import { RepaFault } from "../errors.js";
import type { Dialog, DialogOptions } from "../pi-host.js";
import type { Reply } from "../requests/schema.js";
import { executionRepresentation } from "./format.js";
import { coversPolicy, extendPolicy, normalizePolicy } from "./policy.js";
import { runCommand } from "./process.js";
import { ExecutionInputSchema, type ExecutionInput, type ExecutionPolicy, type ExecutionView } from "./schema.js";

export interface ExecutionContext {
  spaceId: string;
  requestId: string;
  source: CapabilitySource;
  signal: AbortSignal;
  ask(dialog: Dialog, options?: DialogOptions): Promise<Reply>;
}

export interface ExecutionServiceOptions {
  configuration: ConfigStore;
  space(spaceId: string): { root: string; content: ContentStore };
  protectedPaths: readonly string[];
  readPaths?(spaceId: string): readonly string[] | Promise<readonly string[]>;
  changed(view: ExecutionView): void;
  output?(view: ExecutionView, stream: "stdout" | "stderr", text: string): void;
}

/** 命令归属于真实请求；授权、输出保留和撤销共用同一次执行，不创建第二条任务队列。 */
export class ExecutionService {
  readonly #active = new Map<string, {
    view: ExecutionView;
    baseline: ExecutionPolicy;
    controller: AbortController;
    done: Promise<void>;
  }>();

  constructor(readonly options: ExecutionServiceOptions) {}

  list(spaceId?: string): ExecutionView[] {
    return [...this.#active.values()].filter(active => !spaceId || active.view.spaceId === spaceId).map(active => structuredClone(active.view));
  }

  async policy(spaceId: string): Promise<{ cwd: string; policy: ExecutionPolicy; protectedPaths: string[] }> {
    const { root } = this.options.space(spaceId);
    const settings = await this.options.configuration.get({ kind: "application" }, "execution");
    const values = Object.fromEntries(settings.entries.map(item => [item.key, item.effective])) as {
      default: ExecutionPolicy; spaces: Record<string, ExecutionPolicy>;
    };
    let policy = await normalizePolicy(Object.hasOwn(values.spaces, spaceId) ? values.spaces[spaceId]! : values.default, root);
    if (policy.mode === "restricted") {
      const external = await this.options.readPaths?.(spaceId) ?? [];
      policy = { ...policy, readPaths: [...new Set([...policy.readPaths, ...external])] };
    }
    return { cwd: root, policy, protectedPaths: policy.mode === "full-access" ? [] : [path.join(root, ".repa"), ...this.options.protectedPaths] };
  }

  /** 设置保存后撤销失去覆盖的执行；等待的是进程及输出收尾，不是整个父请求。 */
  async refresh(): Promise<void> {
    const states = new Map<string, Promise<Awaited<ReturnType<ExecutionService["policy"]>>>>();
    const stopped: Promise<void>[] = [];
    let failure: unknown;
    for (const active of this.#active.values()) {
      let pending = states.get(active.view.spaceId);
      if (!pending) {
        pending = this.policy(active.view.spaceId);
        states.set(active.view.spaceId, pending);
      }
      try {
        const state = await pending;
        if (coversPolicy(state.policy, active.baseline, state.cwd)) continue;
      } catch (error) {
        // 新策略已保存；路径失效时旧授权也不能继续生效，先完成受影响命令的收尾。
        failure ??= error;
      }
      if (!active.controller.signal.aborted) {
        active.controller.abort(new RepaFault("permission_revoked", "执行授权已经收回。"));
      }
      stopped.push(active.done);
    }
    await Promise.all(stopped);
    if (failure) throw new RepaFault("execution_policy_unavailable", "新设置已保存，受影响命令已停止；请修正无法生效的执行路径。", {
      reason: failure instanceof Error ? failure.message : String(failure),
    });
  }

  createTool(cwd: string, context: (signal?: AbortSignal) => ExecutionContext): ToolDefinition {
    const base = createBashToolDefinition(cwd, { exposeSessionEnvironment: false });
    return {
      name: base.name, label: base.label,
      description: base.description.replace("full output is saved to a temp file", "full output is retained as a Repa resource") +
        " Use access only when this command needs additional filesystem or network permission; Repa asks the user before execution.",
      promptSnippet: base.promptSnippet,
      constrainedSampling: base.constrainedSampling,
      // 保留 SDK 的命令、超时 schema；只有 Repa 的按次授权请求属于新增参数。
      parameters: Type.Object({ ...base.parameters.properties, access: ExecutionInputSchema.properties.access }),
      execute: async (_callId, input, signal, onUpdate) => {
        const result = await this.run(input as ExecutionInput, context(signal), view => {
          onUpdate?.({ content: view.output ? [{ type: "text", text: view.output }] : [], details: executionRepresentation(view) });
        });
        const details = executionRepresentation(result);
        if (result.status !== "completed") throw new RepaFault(result.error?.code ?? "execution_failed", result.output || result.error?.message || "命令执行失败。", details);
        return { content: [{ type: "text", text: result.output || "(no output)" }], details };
      },
    };
  }

  async run(input: ExecutionInput, context: ExecutionContext, update?: (view: ExecutionView) => void): Promise<ExecutionView> {
    if (!Check(ExecutionInputSchema, input)) throw new RepaFault("invalid_input", "命令或执行授权参数无效。");
    context.signal.throwIfAborted();
    const state = await this.policy(context.spaceId);
    context.signal.throwIfAborted();
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const view: ExecutionView = {
      id: randomUUID(), spaceId: context.spaceId, requestId: context.requestId, source: structuredClone(context.source),
      command: input.command, cwd: state.cwd, policy: state.policy, protectedPaths: state.protectedPaths,
      status: "authorizing", createdAt: Date.now(), output: "", truncated: false,
    };
    const publish = () => { this.options.changed(structuredClone(view)); update?.(structuredClone(view)); };
    this.#active.set(view.id, { view, baseline: state.policy, controller, done });
    const abort = () => {
      view.status = "cancelling";
      publish();
    };
    signal.addEventListener("abort", abort, { once: true });
    publish();
    let fullOutputPath: string | undefined;
    let failure: unknown;
    const sanitize = (text: string) => fullOutputPath ? text.replaceAll(fullOutputPath, view.fullOutput
      ? `repa:resource/${view.fullOutput.id}`
      : "[完整输出将在命令结束后保存为资源]") : text;
    try {
      if (input.access) {
        const wanted = extendPolicy(state.policy, await normalizePolicy(input.access.policy, state.cwd));
        if (!coversPolicy(state.policy, wanted, state.cwd)) {
          const approved = await context.ask({
            kind: "confirm", title: "扩大本次命令的执行权限", message: input.access.reason,
            execution: { executionId: view.id, command: input.command, cwd: state.cwd, policy: wanted, lifetime: "once" },
          }, { signal });
          signal.throwIfAborted();
          if (approved !== true) throw new RepaFault("permission_denied", "本次命令未获授权，未执行。");
          view.policy = wanted;
          if (wanted.mode === "full-access") view.protectedPaths = [];
        }
      }
      signal.throwIfAborted();
      // 受理与用户答复都可能跨越配置修改；进入执行前重读机器侧授权。
      const current = await this.policy(context.spaceId);
      signal.throwIfAborted();
      if (!coversPolicy(current.policy, state.policy, state.cwd))
        throw new RepaFault("permission_revoked", "等待期间执行授权已经收回，命令未执行。");
      const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
      const tool = createBashTool(state.cwd, {
        exposeSessionEnvironment: false,
        operations: {
          exec: async (command, cwd, options) => runCommand({
            command, cwd, policy: view.policy, protectedPaths: view.protectedPaths,
            signal, timeout: options.timeout,
            onData: (stream, data) => {
              options.onData(data);
              const text = decoders[stream].write(data);
              if (text) this.options.output?.(structuredClone(view), stream, text);
            },
            onStarted: pid => { view.pid = pid; view.startedAt = Date.now(); view.status = "running"; publish(); },
            onExited: result => {
              view.exitCode = result.exitCode;
              if (result.signal) view.terminationSignal = result.signal;
              for (const stream of ["stdout", "stderr"] as const) {
                const text = decoders[stream].end();
                if (text) this.options.output?.(structuredClone(view), stream, text);
              }
            },
          }),
        },
      });
      const onUpdate = (result: { content: unknown; details: unknown }) => {
        const details = result.details as BashToolDetails | undefined;
        fullOutputPath = details?.fullOutputPath ?? fullOutputPath;
        view.truncated = details?.truncation?.truncated ?? view.truncated;
        const parts = result.content as { type: string; text?: string }[];
        view.output = sanitize(parts.filter(part => part.type === "text").map(part => part.text ?? "").join("\n"));
        publish();
      };
      try {
        const result = await tool.execute(view.id, { command: input.command, timeout: input.timeout }, signal, onUpdate);
        onUpdate(result);
      } catch (error) {
        failure = error;
        if (error instanceof Error) view.output = sanitize(error.message);
      }
      if (fullOutputPath) {
        const { content } = this.options.space(context.spaceId);
        const owner = `${context.source.kind === "agent" ? "request" : "processing"}:${context.requestId}`;
        // 即使命令取消，也先保留已发生的输出；父请求在本调用返回后才完成收尾。
        view.fullOutput = await content.queue.run(async () => {
          const ref = { spaceId: context.spaceId, id: await content.blobs.importFile(fullOutputPath!), mediaType: "text/plain" };
          content.retention.retainAdditional(owner, [ref]);
          return ref;
        });
        view.output = view.output.replaceAll("[完整输出将在命令结束后保存为资源]", `repa:resource/${view.fullOutput.id}`);
      }
      if (failure) throw failure;
      view.status = signal.aborted ? "cancelled" : "completed";
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error;
      view.status = signal.aborted ? "cancelled" : "failed";
      view.error = { code: reason instanceof RepaFault ? reason.code : "execution_failed", message: sanitize(reason instanceof Error ? reason.message : String(reason)) };
      if (!view.output) view.output = view.error.message;
    } finally {
      try { if (fullOutputPath) await rm(fullOutputPath, { force: true }); }
      finally {
        signal.removeEventListener("abort", abort);
        view.finishedAt = Date.now();
        publish();
        this.#active.delete(view.id);
        finish();
      }
    }
    return structuredClone(view);
  }
}
