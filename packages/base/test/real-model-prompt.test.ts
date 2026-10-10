import assert from "node:assert/strict";
import test from "node:test";

import { CHANGE_NOTICE, PROBE_PROMPT, probePrompt } from "../scripts/real-model/prompt.js";

test("对照沿用原问题，说明仅在指定轮次附加且不覆盖原问题", () => {
  assert.equal(probePrompt(), PROBE_PROMPT);
  assert.equal(probePrompt(false), PROBE_PROMPT);
  assert.equal(probePrompt(true), `${PROBE_PROMPT}\n${CHANGE_NOTICE}`);
  assert.equal(probePrompt(), PROBE_PROMPT);
});
