import { execFileSync } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import path from "node:path";

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Nodes, Root } from "mdast";

export interface Issue {
  file: string;
  line: number;
  check: string;
  message: string;
}

export interface Exclusion {
  pattern: string;
  include?: string[];
  reason: string;
}

export interface Budget {
  path: string;
  maxChars: number;
  reason: string;
}

export interface BannedTerm {
  term: string;
  replacement: string;
  reason: string;
}

export interface Settings {
  exclusions: Exclusion[];
  budgets: Budget[];
  bannedTerms: BannedTerm[];
  exceptions: Record<string, Record<string, string>>;
}

export function walk(node: Nodes, visit: (node: Nodes) => void): void {
  visit(node);
  if ("children" in node) {
    for (const child of node.children) walk(child, visit);
  }
}

export function plainText(node: Nodes): string {
  if (node.type === "html") return "";
  if ("value" in node) return node.value;
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  if ("children" in node) return node.children.map(plainText).join("");
  return "";
}

export function charCount(text: string): number {
  return Array.from(text.replace(/\s/gu, "")).length;
}

// 配置只使用 * 和 **；逐路径段匹配也覆盖 .agents 等隐藏目录。
function matchesGlob(file: string, pattern: string): boolean {
  const parts = file.split("/");
  const patterns = pattern.split("/");
  const match = (partIndex: number, patternIndex: number): boolean => {
    const segment = patterns[patternIndex];
    if (segment === undefined) return partIndex === parts.length;
    if (segment === "**") {
      return match(partIndex, patternIndex + 1)
        || (partIndex < parts.length && match(partIndex + 1, patternIndex));
    }
    const part = parts[partIndex];
    if (part === undefined) return false;
    const escaped = segment.split("*").map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
    return new RegExp(`^${escaped}$`).test(part) && match(partIndex + 1, patternIndex + 1);
  };
  return match(0, 0);
}

export function inScope(file: string, exclusions: Exclusion[]): boolean {
  return !exclusions.some((entry) => matchesGlob(file, entry.pattern)
    && !entry.include?.some((pattern) => matchesGlob(file, pattern)));
}

export class Repository {
  private readonly texts = new Map<string, Promise<string>>();
  private readonly trees = new Map<string, Promise<Root>>();

  constructor(readonly root: string, readonly files: string[]) {}

  static tracked(root: string): Repository {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
      .split("\0").filter(Boolean);
    const deleted = new Set(execFileSync("git", ["ls-files", "--deleted", "-z"], { cwd: root, encoding: "utf8" }).split("\0"));
    return new Repository(root, files.filter((file) => !deleted.has(file)));
  }

  text(file: string): Promise<string> {
    let result = this.texts.get(file);
    if (!result) {
      result = readFile(path.resolve(this.root, file), "utf8");
      this.texts.set(file, result);
    }
    return result;
  }

  tree(file: string): Promise<Root> {
    let result = this.trees.get(file);
    if (!result) {
      result = this.text(file).then((text) => fromMarkdown(text, {
        extensions: [gfm()],
        mdastExtensions: [gfmFromMarkdown()],
      }));
      this.trees.set(file, result);
    }
    return result;
  }

  async exists(file: string): Promise<boolean> {
    try {
      await access(path.resolve(this.root, file));
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("应为对象");
  return value as Record<string, unknown>;
}

function nonempty(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("应为非空字符串");
  return value;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("应为数组");
  return value;
}

export async function readSettings(repo: Repository): Promise<Settings> {
  const read = async (name: string): Promise<unknown> => JSON.parse(await repo.text(`scripts/docs/${name}.json`));
  const config = object(await read("config"));
  const exclusions = array(config.exclusions).map((value) => {
    const entry = object(value);
    return {
      pattern: nonempty(entry.pattern),
      reason: nonempty(entry.reason),
      ...(entry.include === undefined ? {} : { include: array(entry.include).map(nonempty) }),
    };
  });
  const budgets = array(await read("budgets")).map((value) => {
    const entry = object(value);
    if (typeof entry.maxChars !== "number" || !Number.isSafeInteger(entry.maxChars) || entry.maxChars <= 0) {
      throw new Error("maxChars 应为正整数");
    }
    return { path: nonempty(entry.path), maxChars: entry.maxChars, reason: nonempty(entry.reason) };
  });
  const bannedTerms = array(await read("banned-terms")).map((value) => {
    const entry = object(value);
    return { term: nonempty(entry.term), replacement: nonempty(entry.replacement), reason: nonempty(entry.reason) };
  });
  const exceptions = Object.fromEntries(Object.entries(object(await read("exceptions"))).map(([name, value]) => [
    name, Object.fromEntries(Object.entries(object(value)).map(([file, reason]) => [file, nonempty(reason)])),
  ]));
  return { exclusions, budgets, bannedTerms, exceptions };
}
