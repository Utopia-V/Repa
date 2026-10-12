import assert from "node:assert/strict";
import test from "node:test";
import { prepareItem } from "../src/ask.js";
import { contentVersion, requiredCapabilities, type ItemDraft } from "../src/interaction.js";
import { RepaFault } from "../src/schema.js";

const fault = (code: string) => (error: unknown): boolean => error instanceof RepaFault && error.code === code;

const YES_NO = { type: "choice" as const, options: [{ id: "yes", label: "是" }, { id: "no", label: "否" }] };
// 健康插件的服药打卡。
const checkinDraft: ItemDraft = {
  id: "health.medicine",
  body: [{ type: "markdown", text: "今天按时服药了吗？" }],
  slots: [{
    id: "taken",
    type: "table",
    columns: [{ id: "time", header: "时间" }, { id: "taken", header: "已服" }],
    rows: [{ id: "morning", cells: { time: { value: "早饭后" }, taken: { input: YES_NO } } }],
  }],
};

test("交给询问的 Item 补上 version 与 requires：插件算好的版本原样保留，没有时对公开内容计算", async () => {
  const prepared = await prepareItem(checkinDraft);
  assert.deepEqual(prepared, { ...checkinDraft, version: await contentVersion(checkinDraft), requires: requiredCapabilities(checkinDraft) });
  const supplied = `sha256:${"a".repeat(64)}`;
  assert.equal((await prepareItem({ ...checkinDraft, version: supplied })).version, supplied);
  assert.deepEqual(await prepareItem({ ...checkinDraft, version: prepared.version, requires: prepared.requires }), prepared);
});

test("整理 Item 时拒绝多带的字段、手写错的 requires 和 schema 管不到的不一致", async () => {
  await assert.rejects(prepareItem({ ...checkinDraft, reminder: "21:00" } as ItemDraft), fault("invalid_item"));
  await assert.rejects(prepareItem({ ...checkinDraft, requires: ["slot.table"] }), fault("invalid_item"));
  const duplicated: ItemDraft = { ...checkinDraft, slots: [...checkinDraft.slots, { id: "taken", type: "text" }] };
  await assert.rejects(prepareItem(duplicated), (error: unknown) => {
    assert.ok(error instanceof RepaFault);
    assert.equal(error.code, "invalid_item");
    assert.deepEqual(error.details, { problems: ["作答位里的 id 重复：taken"] });
    return true;
  });
  const table = checkinDraft.slots[0];
  assert(table?.type === "table");
  const strayCell: ItemDraft = { ...checkinDraft, slots: [{ ...table, rows: [{ id: "r1", cells: { missing: { value: "1" } } }] }] };
  await assert.rejects(prepareItem(strayCell), fault("invalid_item"));
  const impossible: ItemDraft = { id: "demo.choice", body: [], slots: [{ id: "c", type: "choice", multiple: true, minSelected: 3, options: [{ id: "a", content: [] }, { id: "b", content: [] }] }] };
  await assert.rejects(prepareItem(impossible), fault("invalid_item"));
});
