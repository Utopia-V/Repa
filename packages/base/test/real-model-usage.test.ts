import assert from "node:assert/strict";
import test from "node:test";

import { usageMatches } from "../scripts/real-model/usage.js";

test("压缩的两次请求与一个汇总条目按合计核对，而不是按请求数误报", () => {
  assert.equal(usageMatches([
    { input: 527, output: 251, cached: 0, cacheWrite: 0 },
    { input: 235, output: 85, cached: 0, cacheWrite: 0 },
  ], [{ input: 762, output: 336, cacheRead: 0, cacheWrite: 0 }]), true);
});

test("缓存输入只计一次，缺少原始输入或用量不一致时核对失败", () => {
  const saved = [{ input: 100, output: 9, cacheRead: 1000, cacheWrite: 20 }];
  assert.equal(usageMatches([{ input: 1120, output: 9, cached: 1000, cacheWrite: 20 }], saved), true);
  assert.equal(usageMatches([{ input: 1120, output: 9, cached: 1000, cacheWrite: null }], saved), true);
  assert.equal(usageMatches([{ input: null, output: 9, cached: 1000, cacheWrite: 20 }], saved), false);
  assert.equal(usageMatches([{ input: 1120, output: 8, cached: 1000, cacheWrite: 20 }], saved), false);
  assert.equal(usageMatches([], []), false);
});
