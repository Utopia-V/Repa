import assert from "node:assert/strict";
import test from "node:test";

import { checkProbeReply } from "../scripts/real-model/answer.js";

test("回复判断分开记录过时状态、过时后缀和格式错误，不保存正文", () => {
  assert.deepEqual(checkProbeReply("CHECK_2|B\n", 2, "B"), {
    replyMatches: true, replyFormatMatches: true, versionMatches: true, suffixMatches: true,
  });
  assert.deepEqual(checkProbeReply("CHECK_2|A", 2, "B"), {
    replyMatches: false, replyFormatMatches: true, versionMatches: true, suffixMatches: false,
  });
  assert.deepEqual(checkProbeReply("CHECK_1|B", 2, "B"), {
    replyMatches: false, replyFormatMatches: true, versionMatches: false, suffixMatches: true,
  });
  for (const value of [undefined, "私密回复", "CHECK_2 | B"]) {
    assert.deepEqual(checkProbeReply(value, 2, "B"), {
      replyMatches: false, replyFormatMatches: false, versionMatches: null, suffixMatches: null,
    });
  }
});
