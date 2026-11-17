/**
 * 本机的假模型：说 OpenAI 兼容的 chat completions（流式），按走查脚本给的剧本回答，不联网、不花钱。
 * 后端经临时配置目录里的 agent/models.json 找到它，与真实的提供方走同一条路（Pi 的请求、工具循环、会话落盘）。
 *
 * 后端发来的请求有三种，按请求本身区分：
 * - 通用 Agent 的一轮（带 course_use 等工具）：按最近一条用户消息找剧本，剧本的第 n 步对应这条消息之后的第 n 次回答；
 * - 课程核对（course_confirm 发出的独立解题，系统提示以“你在独立解一道练习题”开头）：按题面查走查脚本事先算好的答案；
 * - 开放题判分（带 submit_result 工具，系统提示以“独立评价本题原答”开头）：判对；走查要求时先扣住不答。
 * 其他请求一律回一句话，并记进 unexpected，走查把它当作失败的证据。
 */
import { createServer, type Server } from "node:http";

/** 剧本的一步：调用这些工具（同一次回答里并列调用），或者说一句话结束这一轮。 */
export type Step = { tools: { name: string; arguments: Record<string, unknown> }[] } | { text: string };

interface Script {
  /** 用户消息里含这段文字时用这个剧本。 */
  match: string;
  steps: Step[];
}

/** 一次请求的记录，走查失败时作为证据。 */
export interface ModelRequestLog {
  kind: "agent" | "confirm" | "grade" | "other";
  /** agent：剧本匹配的那段文字和第几步；confirm：查到没有；grade：判了什么。 */
  note: string;
  /** agent：这一轮之前最后一个工具结果（截断）。 */
  toolResult?: string;
}

interface ChatMessage {
  role: string;
  content?: string | { type: string; text?: string }[] | null;
  tool_calls?: unknown[];
}

function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return (content ?? []).map((part) => part.text ?? "").join("");
}

export class ScriptedModel {
  readonly provider = "repa-verify";
  readonly id = "scripted";
  readonly log: ModelRequestLog[] = [];
  readonly unexpected: string[] = [];
  /** 每次工具调用交回的结果，按到达顺序。 */
  readonly toolResults: { tool: string; text: string }[] = [];
  private scripts: Script[] = [];
  private answers = new Map<string, string>();
  private held: (() => void)[] = [];
  private holding = false;
  private toolNames = new Map<string, string>();
  private calls = 0;

  private constructor(private server: Server, readonly port: number) {}

  static async start(): Promise<ScriptedModel> {
    let model: ScriptedModel | undefined;
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        void model?.answer(body, response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("假模型没有拿到端口");
    model = new ScriptedModel(server, address.port);
    return model;
  }

  /** 写进 agent/models.json 的内容。 */
  modelsJson(): unknown {
    return {
      providers: {
        [this.provider]: {
          baseUrl: `http://127.0.0.1:${this.port}/v1`, api: "openai-completions", apiKey: "verify",
          models: [{ id: this.id, name: "走查用的假模型" }],
        },
      },
    };
  }

  /** 用户消息里含 match 时，通用 Agent 按 steps 一步步回答；后加的剧本优先。 */
  script(match: string, steps: Step[]): void {
    this.scripts.unshift({ match, steps });
  }

  /** 课程核对的标准答案：按发给模型的题面（prompt）查。 */
  setAnswers(answers: Map<string, string>): void {
    this.answers = answers;
  }

  /** 开放题判分先扣住不答，直到 release()；用来造出“判分途中关闭”。 */
  holdGrading(): void {
    this.holding = true;
  }

  /** 放开扣住的判分请求，之后的判分照常回答。 */
  release(): void {
    this.holding = false;
    for (const resume of this.held.splice(0)) resume();
  }

  /** 正在被扣住的判分请求数。 */
  heldCount(): number {
    return this.held.length;
  }

  close(): Promise<void> {
    this.release();
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private async answer(body: string, response: import("node:http").ServerResponse): Promise<void> {
    const request = JSON.parse(body) as { messages?: ChatMessage[]; tools?: { function?: { name?: string } }[] };
    const messages = request.messages ?? [];
    const tools = (request.tools ?? []).map((tool) => tool.function?.name ?? "");
    const system = messages.filter((message) => message.role === "system" || message.role === "developer").map((message) => textOf(message.content)).join("\n");
    const prompt = textOf(messages.filter((message) => message.role === "user").at(-1)?.content);
    let reply: Step;
    if (tools.includes("submit_result") && system.startsWith("独立评价本题原答")) {
      if (this.holding) {
        this.log.push({ kind: "grade", note: "扣住" });
        const released = new Promise<void>((resolve) => this.held.push(resolve));
        // 后端放弃这次请求（关闭、取消）时连接断开，不再等。
        const aborted = new Promise<void>((resolve) => response.once("close", resolve));
        await Promise.race([released, aborted]);
        if (response.destroyed || response.writableEnded) return;
      }
      this.log.push({ kind: "grade", note: "判对" });
      reply = { tools: [{ name: "submit_result", arguments: { verdict: "correct", reason: "走查用的假模型判为正确。" } }] };
    } else if (tools.length === 0 && system.startsWith("你在独立解一道练习题")) {
      const answer = this.answers.get(prompt);
      this.log.push({ kind: "confirm", note: answer === undefined ? "没有查到这道题" : "查到了" });
      if (answer === undefined) this.unexpected.push(`课程核对的题面没有对应的答案：${prompt.slice(0, 200)}`);
      reply = { text: answer ?? "{\"answers\": {}}" };
    } else if (tools.includes("course_use")) {
      reply = this.agentStep(messages);
    } else {
      this.log.push({ kind: "other", note: system.slice(0, 120) });
      this.unexpected.push(`没有剧本的请求：系统提示开头「${system.slice(0, 80)}」，工具 ${tools.join("、") || "（无）"}`);
      reply = { text: "好。" };
    }
    this.stream(reply, response);
  }

  /** 通用 Agent 的一轮：最近一条用户消息定剧本，它之后已经回答过几次定第几步。 */
  private agentStep(messages: ChatMessage[]): Step {
    // 底座把视图（日期、空间说明等）也作为 user 消息放进上下文，以 <repa-view 开头；剧本按学习者自己最近的一条消息找。
    const lastUser = messages.findLastIndex((message) => message.role === "user" && !textOf(message.content).trimStart().startsWith("<repa-view"));
    const userText = lastUser < 0 ? "" : textOf(messages[lastUser]?.content);
    const script = this.scripts.find((entry) => userText.includes(entry.match));
    const after = messages.slice(lastUser + 1);
    const done = after.filter((message) => message.role === "assistant").length;
    // 上一次回答调用的工具的结果，排在消息末尾、最后一条 assistant 之后。
    const lastAssistant = messages.map((message) => message.role).lastIndexOf("assistant");
    const fresh = lastAssistant > lastUser ? messages.slice(lastAssistant + 1).filter((message) => message.role === "tool") : [];
    for (const message of fresh) {
      const id = (message as { tool_call_id?: string }).tool_call_id ?? "";
      this.toolResults.push({ tool: this.toolNames.get(id) ?? "", text: textOf(message.content) });
    }
    const toolResult = fresh.length === 0 ? undefined : fresh.map((message) => textOf(message.content)).join("\n---\n");
    if (!script) {
      this.log.push({ kind: "agent", note: `没有剧本：${userText.slice(0, 80)}` });
      this.unexpected.push(`通用 Agent 收到没有剧本的消息：${userText.slice(0, 200)}`);
      return { text: "好。" };
    }
    const step = script.steps[done] ?? { text: "好。" };
    this.log.push({ kind: "agent", note: `${script.match} 第 ${done + 1} 步`, ...(toolResult === undefined ? {} : { toolResult: toolResult.slice(0, 600) }) });
    return step;
  }

  /** 把一步写成 chat.completion.chunk 的流。 */
  private stream(step: Step, response: import("node:http").ServerResponse): void {
    const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({
      id: "verify", object: "chat.completion.chunk", created: 0, model: this.id,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if ("text" in step) {
      response.write(chunk({ role: "assistant", content: step.text }, null));
      response.write(chunk({}, "stop"));
    } else {
      const calls = step.tools.map((tool, index) => {
        const id = `call_${++this.calls}`;
        this.toolNames.set(id, tool.name);
        return { index, id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } };
      });
      response.write(chunk({ role: "assistant", tool_calls: calls }, null));
      response.write(chunk({}, "tool_calls"));
    }
    response.write(`data: ${JSON.stringify({ id: "verify", object: "chat.completion.chunk", created: 0, model: this.id, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  }
}
