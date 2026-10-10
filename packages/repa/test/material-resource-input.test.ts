import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ExtractDataSchema } from "@repa/materials";
import { Check } from "typebox/value";
import { RepaClient } from "../src/client.js";
import { RepresentationSchema } from "../src/protocol.js";
import { startRepaServer } from "../src/server.js";

// 与材料包用例相同的两页有效PDF：xref使用真实字节偏移，调用实际Poppler。
function smallPdf(): Buffer {
  const streams = ["BT /F1 12 Tf 40 120 Td (First actual page) Tj ET", "BT /F1 12 Tf 40 120 Td (Second actual page) Tj ET"];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...streams.map(stream => `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`),
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

test("真实Pi按工具schema提取固定PDF资源第二页，模型收到原资源hash与实际页内容", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-material-resource-pi-"));
  const opened: {
    server?: Awaited<ReturnType<typeof startRepaServer>>;
    client?: RepaClient;
  } = {};
  t.after(async () => {
    try {
      await opened.server?.close("cancel");
    } finally {
      try {
        await opened.client?.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [],
    extensions: ["!**/*"],
    skills: ["!**/*"],
    prompts: ["!**/*"],
    themes: ["!**/*"],
    retry: { enabled: false },
    compaction: { enabled: false },
  }));
  const provider = fauxProvider({
    api: `material-resource-${randomUUID()}`,
    provider: `material-resource-${randomUUID()}`,
    models: [{
      id: "local",
      reasoning: false,
      input: ["text"],
      contextWindow: 32768,
      maxTokens: 1024,
    }],
    tokensPerSecond: 0,
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  const server = await startRepaServer({
    appDirectory: path.join(root, "app"),
    agentDir,
    modelOverride: { modelRuntime, model: provider.getModel() },
    bundledPackages: [{
      id: "repa-materials",
      directory: path.dirname(fileURLToPath(import.meta.resolve("@repa/materials/package.json"))),
      enabled: true,
    }],
  });
  opened.server = server;
  const client = await RepaClient.connect(server.connection);
  opened.client = client;
  const space = await client.call("space.open", { path: path.join(root, "space") });
  const uploaded = await client.uploadResource(space.id, smallPdf(), "application/pdf");
  const session = await client.call("session.create", { spaceId: space.id });
  const input = {
    target: { kind: "resource", resource: uploaded.resource },
    expectedBodyRevision: uploaded.resource.id,
    range: { kind: "pages", start: 2, end: 2 },
  };
  provider.setResponses([
    context => {
      const tool = getCurrentTools(context.messages).find(item => item.name === "read_material");
      assert(tool);
      assert(Check(tool.parameters, input), "真实provider工具schema必须接受固定资源分支");
      return fauxAssistantMessage(fauxToolCall("read_material", input), { stopReason: "toolUse" });
    },
    context => {
      const result = context.messages.findLast(message => message.role === "toolResult" && message.toolName === "read_material");
      assert(result?.role === "toolResult");
      assert.equal(result.isError, false);
      const text = result.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
      const representation: unknown = JSON.parse(text);
      assert(Check(RepresentationSchema, representation));
      assert.equal(representation.format.id, "repa.material-extraction");
      assert(representation.value.kind === "inline");
      assert(Check(ExtractDataSchema, representation.value.data));
      assert.match(representation.value.data.segments[0]?.text ?? "", /Second actual page/);
      assert.deepEqual(representation.value.data.segments[0]?.locator.value, { page: 2 });
      assert.deepEqual(representation.resources, [uploaded.resource]);
      assert.deepEqual(representation.sources, []);
      return fauxAssistantMessage("第二页原件已读，来源是固定资源。");
    },
  ]);
  const accepted = await client.call("session.submit", {
    target: { spaceId: space.id, sessionId: session.sessionId },
    requestId: randomUUID(),
    input: { parts: [{ kind: "text", text: "读这份已经保存的PDF原件第二页。" }] },
    selection: { tools: ["read_material"] },
    dispatch: { kind: "start" },
  });
  assert(accepted.runId);
  const deadline = Date.now() + 15000;
  for (;;) {
    const run = await client.call("run.get", { spaceId: space.id, runId: accepted.runId });
    if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
      assert.equal(run.status, "completed", JSON.stringify(run));
      break;
    }
    assert(Date.now() < deadline, JSON.stringify(run));
    await delay(10);
  }
  assert.equal(provider.state.callCount, 2);
});
