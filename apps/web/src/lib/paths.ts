/** 路径的最后一段，作为空间的显示名称；Windows 与 POSIX 分隔符都识别。 */
export function folderName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).at(-1) ?? root;
}
