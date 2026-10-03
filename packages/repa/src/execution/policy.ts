import { realpath } from "node:fs/promises";
import path from "node:path";
import { RepaFault } from "../errors.js";
import type { ExecutionPolicy } from "./schema.js";

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function normalizePolicy(policy: ExecutionPolicy, cwd: string): Promise<ExecutionPolicy> {
  if (policy.mode === "full-access") return policy;
  const normalize = async (paths: readonly string[]) => Promise.all(paths.map(async file => {
    try { return await realpath(path.resolve(cwd, file)); }
    catch { throw new RepaFault("execution_path", `执行授权的路径不存在或无法访问：${file}。`); }
  }));
  return { ...policy, readPaths: [...new Set(await normalize(policy.readPaths))], writePaths: [...new Set(await normalize(policy.writePaths))] };
}

export function coversPolicy(granted: ExecutionPolicy, requested: ExecutionPolicy, cwd: string): boolean {
  if (granted.mode === "full-access") return true;
  if (requested.mode === "full-access" || (requested.network && !granted.network)) return false;
  const writes = [cwd, ...granted.writePaths];
  const reads = [...writes, ...granted.readPaths];
  return requested.writePaths.every(file => writes.some(root => within(root, file))) &&
    requested.readPaths.every(file => reads.some(root => within(root, file)));
}

export function extendPolicy(base: ExecutionPolicy, requested: ExecutionPolicy): ExecutionPolicy {
  if (base.mode === "full-access" || requested.mode === "full-access") return { mode: "full-access" };
  return {
    mode: "restricted", network: base.network || requested.network,
    readPaths: [...new Set([...base.readPaths, ...requested.readPaths])],
    writePaths: [...new Set([...base.writePaths, ...requested.writePaths])],
  };
}
