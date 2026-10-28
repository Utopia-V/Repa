/**
 * 请宿主在系统文件管理器里选中文件。开发时由 Vite 开发服务器承担，只接受反馈包；
 * 失败时抛错，调用方留着路径让用户自己打开。
 */
export async function revealFile(path: string): Promise<void> {
  const response = await fetch("/__repa/reveal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (response.status === 404) throw new Error("找不到这个文件，可能已经被移动或删除。");
  if (!response.ok) throw new Error("无法打开所在文件夹。");
}
