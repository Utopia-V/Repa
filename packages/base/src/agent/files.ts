import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createWriteToolDefinition, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { RepaFault } from "../schema.js";
import { existingPath, within } from "../space/paths.js";
import { exactEditTool } from "./edit.js";

/** 文件工具的路径边界：限在空间根目录内，可以再排除 .repa/。 */
export class FileScope {
  private constructor(readonly root: string, private readonly realRoot: string, readonly excludeData: boolean) {}

  static async create(root: string, excludeData: boolean): Promise<FileScope> {
    return new FileScope(root, await realpath(root), excludeData);
  }

  private allowed(root: string, file: string): boolean {
    return within(root, file) && !(this.excludeData && within(path.join(root, ".repa"), file));
  }

  /** 字面路径和解析符号链接后的路径都要在范围内，链接不能把工具带出空间。 */
  async resolve(file: string): Promise<string> {
    const lexical = path.resolve(this.root, file);
    if (this.allowed(this.root, lexical)) {
      const canonical = await existingPath(lexical);
      if (this.allowed(this.realRoot, canonical)) return canonical;
    }
    const message = this.excludeData ? `只能访问当前空间内的文件，不含 .repa/：${file}` : `只能写入当前空间内的文件：${file}`;
    throw new RepaFault("file_outside_space", message, { path: file });
  }
}

/** 通用 Agent 的读取沿用 Pi 默认实现；写入和精确编辑只在空间内，写到空间外就记不进历史。 */
export function generalFileTools(scope: FileScope): ToolDefinition[] {
  return [writeTool(scope), editTool(scope)];
}

function writeTool(scope: FileScope): ToolDefinition {
  return defineTool(createWriteToolDefinition(scope.root, {
    operations: {
      async mkdir(directory) {
        await mkdir(await scope.resolve(directory), { recursive: true });
      },
      async writeFile(file, content) {
        await writeFile(await scope.resolve(file), content, "utf8");
      },
    },
  }));
}

function editTool(scope: FileScope): ToolDefinition {
  return exactEditTool(scope.root, {
    read: async file => readFile(await scope.resolve(file), "utf8"),
    async write(file, text) {
      await writeFile(await scope.resolve(file), text, "utf8");
    },
  });
}
