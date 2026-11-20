import { opendir, readFile } from "node:fs/promises";
import path from "node:path";

import { Type } from "typebox";
import { Check } from "typebox/value";

import { RepaFault } from "../schema.js";

/**
 * 向下查找空间时最多访问的文件夹数。一个人的课程文件夹在几百个以内；超过时如实拒绝，不当作里面没有空间。
 * 两万个文件夹在机械硬盘上约需数秒，学习者选错了文件夹（例如整个主目录）时不至于长时间无响应。Repa 的假设。
 */
export const NESTING_SCAN_LIMIT = 20_000;

/** 有效的空间格式标记，包括当前程序尚不能打开的更新版本。浏览文件夹时也用它标出已有的空间。 */
export async function isSpace(directory: string): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(directory, ".repa", "format.json"), "utf8"));
    return Check(Type.Object({ version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }), value);
  } catch {
    return false;
  }
}

/**
 * 本阶段不允许空间套空间：一个人的学习记录、菜单与 XP 属于一个空间，套在一起时外层空间的历史、备份和文件工具会伸进内层，
 * 两边各算一份。root 是已经解析过的真实路径。祖先里有空间时拒绝；root 本身还不是空间时，再向下找，遇到第一个空间就拒绝，
 * 访问的文件夹超过 NESTING_SCAN_LIMIT 或有读不了的文件夹时也拒绝，说明没有查完，不猜为没有。已经是空间的文件夹只查祖先：
 * 它下面若有空间，是在本检查之前形成的，打开它不会让情形变坏。向下不跟随符号链接，也不进入点开头的文件夹（.git、.repa 一类），
 * 那里不是学习者放课的地方。两个进程同时各建父子空间的竞争不处理。
 */
export async function refuseNesting(root: string): Promise<void> {
  for (let current = root, parent = path.dirname(root); parent !== current; current = parent, parent = path.dirname(parent)) {
    if (await isSpace(parent)) throw nested(parent, "ancestor");
  }
  if (await isSpace(root)) return;
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.shift() as string;
    if (++visited > NESTING_SCAN_LIMIT) {
      throw new RepaFault("nesting_unchecked", `此文件夹下的子文件夹过多，无法确认其中没有别的空间，未予打开：${root}`, { path: root, limit: NESTING_SCAN_LIMIT });
    }
    let handle;
    try {
      handle = await opendir(directory);
    } catch (error) {
      if (directory === root && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new RepaFault("nesting_unchecked", `无法读取文件夹 ${directory}，不能确认其中没有别的空间，未予打开。`, { path: directory });
    }
    for await (const entry of handle) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const child = path.join(directory, entry.name);
      if (await isSpace(child)) throw nested(child, "descendant");
      pending.push(child);
    }
  }
}

function nested(found: string, relation: "ancestor" | "descendant"): RepaFault {
  const text = relation === "ancestor"
    ? `此文件夹位于另一个空间之内：${found}。空间不能相互嵌套。`
    : `此文件夹之内已有别的空间：${found}。空间不能相互嵌套。`;
  return new RepaFault("nested_space", text, { path: found, relation });
}
