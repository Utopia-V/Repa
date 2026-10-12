import assert from "node:assert/strict";
import test from "node:test";

import { probeOptions } from "../scripts/real-model/options.js";

test("核实默认沿用完整场景并开启底座通用说明", () => {
  assert.deepEqual(probeOptions({}), { scenario: "full", notice: "generic" });
});

test("限定覆盖场景可分别选择无说明、通用说明和原实验具体说明", () => {
  for (const notice of ["none", "generic", "specific"]) {
    assert.deepEqual(probeOptions({ scenario: "prompt-change", notice }), { scenario: "prompt-change", notice });
  }
  assert.deepEqual(probeOptions({ changeNotice: true }), { scenario: "full", notice: "specific" });
  assert.deepEqual(probeOptions({ notice: "specific", changeNotice: true }), { scenario: "full", notice: "specific" });
});

test("核实拒绝未知模式及互相冲突的说明选项", () => {
  assert.throws(() => probeOptions({ scenario: "invalid" }), /unsupported_probe_scenario/u);
  assert.throws(() => probeOptions({ notice: "invalid" }), /unsupported_probe_notice/u);
  assert.throws(() => probeOptions({ notice: "none", changeNotice: true }), /conflicting_probe_notice/u);
});
