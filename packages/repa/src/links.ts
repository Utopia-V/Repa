// 卡片之间的 [[链接]]：后端用它算先修、MOC 和反向链接，界面用它在正文和回复里渲染可点的链接，两边共用这一份规则。

/** 一处 [[链接]]：`[[页表]]`、`[[页表|PT]]`、`[[第9章/页表#多级]]`；前面带 `!` 的是嵌入。 */
export const WIKI_LINK = /(!?)\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|([^\]\n]+))?\]\]/gu;

/** 文本里所有 [[链接]] 的目标，不含嵌入，保持出现的顺序。 */
export function wikiTargets(text: string): string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(WIKI_LINK)) {
    const target = match[2]?.trim();
    if (match[1] !== "!" && target) targets.push(target);
  }
  return targets;
}

/** 卡片路径（相对知识库、以 / 分隔）对应的标题：文件名去掉 .md。 */
export function titleOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

/** 卡片所在的层，知识库的根是空字符串。 */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * 按标题找链接的目标：写了路径的按路径的结尾匹配；只写标题的，重名时先取同一层的，再取排在最前的。
 * `pages` 是知识库里所有页面（卡片和 MOC）的路径，按路径排好序。
 */
export function resolveLink(pages: readonly string[], fromFolder: string, target: string): string | undefined {
  const bare = target.trim().replace(/\.md$/u, "");
  if (bare.includes("/")) {
    const wanted = `${bare}.md`;
    return pages.find((page) => page === wanted || page.endsWith(`/${wanted}`));
  }
  const matches = pages.filter((page) => titleOf(page) === bare);
  return matches.find((page) => folderOf(page) === fromFolder) ?? matches[0];
}
