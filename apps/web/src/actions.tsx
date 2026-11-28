// 几处页面共用的动作：开对话、开始复习、按标题打开或新建卡片，以及日期的写法。
import { useMemo, type ReactNode } from "react";

import { resolveLink } from "@repa/links";

import { openSession, put } from "./api";
import type { MarkdownLinks } from "./markdown";
import { go, refresh, update, useApp } from "./store";
import { t } from "./strings";

/** 打开一段对话并把对话面板打开：给了 id 就是它，fresh 新开一段，否则接着这个文件夹最近的学习对话。 */
export async function openTalk(folder: string, options: { id?: string; fresh?: boolean } = {}): Promise<void> {
  const info = await openSession({ folder, ...options });
  update({ talk: { id: info.id, folder: info.folder, kind: info.kind }, chat: true });
}

/** 新开一段复习对话，中间空出来，对话独自居中。 */
export async function startReview(path: string): Promise<void> {
  const info = await openSession({ review: path });
  update({ talk: { id: info.id, folder: info.folder, kind: "review", card: path }, chat: true });
  go({ page: "review" });
}

/** 在一个文件夹里新建一张空卡片，打开它。 */
export async function newCard(folder: string, title: string): Promise<void> {
  const path = `${folder ? `${folder}/` : ""}${title.replace(/\.md$/u, "")}.md`;
  await put("/api/card", { path, text: "" });
  refresh();
  go({ page: "card", path });
}

/** YYYY-MM-DD 写成 MM-DD。 */
export const mmdd = (date: string | undefined) => (date ? date.slice(5, 10) : "");

/** 路径里的 . 和 .. 收掉，得到相对知识库的路径。 */
function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

/** 一个文件夹里的链接与图片：[[链接]] 找到卡片就在中间打开，对话不动；找不到的标出来，点了就在这个文件夹新建。 */
export function useLinks(folder: string): MarkdownLinks {
  const { tree } = useApp();
  return useMemo(() => ({
    link: (target: string, children: ReactNode) => {
      const pages = (tree?.pages ?? []).map((page) => page.path);
      const path = resolveLink(pages, folder, target);
      if (path) return <a className="wl" href={`/c/${path}`} onClick={(event) => { event.preventDefault(); go({ page: "card", path }); }}>{children}</a>;
      return <a className="wl broken" href="#" title={t("card.broken")} onClick={(event) => { event.preventDefault(); void newCard(target.includes("/") ? "" : folder, target); }}>{children}</a>;
    },
    image: (src: string) => `/api/file?path=${encodeURIComponent(normalize(`${folder}/${src}`))}`,
  }), [folder, tree]);
}
