import { readFileSync } from "node:fs";

import type { Credential } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

export function selectProbeModel(provider = "openai-codex", id?: string) {
  if (provider !== "deepseek" && provider !== "openai-codex") throw new Error("unsupported_probe_provider");
  const catalog = provider === "deepseek" ? deepseekProvider() : openaiCodexProvider();
  const modelId = id ?? (provider === "deepseek" ? "deepseek-flash" : "gpt-6-luna");
  const model = catalog.getModels().find(item => item.id === modelId);
  if (!model) throw new Error("model_not_in_locked_catalog");
  return model;
}

export function probeAuth(provider: string, credential: Credential | undefined, skipRefresh: boolean) {
  const expected = provider === "deepseek" ? "api_key" : "oauth";
  if (credential?.type !== expected) throw new Error("probe_credential_required");
  let refreshStatus = "required";
  if (credential.type === "api_key") refreshStatus = "not-applicable-api-key";
  else if (skipRefresh) refreshStatus = "skipped";
  return {
    credentialType: credential.type,
    refresh: credential.type === "oauth" && !skipRefresh,
    refreshStatus,
  };
}

// 读当前安装版本，升级后复跑时不把新结果误标成旧基线。
export function installedPiVersion(): string {
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const metadata: unknown = JSON.parse(readFileSync(new URL("../package.json", entry), "utf8"));
  if (metadata === null || typeof metadata !== "object" || !("version" in metadata) || typeof metadata.version !== "string") {
    throw new Error("pi_version_unavailable");
  }
  return metadata.version;
}
