import path from "node:path";

import GithubSlugger from "github-slugger";
import ts from "typescript";
import type { Nodes, Root } from "mdast";

import {
  charCount, inScope, plainText, walk,
  type Issue, type Repository, type Settings,
} from "./context.js";

export const CHECK_NAMES = [
  "链接", "路径", "不写提交哈希", "一段一行", "篇幅上限", "停用词", "包 README 骨架", "设计记录格式",
] as const;
export type CheckName = typeof CHECK_NAMES[number];

export interface CheckContext {
  repo: Repository;
  settings: Settings;
  markdown: string[];
}

function issue(file: string, check: CheckName, message: string, node?: Nodes): Issue {
  return { file, line: node?.position?.start.line ?? 1, check, message };
}

function headings(tree: Root): Set<string> {
  const slugs = new Set<string>();
  const slugger = new GithubSlugger();
  walk(tree, (node) => {
    if (node.type === "heading") slugs.add(slugger.slug(plainText(node)));
    if (node.type === "html") {
      // 这里只读 HTML 锚点；Markdown 链接始终由 mdast 解析。
      for (const tag of node.value.matchAll(/<a(?=\s|>)([^>]*)>/gi)) {
        for (const attribute of (tag[1] ?? "").matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
          if (attribute[1]?.toLowerCase() === "id") {
            slugs.add(attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
          }
        }
      }
    }
  });
  return slugs;
}

async function links({ repo, markdown }: CheckContext): Promise<Issue[]> {
  const issues: Issue[] = [];
  const anchors = new Map<string, Set<string>>();
  for (const file of markdown) {
    const targets: { url: string; node: Nodes }[] = [];
    walk(await repo.tree(file), (node) => {
      if (node.type === "link" || node.type === "image" || node.type === "definition") {
        targets.push({ url: node.url, node });
      }
    });
    for (const { url, node } of targets) {
      if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith("//")) continue;
      const hash = url.indexOf("#");
      let target: string;
      let anchor: string;
      try {
        const pathname = decodeURIComponent((hash < 0 ? url : url.slice(0, hash)).split("?")[0] ?? "");
        target = pathname ? path.posix.normalize(pathname.startsWith("/")
          ? pathname.slice(1) : path.posix.join(path.posix.dirname(file), pathname)) : file;
        anchor = hash < 0 ? "" : decodeURIComponent(url.slice(hash + 1));
      } catch {
        issues.push(issue(file, "链接", `链接编码无效：${url}`, node));
        continue;
      }
      if (!await repo.exists(target)) {
        issues.push(issue(file, "链接", `目标不存在：${url}`, node));
      } else if (anchor) {
        let slugs = anchors.get(target);
        if (!slugs) {
          try {
            slugs = headings(await repo.tree(target));
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "EISDIR") {
              issues.push(issue(file, "链接", `锚点目标应为文件：${url}`, node));
              continue;
            }
            throw error;
          }
          anchors.set(target, slugs);
        }
        if (!slugs.has(anchor)) issues.push(issue(file, "链接", `锚点不存在：${url}`, node));
      }
    }
  }
  return issues;
}

async function paths({ repo, markdown }: CheckContext): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const file of markdown.filter((file) => !file.startsWith(".agents/notes/"))) {
    const nodes: Nodes[] = [];
    walk(await repo.tree(file), (node) => {
      if (node.type === "inlineCode") nodes.push(node);
    });
    for (const node of nodes) {
      if (node.type !== "inlineCode" || !/^(packages|apps|docs|\.agents|scripts)\//.test(node.value)) continue;
      if (/[*<{]/.test(node.value)) continue;
      const target = node.value.replace(/#.*$/, "").replace(/:\d+$/, "");
      if (!await repo.exists(target)) issues.push(issue(file, "路径", `仓库路径不存在：${node.value}`, node));
    }
  }
  for (const file of repo.files.filter((file) => /^(packages|apps)\/[^/]+\/src\/.*\.ts$/.test(file))) {
    const text = await repo.text(file);
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const comments = new Map<number, ts.CommentRange>();
    const collect = (node: ts.Node): void => {
      for (const range of [
        ...ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [],
        ...ts.getTrailingCommentRanges(text, node.getEnd()) ?? [],
      ]) comments.set(range.pos, range);
      ts.forEachChild(node, collect);
    };
    collect(source);
    for (const range of comments.values()) {
      for (const match of text.slice(range.pos, range.end).matchAll(/(?:docs|\.agents)\/[^\s`"'<>()[\]{}，。；：]+?\.md\b/g)) {
        if (await repo.exists(match[0])) continue;
        const line = source.getLineAndCharacterOfPosition(range.pos + (match.index ?? 0)).line + 1;
        issues.push({ file, line, check: "路径", message: `注释路径不存在：${match[0]}` });
      }
    }
  }
  return issues;
}

async function hashes({ repo, markdown }: CheckContext): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const file of markdown) {
    walk(await repo.tree(file), (node) => {
      if (node.type === "inlineCode" && /^[a-f0-9]{7,40}$/.test(node.value)
        && /[a-f]/.test(node.value) && /\d/.test(node.value)) {
        issues.push(issue(file, "不写提交哈希", `引用历史请用 PR 号、tag 或文字说明：${node.value}`, node));
      }
    });
  }
  return issues;
}

async function paragraphs({ repo, markdown }: CheckContext): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const file of markdown) {
    walk(await repo.tree(file), (node) => {
      if (node.type === "paragraph" && node.position && node.position.start.line !== node.position.end.line) {
        issues.push(issue(file, "一段一行", "段落不能跨行", node));
      }
    });
  }
  return issues;
}

async function budgets({ repo, settings, markdown }: CheckContext): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const file of markdown.filter((file) => path.posix.basename(file) === "AGENTS.md")) {
    const entries = settings.budgets.filter((entry) => entry.path === file);
    if (entries.length !== 1) {
      issues.push(issue(file, "篇幅上限", "budgets.json 必须为每份 AGENTS.md 配置一条上限和理由"));
      continue;
    }
    const entry = entries[0];
    if (!entry) continue;
    const count = charCount(await repo.text(file));
    if (count > entry.maxChars) {
      issues.push(issue(file, "篇幅上限", `${count} 字符超过 ${entry.maxChars}：先把内容挪到它该在的地方，再压缩，最后才提上限并写明理由`));
    }
  }
  return issues;
}

async function bannedTerms({ repo, settings, markdown }: CheckContext): Promise<Issue[]> {
  const issues: Issue[] = [];
  const source = repo.files.filter((file) => /^(packages|apps)\/[^/]+\/src\/.*\.(ts|svelte)$/.test(file));
  for (const file of [...markdown, ...source]) {
    if (!settings.bannedTerms.length) break;
    const lines = (await repo.text(file)).split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const entry of settings.bannedTerms) {
        if (line.toLowerCase().includes(entry.term.toLowerCase())) {
          issues.push({ file, line: index + 1, check: "停用词", message: `${entry.term} → ${entry.replacement}：${entry.reason}` });
        }
      }
    }
  }
  return issues;
}

async function readmes({ repo, markdown }: CheckContext): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const file of markdown.filter((file) => /^packages\/[^/]+\/README\.md$/.test(file))) {
    const tree = await repo.tree(file);
    const titles = tree.children.filter((node) => node.type === "heading" && node.depth === 1);
    const sections = tree.children.filter((node) => node.type === "heading" && node.depth === 2);
    const names = sections.map(plainText);
    if (titles.length !== 1 || tree.children[0] !== titles[0]) {
      issues.push(issue(file, "包 README 骨架", "以一个一级标题开头"));
    }
    const expected = ["概述", "怎么用", "对模型的影响", "已知限制与暂缓"];
    if (names[0] !== "概述" || expected.some((name) => names.filter((item) => item === name).length !== 1)
      || names.indexOf("怎么用") >= names.indexOf("对模型的影响")
      || names.at(-2) !== "对模型的影响" || names.at(-1) !== "已知限制与暂缓") {
      issues.push(issue(file, "包 README 骨架", "H2 依次包含概述、怎么用，最后两节为对模型的影响、已知限制与暂缓"));
    }
    const body = (name: string): Nodes[] => {
      const heading = sections[names.indexOf(name)];
      if (!heading) return [];
      const start = tree.children.indexOf(heading) + 1;
      const end = tree.children.findIndex((node, index) => index >= start && node.type === "heading" && node.depth <= 2);
      return tree.children.slice(start, end < 0 ? undefined : end);
    };
    const overview = body("概述").map(plainText).join("");
    if (!charCount(overview) || charCount(overview) > 120) {
      issues.push(issue(file, "包 README 骨架", "概述正文应为 1 至 120 个非空白字符", sections[names.indexOf("概述")]));
    }
    const impact = body("对模型的影响").map(plainText).join("\n");
    if (!/^无：\s*\S.+/u.test(impact)
      && !(/模型/.test(impact) && /\d[\d,.]*(?:\s*(?:[-–~～]|至)\s*\d[\d,.]*)?\s*(?:个\s*)?tokens?/i.test(impact) && /缓存|cache/i.test(impact))) {
      issues.push(issue(file, "包 README 骨架", "模型影响须说明模型所见、约多少 token 和提示缓存；无注入时用“无：”说明原因", sections[names.indexOf("对模型的影响")]));
    }
    const limitations = body("已知限制与暂缓");
    if (!limitations.some((node) => node.type === "list" && node.children.length > 0)
      && !limitations.some((node) => /^目前没有：\s*\S.+/u.test(plainText(node)))) {
      issues.push(issue(file, "包 README 骨架", "限制须有列表项，或用“目前没有：……”说明原因", sections[names.indexOf("已知限制与暂缓")]));
    }
  }
  return issues;
}

async function notes({ repo, markdown }: CheckContext): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const file of markdown.filter((file) => file.startsWith(".agents/notes/") && file !== ".agents/notes/README.md")) {
    const match = /^\.agents\/notes\/(proposed|implemented|rejected)\/(feature|simplification|architecture|data|process)\/\d{4}-\d{2}-\d{2}-[a-z]+(?:-[a-z]+)*\.md$/.exec(file);
    if (!match) issues.push(issue(file, "设计记录格式", "路径须为 {状态}/{类别}/YYYY-MM-DD-英文小写和连字符.md，不建索引文件"));
    const text = await repo.text(file);
    const lines = text.split(/\r?\n/);
    if (!/^# \S/.test(lines[0] ?? "")) issues.push(issue(file, "设计记录格式", "第一行须为 # 标题"));
    const statusIndex = lines.findIndex((line, index) => index > 0 && line.trim().length > 0);
    const status = lines[statusIndex] ?? "";
    const expected = match?.[1] === "proposed" ? /^状态：提案$/
      : match?.[1] === "implemented" ? /^状态：已落地$/ : /^状态：已否决：\S.*$/;
    if (!expected.test(status)) {
      issues.push({ file, line: Math.max(1, statusIndex + 1), check: "设计记录格式", message: "标题后第一个非空行的状态须和所在目录一致；否决须说明理由" });
    }
    const headings = (await repo.tree(file)).children.filter((node) => node.type === "heading" && node.depth === 2);
    const names = headings.map(plainText);
    if (names[0] !== "问题") issues.push(issue(file, "设计记录格式", "第一个 H2 须为问题", headings[0]));
    const required = match?.[1] === "proposed" ? ["做法", "考虑过的其他做法", "验收", "风险与代价"]
      : match?.[1] === "implemented" ? ["决定", "考虑过的其他做法", "影响"] : [];
    for (const name of required) {
      if (!names.includes(name)) issues.push(issue(file, "设计记录格式", `缺少 H2：${name}`));
    }
  }
  return issues;
}

const CHECKS: Record<CheckName, (context: CheckContext) => Promise<Issue[]>> = {
  链接: links,
  路径: paths,
  不写提交哈希: hashes,
  一段一行: paragraphs,
  篇幅上限: budgets,
  停用词: bannedTerms,
  "包 README 骨架": readmes,
  设计记录格式: notes,
};

export async function runChecks(repo: Repository, settings: Settings): Promise<Issue[]> {
  const context = {
    repo, settings,
    markdown: repo.files.filter((file) => file.endsWith(".md") && inScope(file, settings.exclusions)),
  };
  const issues: Issue[] = [];
  for (const name of CHECK_NAMES) issues.push(...await CHECKS[name](context));
  return issues;
}

export function applyExceptions(issues: Issue[], settings: Settings, files: string[]): Issue[] {
  const result = issues.filter((entry) => !settings.exceptions[entry.check]?.[entry.file]);
  for (const [check, entries] of Object.entries(settings.exceptions)) {
    for (const file of Object.keys(entries)) {
      if (!CHECK_NAMES.includes(check as CheckName) || !files.includes(file)
        || !issues.some((entry) => entry.check === check && entry.file === file)) {
        result.push({ file, line: 1, check, message: "例外已过时，请删掉这条" });
      }
    }
  }
  return result;
}
