import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ApiKeyCredential, AuthContext, AuthResult, Provider, ProviderEnv, StreamOptions } from "@earendil-works/pi-ai";
import { RepaFault } from "../errors.js";

const AMBIENT_LOGIN_METHODS = new Map([
  ["google-vertex", "adc"],
  ["amazon-bedrock", "credential-chain"],
]);

function credentialContext(credential: ApiKeyCredential | undefined): AuthContext {
  return {
    env: async () => undefined,
    fileExists: async (file) => {
      // 只检查本槽位明确保存的路径，不读取 SDK 的默认 ADC 或其他 ambient 文件。
      if (!credential?.env || !Object.values(credential.env).includes(file)) return false;
      const resolved = file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file;
      try {
        return (await stat(resolved)).isFile();
      } catch (error) {
        if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code))) return false;
        throw error;
      }
    },
  };
}

export function assertCredentialEnvironment(providerId: string, result: AuthResult): void {
  if (providerId === "amazon-bedrock") assertBedrockProfileEnvironment(result.env, result.auth.apiKey);
}

function assertBedrockProfileEnvironment(env: ProviderEnv | undefined, apiKey: string | undefined): void {
  // Pi 0.87.1 的 env helper 使用 ||；空 scoped 值不能屏蔽 ambient bearer。
  // 在公开适配器支持“明确无 bearer”之前拒绝冲突，不能替换进程环境或伪造 token。
  if (env?.AWS_PROFILE && !apiKey && process.env.AWS_BEARER_TOKEN_BEDROCK)
    throw new RepaFault("auth_environment_conflict", "当前环境的 AWS_BEARER_TOKEN_BEDROCK 会覆盖所选 AWS profile。请改用显式 API key 连接，或以不含该变量的环境启动。");
}

function bedrockOptions<T extends StreamOptions>(options: T): T {
  return { ...options, env: { ...options.env, AWS_BEDROCK_SKIP_AUTH: "0" } };
}

/** 保留 SDK 的登录与刷新，只把具名连接的认证解析限制在所选槽位。 */
export function credentialProvider(provider: Provider): Provider {
  const apiKey = provider.auth.apiKey;
  if (!apiKey) return provider;
  const login = apiKey.login;
  const check = apiKey.check;
  const blocked = AMBIENT_LOGIN_METHODS.get(provider.id);
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        ...apiKey,
        ...(login && blocked ? { login: async (interaction) => {
          interaction.notify({ type: "info", message: provider.id === "google-vertex"
            ? "具名 Vertex 连接不使用默认 ADC 身份，请选择显式 API key 或 service-account 凭据文件。"
            : "具名 Bedrock 连接不使用未固定的 ambient credential chain，请选择 bearer token 或明确的 AWS profile。" });
          const credential = await login({
            ...interaction,
            prompt: (prompt) => interaction.prompt(prompt.type === "select"
              ? { ...prompt, options: prompt.options.filter((option) => option.id !== blocked) }
              : prompt),
          });
          const resolved = await apiKey.resolve({ credential, ctx: credentialContext(credential), signal: interaction.signal });
          if (!resolved) throw new RepaFault("auth_required", "所选认证尚不可用，请检查显式凭据文件或认证信息。");
          return credential;
        } } : {}),
        ...(check ? { check: (input) => input.credential
          ? check({ ...input, ctx: credentialContext(input.credential) })
          : Promise.resolve(undefined) } : {}),
        resolve: async (input) => {
          if (!input.credential) return undefined;
          const result = await apiKey.resolve({ ...input, ctx: credentialContext(input.credential) });
          if (!result || provider.id !== "amazon-bedrock") return result;
          return { ...result, env: { ...result.env, AWS_BEDROCK_SKIP_AUTH: "0" } };
        },
      },
    },
    ...(provider.id === "amazon-bedrock" ? {
      stream: (model, context, options) => {
        assertBedrockProfileEnvironment(options?.env, options?.apiKey);
        return provider.stream(model, context, options ? bedrockOptions(options) : options);
      },
      streamSimple: (model, context, options) => {
        assertBedrockProfileEnvironment(options?.env, options?.apiKey);
        return provider.streamSimple(model, context, options ? bedrockOptions(options) : options);
      },
    } : {}),
  };
}
