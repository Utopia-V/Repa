/**
 * 规则判分：按作答位上的标准答案和比较方式判断作答。课程检查用它确认标准答案、程序算出的答案和已知错误答案，
 * 学习者的作答也按它判。代码题和按测试判的 Parsons 题要运行代码（见 code-tests.ts），这里返回 ungraded；
 * 开放作答由人或模型评，同样返回 ungraded。
 */

import type { Answer } from "@repa/base/protocol";
import type { SlotDef, TextMatch } from "../format/schema.js";
import type { Verdict } from "../protocol.js";
import { acceptedValues, inputCells, itemIndent, scalarText, textMatch, type CellMatch, type Scalar } from "./items.js";
import { sameDisplay } from "./literal.js";

/** 规则判分是同步的，不会是 pending。 */
export interface SlotGrade {
  verdict: Exclude<Verdict, "pending">;
  earned: number;
  max: number;
}

const INTEGER = /^[+-]?[0-9]+$/;
const DECIMAL = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const FRACTION = /^([+-]?[0-9]+)\/([0-9]+)$/;

function parseNumber(text: string): number | undefined {
  if (DECIMAL.test(text)) return Number(text);
  const fraction = FRACTION.exec(text);
  if (fraction && Number(fraction[2]) !== 0) return Number(fraction[1]) / Number(fraction[2]);
  return undefined;
}

function unquoted(text: string): string | undefined {
  const quoted = /^(['"])(.*)\1$/s.exec(text);
  return quoted ? quoted[2] : undefined;
}

/** 一个可接受的值是否与作答相符。字符串形式的标准答案在数值比较里按原文比较，例如“尚未定义”。 */
function matchesValue(match: TextMatch, accepted: Scalar, answer: string, tolerance: number): boolean {
  const trimmed = answer.trim();
  switch (match) {
    case "nonempty":
      return trimmed !== "";
    case "integer":
      if (typeof accepted === "number") return INTEGER.test(trimmed) && BigInt(trimmed) === BigInt(accepted);
      return trimmed === scalarText(accepted).trim();
    case "number": {
      if (typeof accepted !== "number") return trimmed === scalarText(accepted).trim();
      const value = parseNumber(trimmed);
      // 加一点相对余量，让“0.5 ± 0.01”包含 0.51 这样恰在边界、但二进制浮点算出来略超的值。
      const slack = 1e-12 * Math.max(1, Math.abs(accepted));
      return value !== undefined && Math.abs(value - accepted) <= tolerance + slack;
    }
    case "text":
      // 学生可能给文字值加上引号，例如 'S_C'；去掉一对首尾相同的引号后再比一次。
      return trimmed === scalarText(accepted).trim() || unquoted(trimmed) === scalarText(accepted).trim();
    case "output":
      return sameDisplay(scalarText(accepted), answer);
  }
}

export function matchesText(match: TextMatch, accepted: Scalar[], answer: string, tolerance = 0): boolean {
  if (match === "nonempty") return answer.trim() !== "";
  return accepted.some((value) => matchesValue(match, value, answer, tolerance));
}

export function matchesCell(match: CellMatch, key: Scalar, answer: Answer | undefined): boolean {
  if (match === "choice") return answer?.type === "choice" && answer.selected.length === 1 && answer.selected[0] === scalarText(key);
  return answer?.type === "text" && matchesText(match, [key], answer.text);
}

const result = (earned: number, max: number): SlotGrade => ({
  verdict: earned === max ? "correct" : earned > 0 ? "partial" : "incorrect",
  earned,
  max,
});

function sameSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** 按作答位自己的判分规则判一个作答位。按测试判的作答位和开放作答不在这里判，返回 ungraded；课程检查和学习者的判分都用它，同一份作答得出同样的结论。 */
export function gradeSlot(slot: SlotDef, answer: Answer | undefined): SlotGrade {
  switch (slot.type) {
    case "text": {
      if (slot.rubric) return { verdict: "ungraded", earned: 0, max: 0 };
      const correct = answer?.type === "text" && matchesText(textMatch(slot), acceptedValues(slot), answer.text, slot.tolerance ?? 0);
      return result(correct ? 1 : 0, 1);
    }
    case "choice": {
      const key = new Set(Array.isArray(slot.key) ? slot.key : [slot.key]);
      const selected = new Set(answer?.type === "choice" ? answer.selected : []);
      if (slot.multiple && slot.scoring === "options") {
        const earned = slot.options.filter((option) => key.has(option.id) === selected.has(option.id)).length;
        return result(answer?.type === "choice" ? earned : 0, slot.options.length);
      }
      const correct = answer?.type === "choice" && answer.other === undefined && selected.size === key.size && [...key].every((id) => selected.has(id));
      return result(correct ? 1 : 0, 1);
    }
    case "order": {
      if (slot.tests) return { verdict: "ungraded", earned: 0, max: slot.tests.length };
      if (answer?.type !== "order") return result(0, 1);
      const sequences = [slot.key, ...(slot.alternatives ?? [])];
      const orderRight = sequences.some((sequence) => sameSequence(sequence, answer.items));
      // 缩进按块计：每块的缩进要等于这一块规定的层级，与它排在第几个无关。
      const indentsRight = slot.indent === undefined
        || (answer.indents?.length === answer.items.length && answer.items.every((id, index) => answer.indents?.[index] === itemIndent(slot, id)));
      return result(orderRight && indentsRight ? 1 : 0, 1);
    }
    case "table": {
      const cells = inputCells(slot);
      const answers = answer?.type === "table" ? answer.cells : {};
      const earned = cells.filter(({ row, column, cell }) => matchesCell(cell.match, cell.key, answers[row]?.[column])).length;
      return result(earned, cells.length);
    }
    case "code":
      return { verdict: "ungraded", earned: 0, max: slot.tests.length };
  }
}
