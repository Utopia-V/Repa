/**
 * 沙箱里的 runner.py 把 Python 值序列化成 { t: 类型, ... }，这里在沙箱外比较和显示。
 * 浮点数按相对误差 1e-9 比较，NaN 与 NaN 相等；字典按键值对比较、不看顺序；其余结构逐项相同。
 */

export type PythonValue = { t: string; [field: string]: unknown };

const RELATIVE_TOLERANCE = 1e-9;

function floatOf(text: unknown): number {
  if (text === "nan") return Number.NaN;
  if (text === "inf") return Number.POSITIVE_INFINITY;
  if (text === "-inf") return Number.NEGATIVE_INFINITY;
  return Number(text);
}

function closeEnough(left: number, right: number): boolean {
  if (Number.isNaN(left) || Number.isNaN(right)) return Number.isNaN(left) && Number.isNaN(right);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return left === right;
  return Math.abs(left - right) <= RELATIVE_TOLERANCE * Math.max(1, Math.abs(left), Math.abs(right));
}

function isPythonValue(value: unknown): value is PythonValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as PythonValue).t === "string";
}

export function sameValue(left: unknown, right: unknown): boolean {
  // 太大的值在沙箱里没有序列化，无从比较，按不相同处理，让作者改为比较更小的表达式。
  if ((isPythonValue(left) && left.t === "too_large") || (isPythonValue(right) && right.t === "too_large")) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
  }
  if (isPythonValue(left) && isPythonValue(right)) {
    if (left.t !== right.t) return false;
    if (left.t === "float") return closeEnough(floatOf(left.v), floatOf(right.v));
    if (left.t === "dict") {
      const leftEntries = left.v as unknown[][];
      const rightEntries = right.v as unknown[][];
      return leftEntries.length === rightEntries.length
        && leftEntries.every(([key, value]) => rightEntries.some(([otherKey, otherValue]) => sameValue(key, otherKey) && sameValue(value, otherValue)));
    }
  }
  if (typeof left === "object" && left !== null && typeof right === "object" && right !== null) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return sameValue(leftKeys, rightKeys)
      && leftKeys.every((key) => sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
  }
  return left === right;
}

function quote(text: string): string {
  return `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\n", "\\n")}'`;
}

/** 接近 Python repr 的简短显示，用在检查报告里。 */
export function showValue(value: unknown, limit = 300): string {
  const text = show(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** numpy dtype.kind 的中文名；比较时只看类型大类。 */
const KIND_NAMES: Record<string, string> = {
  b: "布尔", i: "整数", u: "无符号整数", f: "浮点", c: "复数", O: "文字或对象", M: "日期时间", m: "时间差",
};

function kindName(kind: unknown): string {
  return KIND_NAMES[String(kind)] ?? String(kind);
}

function show(value: unknown): string {
  if (!isPythonValue(value)) return JSON.stringify(value);
  const list = (items: unknown) => (items as unknown[]).map(show).join(", ");
  switch (value.t) {
    case "none": return "None";
    case "NA": return "<NA>";
    case "NaT": return "NaT";
    case "bool": return value.v ? "True" : "False";
    case "int":
    case "float": return String(value.v);
    case "str": return quote(String(value.v));
    case "list": return `[${list(value.v)}]`;
    case "tuple": return (value.v as unknown[]).length === 1 ? `(${list(value.v)},)` : `(${list(value.v)})`;
    case "set": return `{${list(value.v)}}`;
    case "dict": return `{${(value.v as unknown[][]).map(([key, item]) => `${show(key)}: ${show(item)}`).join(", ")}}`;
    case "DataFrame": return `DataFrame(index=[${list(value.index)}], columns=[${list(value.columns)}], 列类型=[${(value.kinds as unknown[]).map(kindName).join(", ")}], values=[${(value.values as unknown[][]).map((row) => `[${row.map(show).join(", ")}]`).join(", ")}])`;
    case "Series": return `Series(name=${show(value.name)}, 类型=${kindName(value.kind)}, index=[${list(value.index)}], values=[${list(value.values)}])`;
    case "Index": return `Index([${list(value.values)}])`;
    case "ndarray": return `array(${show(value.values)})`;
    case "type": return `<class ${quote(String(value.v))}>`;
    case "too_large": return `${String(value.type)}（${String(value.size)} 个元素，太大，无法比较；请比较更小的表达式，例如 .head() 或 .shape）`;
    default: return String(value.v ?? value.t);
  }
}
