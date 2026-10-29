import path from "node:path";

import ts from "typescript";

import type { Issue, Repository } from "./context.js";

export function documentation(node: ts.Node): string {
  const owner = ts.isVariableDeclaration(node) ? node.parent.parent : node;
  return ts.getJSDocCommentsAndTags(owner)
    .filter(ts.isJSDoc)
    .map((doc) => typeof doc.comment === "string" ? doc.comment : doc.comment?.map((part) => part.text).join("") ?? "")
    .join("\n").trim();
}

function exportPaths(value: unknown): string[] {
  if (typeof value === "string") return /\.(?:[cm]?js|ts)$/.test(value) ? [value] : [];
  if (value && typeof value === "object") return Object.values(value).flatMap(exportPaths);
  return [];
}

type ExportDeclaration = ts.FunctionDeclaration | ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.VariableDeclaration;

export async function exportedDeclarations(repo: Repository, directory: string): Promise<ExportDeclaration[]> {
  const manifest = JSON.parse(await repo.text(`${directory}/package.json`)) as { exports?: unknown };
  const entries = [...new Set(exportPaths(manifest.exports).map((entry) =>
    path.resolve(repo.root, directory, entry.replace(/^\.\/dist\//, "src/").replace(/(?:\.d)?\.(?:[cm]?js|ts)$/, ".ts"))))];
  const program = ts.createProgram(entries, { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
  const checker = program.getTypeChecker();
  const declarations = new Set<ExportDeclaration>();
  for (const entry of entries) {
    const source = program.getSourceFile(entry);
    const module = source && checker.getSymbolAtLocation(source);
    if (!module) throw new Error(`找不到导出入口：${entry}`);
    for (let symbol of checker.getExportsOfModule(module)) {
      if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      for (const declaration of symbol.declarations ?? []) {
        const file = path.relative(repo.root, declaration.getSourceFile().fileName).split(path.sep).join("/");
        if (!file.startsWith(`${directory}/src/`)) continue;
        if (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)
          || ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)
          || ts.isVariableDeclaration(declaration)) declarations.add(declaration);
      }
    }
  }
  return [...declarations];
}

export async function exportComments(repo: Repository): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const directory of ["packages/base", "packages/space-history", "packages/learning", "packages/learning-model"]) {
    if (!repo.files.includes(`${directory}/package.json`)) continue;
    for (const node of await exportedDeclarations(repo, directory)) {
      if (documentation(node)) continue;
      const source = node.getSourceFile();
      issues.push({
        file: path.relative(repo.root, source.fileName).split(path.sep).join("/"),
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        check: "导出说明注释",
        message: `${node.name?.getText(source) ?? "默认导出"} 缺少非空的 /** … */ 说明注释`,
      });
    }
  }
  return issues;
}
