import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Check } from "typebox/value";
import { executionRepresentation } from "../src/execution/format.js";
import { ExecutionViewSchema } from "../src/execution/schema.js";
import { RepresentationSchema, type Input } from "../src/requests/schema.js";
import { remapInput } from "../src/requests/store.js";

// 固定兼容样本保留旧执行结果的额外资源字段，不驱动已经退役的程序通道。
test("旧执行结果继续读取额外资源，空间复制同时映射标准表示、日志和旧资源归属", async () => {
  const raw: unknown = JSON.parse(await readFile(new URL("./fixtures/execution-legacy-resources.json", import.meta.url), "utf8"));
  assert(Check(RepresentationSchema, raw));
  assert.equal(raw.value.kind, "inline");
  if (raw.value.kind !== "inline") assert.fail("历史执行样本应是内联结果");
  assert(Check(ExecutionViewSchema, raw.value.data));
  assert.deepEqual(executionRepresentation(raw.value.data).resources, raw.resources);
  const input: Input = { parts: [{ kind: "data", representation: structuredClone(raw) }] };
  remapInput(input, "source-space", "copied-space");
  const part = input.parts[0];
  assert(part?.kind === "data");
  const copied = part.representation;
  assert(copied.value.kind === "inline");
  assert(Check(ExecutionViewSchema, copied.value.data));
  const execution = copied.value.data;
  assert.equal(execution.spaceId, "copied-space");
  assert(execution.source.kind === "agent");
  assert.equal(execution.source.spaceId, "copied-space");
  assert.equal(execution.fullOutput?.spaceId, "copied-space");
  assert.deepEqual(execution.resources?.map(resource => resource.spaceId), ["copied-space", "other-space"]);
  assert.deepEqual(copied.resources.map(resource => resource.spaceId), ["copied-space", "copied-space", "other-space"]);
  assert.equal(execution.command, raw.value.data.command);
  assert.equal(execution.cwd, raw.value.data.cwd);
  assert.equal(raw.value.data.spaceId, "source-space");
  assert.deepEqual(raw.resources.map(resource => resource.spaceId), ["source-space", "source-space", "other-space"]);
});
