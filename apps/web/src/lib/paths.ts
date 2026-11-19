/** 路径的最后一段，作为空间的显示名称；Windows 与 POSIX 分隔符都识别。 */
export function folderName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).at(-1) ?? root;
}

// 三个系统里都不能出现在文件名里的字符；按 Windows 的规则，最严的一个，同一个名字在哪台机器上都能用。
const UNSAFE = /[<>:"/\\|?*\u0000-\u001f]/u;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu;

/** 能不能直接用作文件夹名：不改写，不能用就由调用方如实告诉用户。 */
export function validFolderName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !UNSAFE.test(name) && !RESERVED.test(name) && !/[. ]$/u.test(name);
}

/** 在 parent 下接一段路径，分隔符跟着 parent：Windows 的路径用 \，其他用 /。 */
export function joinPath(parent: string, ...names: string[]): string {
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return [parent.replace(/[\\/]+$/u, ""), ...names].join(separator);
}

/**
 * 学习者选了一个位置以后，课程放在哪个文件夹：选的文件夹本身叫 Repa 时就用它，否则在它下面用 Repa 子文件夹。
 * 与缺省的“用户目录下的 Repa”一致，也与 Windows 安装程序选安装位置时的做法一致：选 D:\ 得到 D:\Repa。
 */
export function repaFolderIn(location: string): string {
  return folderName(location).toLowerCase() === "repa" ? location : joinPath(location, "Repa");
}
