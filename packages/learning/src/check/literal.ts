/**
 * Python 字面量的一个小子集，用来比较“Python 会显示什么”这类答案：
 * 引号种类、逗号后的空格不同仍算同一个值；True 与 1、6 与 6.0、"001" 与 1 保持不同。
 */

export type PyValue =
  | { t: "int"; v: bigint }
  | { t: "float"; v: number }
  | { t: "str"; v: string }
  | { t: "bytes"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "none" }
  | { t: "list" | "tuple" | "set"; items: PyValue[] }
  | { t: "dict"; entries: [PyValue, PyValue][] };

class LiteralParser {
  private position = 0;

  constructor(private readonly text: string) {}

  parseAll(): PyValue | undefined {
    const value = this.value();
    this.space();
    return value !== undefined && this.position === this.text.length ? value : undefined;
  }

  private space(): void {
    while (/\s/.test(this.text[this.position] ?? "")) this.position++;
  }

  private peek(): string {
    return this.text[this.position] ?? "";
  }

  private take(token: string): boolean {
    this.space();
    if (!this.text.startsWith(token, this.position)) return false;
    this.position += token.length;
    return true;
  }

  private value(): PyValue | undefined {
    this.space();
    const rest = this.text.slice(this.position);
    const word = /^(True|False|None)(?![A-Za-z0-9_])/.exec(rest);
    if (word) {
      this.position += word[0].length;
      if (word[1] === "None") return { t: "none" };
      return { t: "bool", v: word[1] === "True" };
    }
    const emptySet = /^set\(\s*\)/.exec(rest);
    if (emptySet) {
      this.position += emptySet[0].length;
      return { t: "set", items: [] };
    }
    const first = this.peek();
    if (first === "[") return this.sequence("[", "]", "list");
    if (first === "(") return this.parenthesized();
    if (first === "{") return this.braces();
    if (first === "'" || first === '"' || /^[bB]['"]/.test(rest)) return this.string();
    return this.number();
  }

  private number(): PyValue | undefined {
    const match = /^[+-]?(?:(?:[0-9](?:_?[0-9])*)?\.[0-9](?:_?[0-9])*|[0-9](?:_?[0-9])*\.?)(?:[eE][+-]?[0-9]+)?/.exec(this.text.slice(this.position));
    if (!match || match[0] === "" || /^[+-]?$/.test(match[0])) return undefined;
    const raw = match[0].replaceAll("_", "");
    this.position += match[0].length;
    if (/[.eE]/.test(raw)) return { t: "float", v: Number(raw) };
    // Python 3 不接受 007 这类前导零整数，这种写法不当作字面量。
    if (/^[+-]?0[0-9]/.test(raw)) return undefined;
    return { t: "int", v: BigInt(raw) };
  }

  private string(): PyValue | undefined {
    let bytes = false;
    if (this.peek() === "b" || this.peek() === "B") {
      bytes = true;
      this.position++;
    }
    const quote = this.peek();
    this.position++;
    let result = "";
    while (this.position < this.text.length) {
      const character = this.text[this.position++] ?? "";
      if (character === quote) return bytes ? { t: "bytes", v: result } : { t: "str", v: result };
      if (character === "\n") return undefined;
      if (character !== "\\") {
        result += character;
        continue;
      }
      const escape = this.text[this.position++] ?? "";
      const simple: Record<string, string> = { "\\": "\\", "'": "'", '"': '"', n: "\n", r: "\r", t: "\t", "0": "\0", a: "\x07", b: "\b", f: "\f", v: "\v" };
      if (escape in simple) {
        result += simple[escape];
      } else if (escape === "x" || escape === "u" || escape === "U") {
        const length = escape === "x" ? 2 : escape === "u" ? 4 : 8;
        const digits = this.text.slice(this.position, this.position + length);
        if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(digits)) return undefined;
        result += String.fromCodePoint(Number.parseInt(digits, 16));
        this.position += length;
      } else {
        result += `\\${escape}`;
      }
    }
    return undefined;
  }

  private items(close: string): PyValue[] | undefined {
    const items: PyValue[] = [];
    if (this.take(close)) return items;
    for (;;) {
      const item = this.value();
      if (item === undefined) return undefined;
      items.push(item);
      if (this.take(close)) return items;
      if (!this.take(",")) return undefined;
      if (this.take(close)) return items;
    }
  }

  private sequence(open: string, close: string, t: "list"): PyValue | undefined {
    this.take(open);
    const items = this.items(close);
    return items === undefined ? undefined : { t, items };
  }

  private parenthesized(): PyValue | undefined {
    this.take("(");
    if (this.take(")")) return { t: "tuple", items: [] };
    const first = this.value();
    if (first === undefined) return undefined;
    if (this.take(")")) return first;
    if (!this.take(",")) return undefined;
    const rest = this.items(")");
    return rest === undefined ? undefined : { t: "tuple", items: [first, ...rest] };
  }

  private braces(): PyValue | undefined {
    this.take("{");
    if (this.take("}")) return { t: "dict", entries: [] };
    const first = this.value();
    if (first === undefined) return undefined;
    if (this.take(":")) {
      const entries: [PyValue, PyValue][] = [];
      let key: PyValue | undefined = first;
      for (;;) {
        const value = this.value();
        if (key === undefined || value === undefined) return undefined;
        entries.push([key, value]);
        if (this.take("}")) return { t: "dict", entries };
        if (!this.take(",")) return undefined;
        if (this.take("}")) return { t: "dict", entries };
        key = this.value();
        if (!this.take(":")) return undefined;
      }
    }
    if (this.take("}")) return { t: "set", items: [first] };
    if (!this.take(",")) return undefined;
    const rest = this.items("}");
    return rest === undefined ? undefined : { t: "set", items: [first, ...rest] };
  }
}

export function parsePythonLiteral(text: string): PyValue | undefined {
  return new LiteralParser(text).parseAll();
}

function unordered(left: PyValue[], right: PyValue[]): boolean {
  if (left.length !== right.length) return false;
  const remaining = [...right];
  return left.every((item) => {
    const index = remaining.findIndex((candidate) => pythonEqual(item, candidate));
    if (index < 0) return false;
    remaining.splice(index, 1);
    return true;
  });
}

/** 按值比较，类型必须相同：bool 不等于 int，int 不等于 float。 */
export function pythonEqual(left: PyValue, right: PyValue): boolean {
  if (left.t !== right.t) return false;
  switch (left.t) {
    case "none":
      return true;
    case "float":
      // Python 显示 -0.0 与 0.0 不同。
      return Object.is(left.v, (right as typeof left).v);
    case "int":
    case "str":
    case "bytes":
    case "bool":
      return left.v === (right as typeof left).v;
    case "list":
    case "tuple": {
      const items = (right as typeof left).items;
      return left.items.length === items.length && left.items.every((item, index) => {
        const other = items[index];
        return other !== undefined && pythonEqual(item, other);
      });
    }
    case "set":
      return unordered(left.items, (right as typeof left).items);
    case "dict": {
      // 比的是显示出来的样子：字典按插入顺序显示，顺序不同就是不同的显示。
      const entries = (right as typeof left).entries;
      return left.entries.length === entries.length && left.entries.every(([key, value], index) => {
        const other = entries[index];
        return other !== undefined && pythonEqual(key, other[0]) && pythonEqual(value, other[1]);
      });
    }
  }
}

/** 61A 的 WWPD 约定：函数值答 FUNCTION，出错答 ERROR，什么都不显示答 NOTHING，不分大小写。 */
export const DISPLAY_TOKENS = ["NOTHING", "ERROR", "FUNCTION"] as const;

/** 去掉每行首尾空白、合并行内连续空白，忽略首尾空行；表格对齐用的空格不影响比较。 */
export function normalizeOutput(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

/**
 * 比较“Python 会显示什么”：标准答案恰好是固定词时，作答不分大小写地比较；其次按字面量比较；
 * 最后按规范化后的文字比较。打印出来的 Error、nothing 这类普通文字不当作固定词。
 */
export function sameDisplay(expected: string, answer: string): boolean {
  const token = DISPLAY_TOKENS.find((candidate) => candidate === expected.trim());
  if (token) return answer.trim().toUpperCase() === token;
  const left = parsePythonLiteral(expected);
  const right = parsePythonLiteral(answer);
  if (left !== undefined && right !== undefined) return pythonEqual(left, right);
  return normalizeOutput(expected) === normalizeOutput(answer);
}
