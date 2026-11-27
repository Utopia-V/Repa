// 端到端测试的夹具：临时知识库、真实的 Pi 会话与本地 fauxProvider、真实的 HTTP 后端，以及一个读 SSE 的客户端。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { ensureModes } from "../src/map.js";
import { Sessions } from "../src/pi/sessions.js";
import { applyEvent, type Conversation, type UiEvent } from "../src/protocol.js";
import { startServer } from "../src/server.js";

/** 模型这一次实际收到的上下文：系统提示各段按追加的顺序合并后的样子，以及消息。 */
export interface Seen {
  sections: Record<string, string>;
  messages: Array<{ role: string; content?: unknown; sections?: Record<string, string | null> }>;
}

/** 模型的一步：给出文字，或调用一个工具。 */
export type Step = { text: string } | { tool: string; args: Record<string, unknown> | ((seen: Seen) => Record<string, unknown>); id: string };

export interface Backend {
  root: string;
  faux: FauxProviderHandle;
  seen: Seen[];
  script(...steps: Step[]): void;
  api(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }>;
  connect(sessionId: string): Promise<Client>;
  raw(headers: Record<string, string>): Promise<number>;
  restart(): Promise<void>;
}

export interface Client {
  events: UiEvent[];
  conversation: Conversation;
  settled: number;
  until(predicate: () => boolean, what: string): Promise<void>;
}

/** 文字之中的最后一条用户消息（含不显示的附带上下文）。 */
export function lastUserText(seen: Seen): string {
  return seen.messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content)).join("\n");
}

/** 建一个后端。files 是知识库里的文件；知识库外层和 Pi 全局目录各放一份 AGENTS.md，用来检查它们不被读进来。 */
export async function backend(t: TestContext, files: Record<string, string>): Promise<Backend> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-e2e-")));
  const root = path.join(base, "kb");
  const agentDir = path.join(base, "agent");
  const write = async (file: string, text: string) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  await write(path.join(base, "AGENTS.md"), "知识库外层的要求");
  await write(path.join(agentDir, "AGENTS.md"), "Pi 全局目录的要求");
  for (const [rel, text] of Object.entries(files)) await write(path.join(root, rel), text);
  await ensureModes(root);
  await write(path.join(root, ".repa/settings.json"), JSON.stringify({ model: "faux/faux-1" }));

  // faux-1 支持 thinking，faux-plain 不支持，用来看换模型时级别怎样收窄。
  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }, { id: "faux-plain" }] });
  const seen: Seen[] = [];
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
  runtime.registerNativeProvider(faux.provider);
  let server = await startServer({ root, port: 0, sessions: await Sessions.create(root, { runtime, agentDir }) });
  const streams = new Set<AbortController>();
  const close = async () => {
    for (const controller of streams) controller.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  t.after(async () => {
    await close();
    await rm(base, { recursive: true, force: true });
  });
  const origin = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    root,
    faux,
    seen,
    script(...steps) {
      faux.appendResponses(steps.map((step) => (context) => {
        const sections: Record<string, string> = {};
        const messages = context.messages as Seen["messages"];
        for (const message of messages) {
          for (const [name, value] of Object.entries(message.sections ?? {})) {
            if (value === null) delete sections[name];
            else sections[name] = value;
          }
        }
        const now = { sections, messages };
        seen.push(now);
        if ("text" in step) return fauxAssistantMessage([fauxText(step.text)]);
        const args = typeof step.args === "function" ? step.args(now) : step.args;
        return fauxAssistantMessage([fauxToolCall(step.tool, args as Parameters<typeof fauxToolCall>[1], { id: step.id })], { stopReason: "toolUse" });
      }));
    },
    async api(method, url, body, headers = {}) {
      const response = await fetch(`${origin()}${url}`, {
        method,
        headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, json: (await response.json()) as Record<string, unknown> };
    },
    // fetch 不让改 Host，检查请求来源时用 node:http 直接发。
    raw(headers) {
      return new Promise((resolve, reject) => {
        const request = http.request(`${origin()}/api/tree`, { headers }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        request.on("error", reject);
        request.end();
      });
    },
    async connect(sessionId) {
      const controller = new AbortController();
      streams.add(controller);
      const response = await fetch(`${origin()}/api/sessions/${sessionId}/events`, { signal: controller.signal });
      assert.equal(response.status, 200);
      const client: Client = {
        events: [],
        conversation: { items: [], pending: [], running: false },
        settled: 0,
        async until(predicate, what) {
          const deadline = Date.now() + 10_000;
          while (!predicate()) {
            if (Date.now() > deadline) throw new Error(`等不到：${what}\n${JSON.stringify(client.conversation, null, 1).slice(0, 3000)}`);
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        },
      };
      void (async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body ?? []) {
          buffer += decoder.decode(chunk as Uint8Array, { stream: true });
          for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
            const event = JSON.parse(buffer.slice(6, at)) as UiEvent;
            buffer = buffer.slice(at + 2);
            client.events.push(event);
            client.conversation = applyEvent(client.conversation, event);
            if (event.type === "running" && !event.running) client.settled += 1;
          }
        }
      })().catch(() => undefined);
      await client.until(() => client.events.length > 0, "快照");
      return client;
    },
    async restart() {
      await close();
      server = await startServer({ root, port: 0, sessions: await Sessions.create(root, { runtime, agentDir }) });
    },
  };
}
