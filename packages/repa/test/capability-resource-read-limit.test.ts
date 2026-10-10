import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Type } from "typebox";
import type { RepaCapabilityServices } from "../src/capabilities/services.js";
import type { CapabilityDefinition } from "../src/capabilities/types.js";
import { RepaClient, RpcError } from "../src/client.js";
import { ResourceRefSchema, type ResourceRef } from "../src/content/schema.js";
import { object } from "../src/schema.js";
import { startRepaServer } from "../src/server.js";

const fault = (code: string) => (error: unknown) => error instanceof RpcError &&
  error.data !== null && typeof error.data === "object" && "code" in error.data && error.data.code === code;

test("实际能力服务将资源限额透传至blob读取，原无限额与跨空间拒绝不变", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-capability-read-limit-"));
  let closeServer = async () => {};
  let closeClient = async () => {};
  t.after(async () => {
    try {
      await closeServer();
    } finally {
      try {
        await closeClient();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  const contract = { id: "fixture.resource.read-limit", version: "1" };
  const inputSchema = object({
    resource: ResourceRefSchema,
    maxBytes: Type.Optional(Type.Number()),
    options: Type.Optional(Type.Unknown()),
  });
  const outputSchema = Type.String();
  const definition: CapabilityDefinition<typeof inputSchema, typeof outputSchema, RepaCapabilityServices> = {
    contract,
    implementationId: "fixture",
    inputSchema,
    outputSchema,
    scopes: ["space"],
    execution: "inline",
    async invoke(input, context) {
      assert(context.services?.resources);
      if (Object.hasOwn(input, "options")) {
        // 模拟JavaScript插件误传options，不用类型断言绕开运行时边界。
        const bytes: unknown = await Reflect.apply(context.services.resources.read, context.services.resources, [input.resource, input.options]);
        assert(bytes instanceof Uint8Array);
        return new TextDecoder().decode(bytes);
      }
      const options = input.maxBytes === undefined ? undefined : { maxBytes: input.maxBytes };
      return new TextDecoder().decode(await context.services.resources.read(input.resource, options));
    },
  };
  const server = await startRepaServer({
    agentDir: path.join(root, "agent"),
    appDirectory: path.join(root, "app"),
    plugins: [{ id: "read-limit-fixture", enabled: true, factory: () => ({ capabilities: [definition] }) }],
  });
  closeServer = () => server.close("cancel");
  const client = await RepaClient.connect(server.connection);
  closeClient = () => client.close();
  const space = await client.call("space.open", { path: path.join(root, "space") });
  const other = await client.call("space.open", { path: path.join(root, "other") });
  const text = "固定能力资源\r\n";
  const bytes = Buffer.from(text);
  const uploaded = await client.uploadResource(space.id, bytes, "text/plain");
  const invoke = (resource: ResourceRef, maxBytes?: number, options?: unknown) => client.call("capability.invoke", {
    scope: { kind: "space", spaceId: space.id },
    requestId: randomUUID(),
    contract,
    input: {
      resource,
      ...(maxBytes === undefined ? {} : { maxBytes }),
      ...(options === undefined ? {} : { options }),
    },
  });
  for (const limit of [undefined, bytes.length, bytes.length + 1]) {
    const result = await invoke(uploaded.resource, limit);
    assert.equal(result.kind, "inline");
    if (result.kind !== "inline") assert.fail("预期即时能力结果");
    assert.equal(result.result, text);
  }
  await assert.rejects(invoke(uploaded.resource, bytes.length - 1), fault("content_limit"));
  await assert.rejects(invoke(uploaded.resource, 0), fault("invalid_input"));
  for (const options of [{}, null, { maxBytes: "1" }, { maxBytes: -1 }]) {
    await assert.rejects(invoke(uploaded.resource, undefined, options), fault("invalid_input"));
  }
  await assert.rejects(invoke({ ...uploaded.resource, spaceId: other.id }, bytes.length), fault("permission_required"));
  await assert.rejects(invoke({ ...uploaded.resource, spaceId: other.id }), fault("permission_required"));
});
