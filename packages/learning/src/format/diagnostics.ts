import path from "node:path";

import { isMap, isPair, isScalar, isSeq, LineCounter, parseDocument, visit, type Document, type Node } from "yaml";
import type { TSchema } from "typebox";
import { Settings } from "typebox/system";
import { Value } from "typebox/value";
import type { TLocalizedValidationError } from "typebox/error";

/** 课程检查发现的一个问题。code 供程序和测试判断，message 给作者看。 */
export interface Diagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export type ValuePath = readonly (string | number)[];

/** 一份已解析的 YAML 文件，保留语法树以便把问题定位到行。 */
export class SourceFile {
  readonly lines = new LineCounter();
  readonly document: Document.Parsed;

  constructor(readonly file: string, readonly display: string, text: string) {
    this.document = parseDocument(text, {
      lineCounter: this.lines,
      uniqueKeys: true,
      strict: true,
      merge: false,
      schema: "core",
      version: "1.2",
      prettyErrors: true,
    });
  }

  /** 找到路径上最深的已有节点；键不存在时落在它的父对象上。 */
  position(at: ValuePath): { line: number; column: number } | undefined {
    let node: unknown = this.document.contents;
    let located: Node | undefined = isNodeWithRange(node) ? node : undefined;
    for (const segment of at) {
      if (isMap(node)) {
        const pair = node.items.find((item) => isPair(item) && isScalar(item.key) && String(item.key.value) === String(segment));
        if (!pair) break;
        if (isNodeWithRange(pair.key)) located = pair.key;
        node = pair.value;
      } else if (isSeq(node) && typeof segment === "number") {
        node = node.items[segment];
      } else {
        break;
      }
      if (isNodeWithRange(node)) located = node;
    }
    if (!located?.range) return undefined;
    const position = this.lines.linePos(located.range[0]);
    return { line: position.line, column: position.col };
  }
}

function isNodeWithRange(value: unknown): value is Node {
  return typeof value === "object" && value !== null && "range" in value && Array.isArray((value as Node).range);
}

/** 收集问题；位置用文件加值路径表示，输出时换算成行列。 */
export class Report {
  readonly diagnostics: Diagnostic[] = [];

  error(code: string, message: string, file?: SourceFile, at: ValuePath = []): void {
    this.add("error", code, message, file, at);
  }

  warning(code: string, message: string, file?: SourceFile, at: ValuePath = []): void {
    this.add("warning", code, message, file, at);
  }

  get errorCount(): number {
    return this.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  }

  private add(severity: Diagnostic["severity"], code: string, message: string, file: SourceFile | undefined, at: ValuePath): void {
    const position = file?.position(at);
    this.diagnostics.push({
      severity, code, message,
      ...(file ? { file: file.display } : {}),
      ...(position ? { line: position.line, column: position.column } : {}),
    });
  }
}

/** 把一个问题写成一行：位置、级别、错误码和说明，供命令行输出。 */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const where = diagnostic.file
    ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}:${diagnostic.column ?? 1}` : ""}: `
    : "";
  const level = diagnostic.severity === "error" ? "错误" : "提醒";
  return `${where}${level} [${diagnostic.code}] ${diagnostic.message}`;
}

/** 读取并解析 YAML；语法问题、锚点与别名都记为错误。返回 undefined 表示文件不能继续使用。 */
export function parseYamlFile(file: SourceFile, report: Report): unknown {
  // 语法错误之后的问题多半是连带出来的，只报前几个。
  for (const problem of [...file.document.errors, ...file.document.warnings].slice(0, 3)) {
    const position = problem.linePos?.[0];
    report.diagnostics.push({
      severity: "error",
      code: "yaml_syntax",
      message: `YAML 写法有误：${(problem.message.split("\n")[0] ?? "").replace(/ at line \d+, column \d+:?$/, "")}`,
      file: file.display,
      ...(position ? { line: position.line, column: position.col } : {}),
    });
  }
  if (file.document.errors.length > 0) return undefined;
  let aliases = 0;
  visit(file.document, {
    Alias(_key, node) {
      aliases += 1;
      const position = node.range ? file.lines.linePos(node.range[0]) : undefined;
      report.diagnostics.push({
        severity: "error",
        code: "yaml_alias",
        message: "课程文件不用 YAML 锚点和别名；需要共用的数据写成 data 夹具",
        file: file.display,
        ...(position ? { line: position.line, column: position.col } : {}),
      });
    },
  });
  if (aliases > 0) return undefined;
  return file.document.toJS({ maxAliasCount: 0 });
}

/** 问题里显示的文件路径：在 base 之下用相对路径，否则用绝对路径。 */
export function displayPath(base: string, file: string): string {
  const relative = path.relative(base, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
}

// ---------------------------------------------------------------------------
// schema 校验结果转成给作者看的问题
// ---------------------------------------------------------------------------

function pointerToPath(pointer: string): (string | number)[] {
  if (pointer === "") return [];
  return pointer.slice(1).split("/").map((segment) => {
    const decoded = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    return /^[0-9]+$/.test(decoded) ? Number(decoded) : decoded;
  });
}

function schemaAt(schema: TSchema, schemaPath: string): Record<string, unknown> | undefined {
  let node: unknown = schema;
  for (const segment of pointerToPath(schemaPath.replace(/^#/, ""))) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string | number, unknown>)[segment];
  }
  return typeof node === "object" && node !== null ? (node as Record<string, unknown>) : undefined;
}

function readable(at: ValuePath): string {
  return at.length === 0 ? "文件顶层" : at.map((segment) => (typeof segment === "number" ? `[${segment}]` : `.${segment}`)).join("").replace(/^\./, "");
}

function describe(value: unknown): string {
  if (value === null) return "空值";
  if (Array.isArray(value)) return "列表";
  if (typeof value === "string") return "字符串";
  if (typeof value === "number") return "数字";
  if (typeof value === "boolean") return "布尔值";
  return "对象";
}

function valueAt(root: unknown, at: ValuePath): unknown {
  let node = root;
  for (const segment of at) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string | number, unknown>)[segment];
  }
  return node;
}

/**
 * 联合类型（几种写法任选其一）的错误会把每种写法的不合之处都列出来，只报作者想写的那一种：
 * 1. 判别字段（例如 type）对不上，或者整个值的类型对不上的写法，排除；
 * 2. 剩下不止一种时，再排除缺少必需字段的写法（没有判别字段的联合靠这一步分辨）；
 * 3. 只剩一种就只报它的错误；一种不剩就说明应写成哪几种之一。
 */
function narrowUnions(errors: TLocalizedValidationError[]): TLocalizedValidationError[] {
  const dropped = new Set<TLocalizedValidationError>();
  const replacements: TLocalizedValidationError[] = [];
  for (const union of errors.filter((error) => error.keyword === "anyOf")) {
    const prefix = `${union.schemaPath}/anyOf/`;
    const depth = pointerToPath(union.instancePath).length;
    const branches = new Map<number, TLocalizedValidationError[]>();
    for (const error of errors) {
      const inside = error.instancePath === union.instancePath || error.instancePath.startsWith(`${union.instancePath}/`);
      if (!error.schemaPath.startsWith(prefix) || !inside) continue;
      const index = Number(error.schemaPath.slice(prefix.length).split("/")[0]);
      branches.set(index, [...(branches.get(index) ?? []), error]);
    }
    const mismatched = (branchErrors: TLocalizedValidationError[]) => branchErrors.some((error) => {
      const level = pointerToPath(error.instancePath).length;
      const discriminator = (error.keyword === "const" || error.keyword === "enum") && level === depth + 1;
      const wholeValue = (error.keyword === "type" || error.keyword === "const" || error.keyword === "enum") && error.instancePath === union.instancePath;
      return discriminator || wholeValue;
    });
    const missingRequired = (branchErrors: TLocalizedValidationError[]) =>
      branchErrors.some((error) => error.keyword === "required" && error.instancePath === union.instancePath);
    let survivors = [...branches.entries()].filter(([, branchErrors]) => !mismatched(branchErrors));
    if (survivors.length > 1) {
      const complete = survivors.filter(([, branchErrors]) => !missingRequired(branchErrors));
      if (complete.length > 0) survivors = complete;
    }
    const kept = new Set(survivors.map(([index]) => index));
    for (const [index, branchErrors] of branches) {
      if (!kept.has(index)) for (const error of branchErrors) dropped.add(error);
    }
    if (survivors.length === 1) {
      dropped.add(union);
    } else if (survivors.length === 0) {
      dropped.add(union);
      const allowed = [...branches.values()].flat()
        .filter((error) => (error.keyword === "const" || error.keyword === "enum") && pointerToPath(error.instancePath).length <= depth + 1)
        .flatMap((error) => {
          const params = error.params as { allowedValue?: unknown; allowedValues?: unknown[] };
          return error.keyword === "const" ? [params.allowedValue] : params.allowedValues ?? [];
        });
      replacements.push({ ...union, message: allowed.length > 0 ? `应为 ${[...new Set(allowed)].map((value) => JSON.stringify(value)).join("、")} 之一` : "" });
    }
  }
  return [...errors.filter((error) => !dropped.has(error)), ...replacements];
}

function explain(error: TLocalizedValidationError, schema: TSchema, root: unknown): string {
  const node = schemaAt(schema, error.schemaPath);
  const value = valueAt(root, pointerToPath(error.instancePath));
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "required":
      return `缺少字段 ${(params.requiredProperties as string[]).join("、")}`;
    case "additionalProperties":
      return `不认识的字段 ${(params.additionalProperties as string[]).join("、")}`;
    case "type": {
      const expected = Array.isArray(params.type) ? (params.type as string[]).join(" 或 ") : String(params.type);
      const hint = expected.includes("string") && (typeof value === "number" || typeof value === "boolean")
        ? "；YAML 会把 001、true 这类写法读成数字或布尔值，作为文字时要加引号"
        : "";
      return `应为 ${expected}，实际是${describe(value)}${hint}`;
    }
    case "pattern":
      return typeof node?.description === "string" ? `格式不对：${node.description}` : `格式不对，应匹配 ${String(params.pattern)}`;
    case "const":
      return `应为 ${JSON.stringify(params.allowedValue)}`;
    case "enum":
      return `应为 ${(params.allowedValues as unknown[]).map((item) => JSON.stringify(item)).join("、")} 之一`;
    case "anyOf":
      return error.message && !/^must match/.test(error.message) ? error.message : "不符合任何一种写法";
    case "minItems":
      return `至少需要 ${String(params.limit)} 项`;
    case "maxItems":
      return `最多 ${String(params.limit)} 项`;
    case "minLength":
      return Number(params.limit) === 1 ? "不能为空" : `至少 ${String(params.limit)} 个字符`;
    case "maxLength":
      return `最多 ${String(params.limit)} 个字符`;
    case "minimum":
    case "maximum":
    case "exclusiveMinimum":
    case "exclusiveMaximum":
      return `应 ${String(params.comparison)} ${String(params.limit)}`;
    default:
      return error.message;
  }
}

const MAX_SCHEMA_ERRORS = 200;

/**
 * 收集全部校验错误。TypeBox 默认只缓冲 8 个错误，联合类型的每个分支都会占用名额，
 * 只看前 8 个就分不出作者想写的是哪种写法。maxErrors 是进程级设置，Errors 是同步调用，
 * 所以只在这次调用期间放宽，调用结束立即恢复。
 */
function allErrors(schema: TSchema, value: unknown): TLocalizedValidationError[] {
  const previous = Settings.Get().maxErrors;
  Settings.Set({ maxErrors: MAX_SCHEMA_ERRORS });
  try {
    return Value.Errors(schema, value);
  } finally {
    Settings.Set({ maxErrors: previous });
  }
}

/** 按 schema 严格校验；不通过时逐条记下问题并返回 false。 */
export function checkSchema(schema: TSchema, value: unknown, file: SourceFile, report: Report, base: ValuePath = []): boolean {
  if (Value.Check(schema, value)) return true;
  const errors = narrowUnions(allErrors(schema, value))
    .filter((error) => !(error.keyword === "boolean" && error.schemaPath.endsWith("/additionalProperties")));
  const seen = new Set<string>();
  for (const error of errors) {
    const at = [...base, ...pointerToPath(error.instancePath)];
    const message = `${readable(at)}：${explain(error, schema, value)}`;
    if (seen.has(message)) continue;
    seen.add(message);
    report.error("schema", message, file, at);
  }
  return false;
}
