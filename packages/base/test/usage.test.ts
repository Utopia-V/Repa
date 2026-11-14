import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAgentRuntimeForTest } from "../src/agent/runtime.js";
import type { AgentSpaceOptions } from "../src/agent.js";
import type { SessionEntry, Usage } from "../src/schema.js";

/** 有单价的模型（美元每百万 token）与没有单价的模型。 */
const PRICE = { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2.5 };

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-usage-")));
  const agentDir = path.join(root, "app", "agent");
  const sessionsDir = path.join(root, ".repa", "sessions");
  await mkdir(agentDir, { recursive: true });
  const faux = fauxProvider({
    api: `usage-${randomUUID()}`, provider: `usage-${randomUUID()}`, tokensPerSecond: 0,
    models: [{ id: "priced", contextWindow: 16384, maxTokens: 512, cost: PRICE }, { id: "free", contextWindow: 16384, maxTokens: 512 }],
  });
  const models = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  models.registerNativeProvider(faux.provider);
  const runtime = await createAgentRuntimeForTest({
    agentDir, modelRuntime: models, defaultModel: { provider: faux.getModel().provider, id: "priced" },
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
  });
  const options: AgentSpaceOptions = {
    root, sessionsDir, instructions: () => [], tools: () => [], views: async () => [],
    overrides: async () => ({ app: {}, space: {} }), commandPolicy: () => "fullAccess",
    record: async (_id, action) => action(), onEvent: () => undefined, confirm: async () => true,
  };
  const space = await runtime.openSpace(options);
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, faux, runtime, space, options, provider: faux.getModel().provider };
}

function add(total: Usage, usage: Usage): void {
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) total[key] += usage[key];
}

/** 会话历史里各次请求的用量：每条助手消息一次。 */
function requests(history: SessionEntry[]): { model: string; usage: Usage }[] {
  return history.flatMap((entry) => {
    if (entry.type !== "assistant" || !entry.usage) return [];
    const data = entry.data as { model: string };
    return [{ model: data.model, usage: entry.usage }];
  });
}

test("会话的累计用量等于各次请求之和；有单价的按模型目录折算金额，没有单价的只计 token；从会话文件读出的也一样", async (t) => {
  const f = await fixture(t);
  const session = await f.space.create();
  f.faux.setResponses([fauxAssistantMessage("一"), fauxAssistantMessage("二"), fauxAssistantMessage("三")]);
  await session.send("第一个问题，长一点长一点长一点");
  await session.send("第二个问题");
  await session.setModel({ provider: f.provider, id: "free" });
  await session.send("第三个问题，换了没有单价的模型");

  /** 按各次请求算出的累计值：token 逐项相加，有单价的请求按单价折成金额。 */
  const expected = (histories: SessionEntry[][]) => {
    const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const unpriced: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let cost = 0;
    const seen = histories.flatMap(requests);
    for (const request of seen) {
      add(usage, request.usage);
      if (request.model === "free") {
        add(unpriced, request.usage);
      } else {
        const { input, output, cacheRead, cacheWrite } = request.usage;
        cost += (input * PRICE.input + output * PRICE.output + cacheRead * PRICE.cacheRead + cacheWrite * PRICE.cacheWrite) / 1_000_000;
      }
    }
    return { requests: seen.length, usage, unpriced, cost };
  };
  const check = (actual: Awaited<ReturnType<typeof f.space.usage>>, histories: SessionEntry[][]) => {
    const want = expected(histories);
    assert.deepEqual({ ...actual, cost: 0 }, { ...want, cost: 0 });
    assert.ok(Math.abs(actual.cost - want.cost) < 1e-12, `${actual.cost} ≠ ${want.cost}`);
  };
  const first = expected([session.history()]);
  assert.equal(first.requests, 3);
  assert.ok(first.cost > 0 && first.usage.input > 0 && first.usage.output > 0 && first.unpriced.input > 0);
  assert.ok(first.unpriced.input < first.usage.input);

  const id = session.info().id;
  check(await f.space.usage([id]), [session.history()]);
  // 同一会话写两次只算一次。
  check(await f.space.usage([id, id]), [session.history()]);

  // 另一个会话加进来就是两份之和；关掉空间以后从会话文件读，结果相同。
  const other = await f.space.create();
  f.faux.setResponses([fauxAssistantMessage("四")]);
  await other.send("另一个会话");
  check(await f.space.usage([id, other.info().id]), [session.history(), other.history()]);
  const history = session.history();
  await f.space.close();
  const reopened = await f.runtime.openSpace(f.options);
  check(await reopened.usage([id]), [history]);
  await assert.rejects(reopened.usage([randomUUID()]), (error: unknown) => error instanceof Error && "code" in error && error.code === "session_not_found");
});
