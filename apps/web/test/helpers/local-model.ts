import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const LOCAL_MODEL_ID = "local-web-model";

export type LocalModelResponse =
  | { kind: "text"; chunks: (string | Promise<string>)[] }
  | { kind: "tool"; name: string; arguments: Record<string, unknown> }
  | { kind: "error"; status: number; message: string };

export interface LocalModelRequest {
  body: {
    model: string;
    stream: true;
    messages: { role: string; [key: string]: unknown }[];
    [key: string]: unknown;
  };
  closed: boolean;
  finished: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequest(value: unknown): LocalModelRequest["body"] {
  assert(isRecord(value), "本地模型请求必须是 JSON 对象");
  assert.equal(value.model, LOCAL_MODEL_ID, "本地模型请求使用了未配置的模型");
  assert(typeof value.model === "string");
  assert.equal(value.stream, true, "本地模型只接受真实 SDK 的流式请求");
  assert(Array.isArray(value.messages), "本地模型请求缺少 messages 数组");
  const messages = value.messages.map((message: unknown) => {
    assert(isRecord(message), "本地模型消息必须是对象");
    assert(typeof message.role === "string", "本地模型消息缺少 role");
    return { ...message, role: message.role };
  });
  return { ...value, model: value.model, stream: true, messages };
}

export async function startLocalModel() {
  const requests: LocalModelRequest[] = [];
  const errors: unknown[] = [];
  const responses: LocalModelResponse[] = [];
  const pending = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    assert.equal(request.method, "POST", "本地模型只接受 POST 请求");
    assert.equal(request.url, "/v1/chat/completions", "本地模型收到未知路由");
    request.setEncoding("utf8");
    let bytes = "";
    for await (const chunk of request) bytes += chunk;
    const value: unknown = JSON.parse(bytes);
    const received: LocalModelRequest = { body: parseRequest(value), closed: response.destroyed, finished: false };
    requests.push(received);
    // close 同时覆盖正常完成和客户端取消；finished 保留两者的区别。
    const closed = new Promise<undefined>(resolve => {
      if (response.destroyed) {
        resolve(undefined);
        return;
      }
      response.once("close", () => {
        received.closed = true;
        resolve(undefined);
      });
    });
    response.once("finish", () => { received.finished = true; });
    const next = responses.shift();
    assert(next, `本地模型第 ${requests.length} 次请求没有预设响应`);
    if (next.kind === "error") {
      response.writeHead(next.status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: next.message, type: "local_test_error" } }));
      return;
    }

    const id = randomUUID();
    function chunk(delta: unknown, finishReason: string | null) {
      return {
        id,
        object: "chat.completion.chunk",
        created: 1,
        model: LOCAL_MODEL_ID,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      };
    }
    function send(value: unknown): void {
      response.write(`data: ${JSON.stringify(value)}\n\n`);
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    send(chunk({ role: "assistant" }, null));
    if (next.kind === "text") {
      for (const part of next.chunks) {
        // 等待中的文本也受真实连接生命周期控制，不要求测试在取消后释放屏障。
        const text = await Promise.race([part, closed]);
        if (text === undefined || response.destroyed) return;
        send(chunk({ content: text }, null));
      }
    } else {
      send(chunk({ tool_calls: [{
        index: 0,
        id: randomUUID(),
        type: "function",
        function: { name: next.name, arguments: JSON.stringify(next.arguments) },
      }] }, null));
    }
    send({
      ...chunk({}, next.kind === "tool" ? "tool_calls" : "stop"),
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    response.end("data: [DONE]\n\n");
  }

  const server = createServer((request, response) => {
    const task = handle(request, response).catch((error: unknown) => {
      // 客户端在上传请求时取消、或夹具关闭连接，不是预设响应的失败。
      if (request.aborted) return;
      errors.push(error);
      if (response.destroyed) return;
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: {
          message: error instanceof Error ? error.message : String(error),
          type: "local_fixture_error",
        } }));
      } else {
        response.destroy();
      }
    });
    pending.add(task);
    void task.finally(() => { pending.delete(task); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", (error: Error) => { errors.push(error); });
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    errors,
    enqueue(...values: LocalModelResponse[]): void {
      assert(!closing, "本地模型关闭后不能新增响应");
      responses.push(...values);
    },
    close(): Promise<void> {
      closing ??= (async () => {
        const stopped = new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
        });
        server.closeAllConnections();
        await stopped;
        await Promise.all(pending);
      })();
      return closing;
    },
  };
}
