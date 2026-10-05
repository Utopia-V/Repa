// @vitest-environment node
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { connectionProxy } from "./helpers/connection-proxy";
import { assistantText, deferredText, observeSession, processAlive, withWebBackend } from "./helpers/web-backend";

const settling = { timeout: 8000 };

it("Web 宿主交付真实连接，订阅收到分段回复和完成状态，最后一个客户端退出后结束后端", async () => {
  await withWebBackend(async f => {
    expect(await f.client.call("space.list", {})).toEqual([f.space]);
    const session = await observeSession(f.client, f.space.id);
    const tail = deferredText();
    f.model.enqueue({ kind: "text", chunks: ["先看定义，", tail.promise] });
    const request = await session.submit("请解释集合");

    await expect.poll(() => assistantText(session.view()), settling).toBe("先看定义，");
    expect(session.view().runs.find(run => run.id === request.runId)?.status).toBe("running");
    expect(session.view().messages.some(message => message.streaming)).toBe(true);
    expect(session.changes).toContainEqual(expect.objectContaining({ type: "delta", kind: "text", text: "先看定义，" }));

    tail.resolve("再看例子。");
    await expect.poll(() => session.view().runs.find(run => run.id === request.runId)?.status, settling).toBe("completed");
    expect(assistantText(session.view())).toBe("先看定义，再看例子。");
    expect(session.view().messages.some(message => message.streaming)).toBe(false);
    expect(session.view().messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(session.view().messages.filter(message => message.role === "assistant")).toHaveLength(1);
    expect(f.model.requests).toHaveLength(1);
    expect(f.model.requests[0]?.body.messages).toContainEqual(expect.objectContaining({
      role: "user", content: [{ type: "text", text: "请解释集合" }],
    }));
    const history = await f.client.call("session.history", session.target);
    expect(assistantText({ ...session.view(), messages: history.messages })).toBe("先看定义，再看例子。");

    await f.client.close();
    await expect.poll(() => !processAlive(f.pid) && !existsSync(f.connectionFile), settling).toBe(true);
  });
}, 30_000);

it("本地模型发出的工具调用由真实 Agent 执行，工具结果进入下一次模型请求", async () => {
  await withWebBackend(async f => {
    const session = await observeSession(f.client, f.space.id);
    f.model.enqueue(
      { kind: "tool", name: "write", arguments: { path: "集合.md", content: "集合中的元素互不相同。\n" } },
      { kind: "text", chunks: ["笔记已保存。"] },
    );
    const request = await session.submit("把集合的定义保存为笔记");
    await expect.poll(() => session.view().runs.find(run => run.id === request.runId)?.status, settling).toBe("completed");

    expect(await readFile(path.join(f.space.path, "集合.md"), "utf8")).toBe("集合中的元素互不相同。\n");
    expect(assistantText(session.view())).toBe("笔记已保存。");
    const tools = session.changes.filter(change => change.type === "tool");
    expect(tools.map(tool => tool.status)).toEqual(["running", "completed"]);
    expect(tools[0]).toMatchObject({ name: "write", runId: request.runId });
    expect(tools[1]?.callId).toBe(tools[0]?.callId);
    expect(f.model.requests).toHaveLength(2);
    expect(f.model.requests[1]?.body.messages.filter(message => message.role === "tool")).toHaveLength(1);
    expect(session.view().messages.filter(message => message.role === "tool")).toHaveLength(1);
  });
}, 30_000);

it("取消流式回复后收到 cancelled 终态，并中断仍在等待的模型连接", async () => {
  await withWebBackend(async f => {
    const session = await observeSession(f.client, f.space.id);
    f.model.enqueue({ kind: "text", chunks: ["尚未写完", deferredText().promise] });
    const request = await session.submit("等待取消");
    await expect.poll(() => assistantText(session.view()), settling).toBe("尚未写完");

    await f.client.call("run.cancel", { spaceId: f.space.id, runId: request.runId });
    await expect.poll(() => session.view().runs.find(run => run.id === request.runId)?.status, settling).toBe("cancelled");
    await expect.poll(() => f.model.requests[0]?.closed, settling).toBe(true);
    expect(f.model.requests[0]?.finished).toBe(false);
    expect(f.model.requests).toHaveLength(1);
    expect(session.view().messages.some(message => message.streaming)).toBe(false);
    expect(await f.client.call("request.get", { spaceId: f.space.id, requestId: request.requestId })).toMatchObject({ status: "cancelled" });
  });
}, 30_000);

it("模型 HTTP 错误通过订阅交付可识别的失败状态", async () => {
  await withWebBackend(async f => {
    const session = await observeSession(f.client, f.space.id);
    f.model.enqueue({ kind: "error", status: 400, message: "invalid local input" });
    const request = await session.submit("触发预设错误");
    await expect.poll(() => session.view().runs.find(run => run.id === request.runId)?.status, settling).toBe("failed");

    expect(session.view().runs.find(run => run.id === request.runId)?.error?.code).toBe("provider");
    expect(f.model.requests).toHaveLength(1);
    expect(session.view().messages.some(message => message.streaming)).toBe(false);
    expect(await f.client.call("request.get", { spaceId: f.space.id, requestId: request.requestId })).toMatchObject({
      status: "failed", error: { code: "provider" },
    });
  });
}, 30_000);

it("真实连接中断期间后端继续完成回复，客户端自动重连后补齐消息且不重复", async () => {
  await withWebBackend(async f => {
    const proxy = await connectionProxy(f.connection);
    try {
      const client = await f.connect(proxy.connection);
      const states: boolean[] = [];
      const stopObserving = client.onConnectionChange(connected => { states.push(connected); });
      try {
        const hostKey = client.hostKey;
        const session = await observeSession(client, f.space.id);
        const tail = deferredText();
        f.model.enqueue({ kind: "text", chunks: ["首段", tail.promise] });
        const request = await session.submit("在断线期间完成");
        await expect.poll(() => assistantText(session.view()), settling).toBe("首段");

        proxy.disconnect();
        await expect.poll(() => client.connected, settling).toBe(false);
        tail.resolve("末段");
        await expect.poll(async () => (await f.client.call("run.get", { spaceId: f.space.id, runId: request.runId })).status, settling).toBe("completed");
        expect(client.connected).toBe(false);

        proxy.reconnect();
        await expect.poll(() => client.connected, settling).toBe(true);
        await expect.poll(() => session.view().runs.find(run => run.id === request.runId)?.status, settling).toBe("completed");
        expect(assistantText(session.view())).toBe("首段末段");
        expect(session.view().messages.filter(message => message.role === "assistant")).toHaveLength(1);
        expect(session.view().messages.filter(message => message.role === "user")).toHaveLength(1);
        expect(session.view().runs).toHaveLength(1);
        expect(f.model.requests).toHaveLength(1);
        expect(client.hostKey).toBe(hostKey);
        expect(states).toEqual([false, true]);
      } finally {
        stopObserving();
        await client.close();
      }
    } finally {
      await proxy.close();
    }
  });
}, 30_000);

it("夹具隔离应用配置和 Pi 凭据，断言失败时也关闭等待中的服务并清理目录", async () => {
  const personal = await mkdtemp(path.join(os.tmpdir(), "repa-web-personal-"));
  const sentinel = "本机配置与凭据占位，不应读取或改写";
  const failure = new Error("测试断言失败");
  let directory = "";
  let pid = 0;
  let modelUrl = "";
  try {
    const config = path.join(personal, "config");
    const agent = path.join(personal, "agent");
    await mkdir(path.join(config, "repa"), { recursive: true });
    await mkdir(agent);
    await writeFile(path.join(config, "repa", "repa-settings.json"), sentinel);
    await writeFile(path.join(agent, "auth.json"), sentinel);
    vi.stubEnv("HOME", personal);
    vi.stubEnv("XDG_CONFIG_HOME", config);
    vi.stubEnv("PI_CODING_AGENT_DIR", agent);
    await expect(withWebBackend(async f => {
      directory = f.directory;
      pid = f.pid;
      modelUrl = f.model.baseUrl;
      expect(f.appDirectory.startsWith(`${directory}${path.sep}`)).toBe(true);
      expect(f.agentDirectory.startsWith(`${directory}${path.sep}`)).toBe(true);
      expect(existsSync(path.join(f.appDirectory, "models", "connections.json"))).toBe(true);
      const session = await observeSession(f.client, f.space.id);
      f.model.enqueue({ kind: "text", chunks: ["等待结束", deferredText().promise] });
      await session.submit("让清理覆盖未完成的请求");
      await expect.poll(() => assistantText(session.view()), settling).toBe("等待结束");
      throw failure;
    })).rejects.toBe(failure);

    assert(directory && pid && modelUrl);
    expect(existsSync(directory)).toBe(false);
    expect(processAlive(pid)).toBe(false);
    await expect(fetch(modelUrl)).rejects.toThrow();
    expect(process.env.HOME).toBe(personal);
    expect(process.env.XDG_CONFIG_HOME).toBe(config);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(agent);
    expect(await readdir(path.join(config, "repa"))).toEqual(["repa-settings.json"]);
    expect(await readdir(agent)).toEqual(["auth.json"]);
    expect(await readFile(path.join(config, "repa", "repa-settings.json"), "utf8")).toBe(sentinel);
    expect(await readFile(path.join(agent, "auth.json"), "utf8")).toBe(sentinel);
  } finally {
    vi.unstubAllEnvs();
    await rm(personal, { recursive: true, force: true });
  }
}, 30_000);
