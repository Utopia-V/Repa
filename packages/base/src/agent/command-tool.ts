import { getShellConfig } from "@earendil-works/pi-coding-agent";

/** 运行命令的 Pi 内置工具。插件声明 Agent 工具时只写 bash，底座按这台机器换成实际的那一个。 */
export type CommandTool = "bash" | "powershell";

/**
 * 这台机器上运行命令用哪个工具。Windows 上找不到 bash 时，Pi 的 bash 工具每次调用都失败，
 * 模型读到的是“去装 Git for Windows”；PowerShell 在 Windows 10、11 上总是有，换成 Pi 的 powershell。
 * findBash 返回 bash 的路径，找不到时抛错；默认用 Pi 自己的 getShellConfig，与 bash 工具执行时的查找一致，
 * shellPath 是 Pi 设置里指定的 bash。Windows 上它会同步运行一次 where，所以只在后端启动时判断一次。
 */
export function detectCommandTool(
  platform: NodeJS.Platform,
  shellPath: string | undefined,
  findBash: (shellPath: string | undefined) => string = path => getShellConfig(path).shell,
): CommandTool {
  if (platform !== "win32") return "bash";
  let shell: string;
  try {
    shell = findBash(shellPath);
  } catch {
    return "powershell";
  }
  // PATH 里的 System32\bash.exe 和 WindowsApps\bash.exe（从商店装的 WSL 的执行别名）是 WSL 的启动器：
  // 没装发行版时只会报错，装了也在另一套文件系统里运行。
  return wslLauncher(shell) ? "powershell" : "bash";
}

function wslLauncher(shell: string): boolean {
  const path = shell.replaceAll("/", "\\").toLowerCase();
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/u.test(path) || path.endsWith("\\microsoft\\windowsapps\\bash.exe");
}
