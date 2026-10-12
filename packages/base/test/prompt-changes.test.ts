import assert from "node:assert/strict";
import test from "node:test";

import { promptChangeNotice } from "../src/agent/prompts.js";
import { sectionName } from "../src/agent/views.js";

const section = (text: string) => ({ id: "plugin:notes", text, defaultText: text, enabled: true });

test("说明只摘出不同的完整行，保留新旧原文而不猜测语义", () => {
  const text = "共同说明\n后缀为 A。\n共同结尾";
  const messages = [{ role: "system", timestamp: 1, content: "Repa", sections: {
    [sectionName("plugin:notes")]: `<repa-instructions source="plugin:notes">\n${text}\n</repa-instructions>`,
  } }];
  const notice = promptChangeNotice(messages, [section(text.replace(" A", " B"))]);
  assert(notice);
  assert.match(notice, /后缀为 A。/u);
  assert.match(notice, /后缀为 B。/u);
  assert(!notice.includes("共同说明"));
  assert(!notice.includes("共同结尾"));
  assert.equal(promptChangeNotice(messages, [section(text)]), undefined);
});

test("首轮不需要变更说明，全部段停用后恢复仍说明新增有效段", () => {
  assert.equal(promptChangeNotice([], [section("新说明")]), undefined);
  const messages = [{ role: "system", timestamp: 1, content: "Repa" }];
  const notice = promptChangeNotice(messages, [section("新说明")]);
  assert(notice);
  assert.match(notice, /新说明/u);
});
