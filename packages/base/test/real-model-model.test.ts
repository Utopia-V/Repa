import assert from "node:assert/strict";
import test from "node:test";

import { installedPiVersion, probeAuth, selectProbeModel } from "../scripts/real-model/model.js";

test("默认仍选 Codex，DeepSeek 可选两种目录模型且拒绝未知提供方和模型", () => {
  assert.equal(selectProbeModel().provider, "openai-codex");
  assert.equal(selectProbeModel().id, "gpt-6-luna");
  assert.equal(selectProbeModel("deepseek").id, "deepseek-flash");
  assert.equal(selectProbeModel("deepseek", "deepseek-v4-pro").id, "deepseek-v4-pro");
  assert.throws(() => selectProbeModel("unknown"), /unsupported_probe_provider/u);
  assert.throws(() => selectProbeModel("deepseek", "unknown"), /model_not_in_locked_catalog/u);
  assert.match(installedPiVersion(), /^\d+\.\d+\.\d+/u);
});

test("API key 无刷新步骤，Codex 的 OAuth 刷新和显式跳过含义保持不变", () => {
  assert.deepEqual(probeAuth("deepseek", { type: "api_key", key: "fixture" }, false), {
    credentialType: "api_key", refresh: false, refreshStatus: "not-applicable-api-key",
  });
  const oauth = { type: "oauth" as const, access: "fixture", refresh: "fixture", expires: 0 };
  assert.equal(probeAuth("openai-codex", oauth, false).refresh, true);
  assert.equal(probeAuth("openai-codex", oauth, true).refreshStatus, "skipped");
  assert.throws(() => probeAuth("deepseek", oauth, false), /probe_credential_required/u);
  assert.throws(() => probeAuth("openai-codex", undefined, false), /probe_credential_required/u);
});
