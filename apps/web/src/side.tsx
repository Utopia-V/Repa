// 左栏：标识、今日、知识库、文件夹树、最近的学习对话，底部是设置。对话的列表可以筛与换排法。
import { useState } from "react";

import { openTalk } from "./actions";
import { get, type SessionSummary } from "./api";
import { Icon, Mark } from "./glyph";
import { folderLabel, go, hrefOf, update, useApp, useData, viewingFolder, type Route } from "./store";
import { t } from "./strings";
import { IconButton, Pop, Seg, Switch } from "./ui";

const saved = (): string[] => JSON.parse(localStorage.getItem("repa.open") ?? "[]") as string[];

/** 地址链接：点了在应用里换页，不重新加载。 */
function Nav({ route, current, children, depth }: { route: Route; current: boolean; children: React.ReactNode; depth?: number }) {
  return <a href={hrefOf(route)} aria-current={current ? "page" : undefined} style={depth === undefined ? undefined : { "--depth": depth } as React.CSSProperties}
    onClick={(event) => { event.preventDefault(); go(route); }}>{children}</a>;
}

function FolderTree() {
  const { tree, route } = useApp();
  const [open, setOpen] = useState<string[]>(saved);
  const toggle = (path: string, to = !open.includes(path)) => {
    const next = to ? [...new Set([...open, path])] : open.filter((item) => item !== path);
    localStorage.setItem("repa.open", JSON.stringify(next));
    setOpen(next);
  };
  if (!tree) return null;
  const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
  const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const rows: React.ReactNode[] = [];
  const walk = (parent: string, depth: number) => {
    for (const folder of tree.folders.filter((item) => item.path && parentOf(item.path) === parent)) {
      const hasChildren = tree.folders.some((item) => item.path && parentOf(item.path) === folder.path) || tree.materials.some((item) => parentOf(item.path) === folder.path);
      const isOpen = open.includes(folder.path);
      const here = route.page === "folder" && route.path === folder.path;
      rows.push(<Nav key={folder.path} route={{ page: "folder", path: folder.path }} current={here} depth={depth}>
        {hasChildren
          ? <span onClick={(event) => { event.preventDefault(); event.stopPropagation(); toggle(folder.path); }} aria-hidden="true"><Icon name="chevron-right" className={isOpen ? "chev open" : "chev"} /></span>
          : <span className="nochev" />}
        {folder.name}<span className="n">{folder.count}</span>
      </Nav>);
      if (isOpen) walk(folder.path, depth + 1);
    }
    // 资料（_ 开头的文件夹、仓库与其他文件）只列出，界面不预览
    for (const item of tree.materials.filter((material) => parentOf(material.path) === parent && parent !== "")) {
      rows.push(<a key={item.path} className="mat" style={{ "--depth": depth } as React.CSSProperties}><span className="nochev" />{nameOf(item.path)}</a>);
    }
  };
  walk("", 0);
  return <div className="tree">{rows}</div>;
}

function Talks() {
  const { talk, statuses, route } = useApp();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"here" | "all">("all");
  const [reviews, setReviews] = useState(false);
  const [sort, setSort] = useState<"recent" | "oldest" | "folder">("recent");
  const [filtering, setFiltering] = useState(false);
  const folder = scope === "here" ? viewingFolder(route) ?? talk?.folder ?? "" : undefined;
  const changes = Object.values(statuses).map((status) => `${status.id}${status.running}${status.waiting}`).join();
  const { data } = useData(() => get<{ sessions: SessionSummary[] }>("/api/sessions", { folder, q: q || undefined, reviews: reviews ? 1 : undefined, sort }), [folder, q, reviews, sort, changes]);
  return <>
    <div className="talk-h">
      <h2><Icon name="messages-square" />{t("nav.talks")}
        <Pop open={filtering} onOpenChange={setFiltering} trigger={<IconButton icon="list-filter" label={t("talks.filter")} />}>
          <div className="pop-search"><Icon name="search" /><input aria-label={t("talks.keyword")} value={q} onChange={(event) => setQ(event.target.value)} /></div>
          <Seg label={t("talks.scope")} value={scope} onChange={setScope} items={[["here", t("talks.here")], ["all", t("talks.all")]]} />
          <label className="pop-row"><span>{t("talks.reviews")}</span><Switch checked={reviews} onChange={setReviews} label={t("talks.reviews")} /></label>
          <Seg label={t("talks.sort")} value={sort} onChange={setSort} items={[["recent", t("talks.recent")], ["oldest", t("talks.oldest")], ["folder", t("talks.byFolder")]]} />
        </Pop>
      </h2>
    </div>
    <div className="talks">
      {(data?.sessions ?? []).slice(0, 30).map((item) => <a key={item.id} href="#" aria-current={talk?.id === item.id ? "true" : undefined}
        onClick={(event) => { event.preventDefault(); void openTalk(item.folder, { id: item.id }).then(() => item.kind === "review" && go({ page: "review" })); }}>
        <b>{item.title || t("chat.new")}{(statuses[item.id]?.waiting ?? item.waiting) && <i className="wait" aria-label={t("talks.waiting")} />}</b>
        <span>{folderLabel(item.folder, t("nav.kb"))}</span>
      </a>)}
    </div>
  </>;
}

/** 左栏。收起时只剩一个展开的按钮。 */
export function Side() {
  const { side, route, tree, cards } = useApp();
  const { data: today } = useData(() => get<{ dueTotal: number }>("/api/today"), []);
  if (!side) return <nav className="side rail" aria-label={t("nav.today")}><IconButton icon="panel-left" label={t("nav.sideOpen")} expanded={false} onClick={() => update({ side: true })} /></nav>;
  const cardTotal = (cards ?? []).filter((card) => !card.moc).length;
  return <nav className="side">
    <div className="side-top">
      <a className="mark" href="/" onClick={(event) => { event.preventDefault(); go({ page: "today" }); }}><Mark />{t("app.name")}</a>
      <IconButton icon="panel-left" label={t("nav.sideClose")} expanded onClick={() => update({ side: false })} />
    </div>
    <div className="nav">
      <Nav route={{ page: "today" }} current={route.page === "today"}><Icon name="calendar" />{t("nav.today")}<span className={`n${today?.dueTotal ? " due" : ""}`}>{today?.dueTotal ?? ""}</span></Nav>
      <Nav route={{ page: "kb" }} current={route.page === "kb"}><Icon name="library" />{t("nav.kb")}<span className="n">{cards ? cardTotal : ""}</span></Nav>
    </div>
    <h2><Icon name="folder" />{t("nav.folders")}</h2>
    {tree && <FolderTree />}
    <Talks />
    <div className="side-foot"><div className="nav"><Nav route={{ page: "settings" }} current={route.page === "settings"}><Icon name="settings" />{t("nav.settings")}</Nav></div></div>
  </nav>;
}
