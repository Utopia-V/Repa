import { constants } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RepaFault } from "../errors.js";
import type { ExecutionPolicy } from "./schema.js";

const HELPER_PATH = fileURLToPath(new URL("../../resources/sandbox/linux-x64/codex-linux-sandbox", import.meta.url));
const SYSTEM_PATH = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function canonicalPath(value: string): Promise<string> {
  if (!path.isAbsolute(value)) {
    throw new RepaFault("invalid_execution_path", "命令执行权限路径必须是绝对路径。", { path: value });
  }
  try {
    return await realpath(value);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
    const parent = path.dirname(value);
    if (parent === value) {
      throw error;
    }
    return path.join(await canonicalPath(parent), path.basename(value));
  }
}

async function commandPath(cwd: string, policy: ExecutionPolicy): Promise<string> {
  const allowed = policy.mode === "restricted" ? [cwd, ...policy.readPaths, ...policy.writePaths] : undefined;
  const extra: string[] = [];
  for (const candidate of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(candidate) || SYSTEM_PATH.includes(candidate)) {
      continue;
    }
    let canonical: string;
    try {
      if (!(await stat(candidate)).isDirectory()) {
        continue;
      }
      canonical = await canonicalPath(candidate);
    } catch (error) {
      // PATH 目录缺失或落在普通文件下面时跳过，不让宿主无效条目阻止系统命令。
      if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        continue;
      }
      throw error;
    }
    if (!allowed || allowed.some((root) => inside(canonical, root))) {
      extra.push(candidate);
    }
  }
  if (policy.mode === "restricted") {
    for (const root of [...policy.readPaths, ...policy.writePaths]) {
      try {
        if (!(await stat(root)).isDirectory()) {
          continue;
        }
        extra.push(root);
        const bin = path.join(root, "bin");
        try {
          if ((await stat(bin)).isDirectory()) {
            extra.push(bin);
          }
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
            throw error;
          }
        }
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
  return [...new Set([...SYSTEM_PATH, ...extra])].join(path.delimiter);
}

export async function prepareCommand(options: {
  command: string;
  cwd: string;
  policy: ExecutionPolicy;
  protectedPaths: readonly string[];
}): Promise<{ executable: string; args: string[]; env: NodeJS.ProcessEnv; cleanup(): Promise<void> }> {
  if (process.platform !== "linux") {
    throw new RepaFault("execution_platform_unsupported", "当前命令执行器仅支持 Linux。");
  }
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-execution-")));
  const cleanup = async () => { await rm(scratch, { recursive: true, force: true }); };
  try {
    const home = path.join(scratch, "home");
    const temporary = path.join(scratch, "tmp");
    await mkdir(home);
    await mkdir(temporary);
    const shell = ["--noprofile", "--norc", "-c", options.command];
    let policy = options.policy;
    let protectedPaths: string[] = [];
    if (policy.mode === "restricted") {
      try {
        await access(HELPER_PATH, constants.X_OK);
      } catch (error) {
        throw new RepaFault("sandbox_unavailable", "固定 Linux 沙箱 helper 不可用；不会回退为宿主执行。", {
          path: HELPER_PATH,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      protectedPaths = [...new Set((await Promise.all(options.protectedPaths.map(async (value) => [
        path.resolve(value), await canonicalPath(value),
      ]))).flat())];
      if (protectedPaths.some((value) => inside(options.cwd, value))) {
        throw new RepaFault("execution_path_protected", "受保护目录不能作为受限命令的工作目录。");
      }
      const grants = async (values: readonly string[]) => (await Promise.all(values.map(canonicalPath)))
        .filter((value) => !protectedPaths.some((protectedPath) => inside(value, protectedPath)));
      policy = { ...policy, readPaths: await grants(policy.readPaths), writePaths: await grants(policy.writePaths) };
    }
    // 不继承 credentials、代理、BASH_ENV、LD_PRELOAD 或个人 shell 启动配置。
    const shellPath = await commandPath(options.cwd, policy);
    const env: NodeJS.ProcessEnv = {
      // 受限启动先使用系统 PATH；获准的扩展路径在沙箱内交给实际 shell。
      PATH: policy.mode === "restricted" ? SYSTEM_PATH.join(path.delimiter) : shellPath,
      HOME: home,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TERM: "dumb",
      SHELL: "/bin/bash",
    };
    if (policy.mode === "full-access") {
      return { executable: "/bin/bash", args: shell, env, cleanup };
    }
    const entry = (value: string, permission: "read" | "write" | "deny") => ({
      path: { type: "path", path: value }, access: permission,
    });
    const metadataEntries: Array<ReturnType<typeof entry> & { missing_path_behavior: "skip" }> = [];
    for (const root of new Set([options.cwd, ...policy.writePaths])) {
      try {
        if (!(await stat(root)).isDirectory()) {
          continue;
        }
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      // Repa 的状态保护由 protectedPaths 持有，普通空间 metadata 不沿用 Codex 隐式只读规则。
      for (const name of [".git", ".agents", ".codex"]) {
        const value = path.join(root, name);
        const canonical = await canonicalPath(value);
        if (!inside(canonical, root) || protectedPaths.some((protectedPath) => inside(value, protectedPath) || inside(canonical, protectedPath))) {
          continue;
        }
        metadataEntries.push({ ...entry(value, "write"), missing_path_behavior: "skip" });
      }
    }
    const profile = {
      type: "managed",
      file_system: {
        type: "restricted",
        entries: [
          { path: { type: "special", value: { kind: "minimal" } }, access: "read" },
          entry(HELPER_PATH, "read"),
          entry(options.cwd, "write"),
          entry(scratch, "write"),
          ...policy.readPaths.map((value) => entry(value, "read")),
          ...policy.writePaths.map((value) => entry(value, "write")),
          ...metadataEntries,
          ...protectedPaths.map((value) => entry(value, "deny")),
        ],
      },
      network: policy.network ? "enabled" : "restricted",
    };
    return {
      executable: HELPER_PATH,
      args: [
        "--sandbox-policy-cwd", options.cwd, "--permission-profile", JSON.stringify(profile), "--",
        "/usr/bin/env", `PATH=${shellPath}`, "/bin/bash", ...shell,
      ],
      env,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
