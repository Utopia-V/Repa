// 反馈包离开用户电脑之前，凭据必须替换掉；对话、工具调用和路径保持原样，定位问题要靠它们。

// 已知密钥短于这个长度时不逐字替换：太短的值会误伤普通文字，凭据也不会这么短。
const MIN_SECRET = 8;
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/iu;

// 兜住用户自己贴进对话、没有保存在 Repa 里的凭据。
const PATTERNS: { kind: string; pattern: RegExp; keep?: string }[] = [
  { kind: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu },
  { kind: "api-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/gu },
  { kind: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/gu },
  { kind: "github-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/gu },
  { kind: "aws-key", pattern: /\bAKIA[0-9A-Z]{16}\b/gu },
  { kind: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gu, keep: "Bearer " },
];

function marker(kind: string): string {
  return `[已脱敏:${kind}]`;
}

/** 凭据文件里的全部字符串值；type 这类描述字段不是密钥。 */
export function credentialValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(credentialValues);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => key === "type" ? [] : credentialValues(item));
}

/** 名称像凭据的环境变量的值。反馈包不收环境变量，但命令输出可能把它们带进会话。 */
export function environmentSecrets(environment: NodeJS.ProcessEnv): string[] {
  return Object.entries(environment).flatMap(([name, value]) => value !== undefined && SECRET_ENV.test(name) ? [value] : []);
}

export class Redactor {
  private readonly secrets: string[];
  private total = 0;

  constructor(secrets: readonly string[]) {
    // 先换长的：一个密钥包含另一个时，短的先换会留下长密钥的其余部分。
    this.secrets = [...new Set(secrets.filter(secret => secret.length >= MIN_SECRET))].sort((left, right) => right.length - left.length);
  }

  /** 已经替换的处数，manifest 据此告诉看报告的人哪里删过内容。 */
  get count(): number {
    return this.total;
  }

  text(input: string): string {
    let output = input;
    for (const secret of this.secrets) {
      const parts = output.split(secret);
      this.total += parts.length - 1;
      output = parts.join(marker("credential"));
    }
    for (const { kind, pattern, keep } of PATTERNS) {
      output = output.replace(pattern, () => {
        this.total += 1;
        return `${keep ?? ""}${marker(kind)}`;
      });
    }
    return output;
  }

  /** 替换 JSON 值里的每个字符串；先解析再替换，转义过的密钥也能匹配，结果仍是有效 JSON。 */
  value(input: unknown): unknown {
    if (typeof input === "string") return this.text(input);
    if (Array.isArray(input)) return input.map(item => this.value(item));
    if (input === null || typeof input !== "object") return input;
    return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, this.value(item)]));
  }

  /**
   * JSONL 逐行解析后替换。会话可能正在追加，末尾没写完的一行丢掉；中间解析不了的行按文本替换，不丢内容。
   */
  jsonl(input: string): string {
    const lines = input.split("\n");
    const last = lines.at(-1);
    if (last !== undefined && last.length > 0 && !parses(last)) lines.pop();
    return lines.map(line => {
      if (line.trim().length === 0) return line;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return this.text(line);
      }
      return JSON.stringify(this.value(parsed));
    }).join("\n");
  }
}

function parses(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}
