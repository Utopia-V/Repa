import assert from "node:assert/strict";
import test from "node:test";
import { prepareItem } from "../src/ask.js";
import { contentVersion, requiredCapabilities, type ItemDraft } from "../src/interaction.js";
import { RepaFault } from "../src/schema.js";

const fault = (code: string) => (error: unknown): boolean => error instanceof RepaFault && error.code === code;

const BOOL = { type: "choice" as const, options: [{ id: "true", label: "True" }, { id: "false", label: "False" }] };
const maskDraft: ItemDraft = {
  id: "py17.k1.q1",
  body: [{ type: "markdown", text: "按原行索引填写 `mask` 的值。" }],
  slots: [{
    id: "mask",
    type: "table",
    columns: [{ id: "index", header: "原行索引" }, { id: "mask", header: "mask" }],
    rows: [{ id: "r31", cells: { index: { value: "31" }, mask: { input: BOOL } } }],
  }],
};

test("交给询问的题目补上 version 与 requires：插件算好的版本原样保留，没有时对公开内容计算", async () => {
  const prepared = await prepareItem(maskDraft);
  assert.deepEqual(prepared, { ...maskDraft, version: await contentVersion(maskDraft), requires: requiredCapabilities(maskDraft) });
  const supplied = `sha256:${"a".repeat(64)}`;
  assert.equal((await prepareItem({ ...maskDraft, version: supplied })).version, supplied);
  assert.deepEqual(await prepareItem({ ...maskDraft, version: prepared.version, requires: prepared.requires }), prepared);
});

test("整理题目时拒绝多带的答案字段、手写错的 requires 和 schema 管不到的不一致", async () => {
  await assert.rejects(prepareItem({ ...maskDraft, answer: "false" } as ItemDraft), fault("invalid_item"));
  await assert.rejects(prepareItem({ ...maskDraft, requires: ["slot.table"] }), fault("invalid_item"));
  const duplicated: ItemDraft = { ...maskDraft, slots: [...maskDraft.slots, { id: "mask", type: "text" }] };
  await assert.rejects(prepareItem(duplicated), (error: unknown) => {
    assert.ok(error instanceof RepaFault);
    assert.equal(error.code, "invalid_item");
    assert.deepEqual(error.details, { problems: ["作答位里的 id 重复：mask"] });
    return true;
  });
  const table = maskDraft.slots[0];
  assert(table?.type === "table");
  const strayCell: ItemDraft = { ...maskDraft, slots: [{ ...table, rows: [{ id: "r1", cells: { missing: { value: "1" } } }] }] };
  await assert.rejects(prepareItem(strayCell), fault("invalid_item"));
  const impossible: ItemDraft = { id: "demo.choice", body: [], slots: [{ id: "c", type: "choice", multiple: true, minSelected: 3, options: [{ id: "a", content: [] }, { id: "b", content: [] }] }] };
  await assert.rejects(prepareItem(impossible), fault("invalid_item"));
});
