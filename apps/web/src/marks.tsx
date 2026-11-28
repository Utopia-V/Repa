// 勾画与批注，写在卡片自己的 Markdown 里：勾画是 ==被勾画的话==，紧跟一个脚注 [^a1] 就是它的批注，脚注正文在文件末尾。
// 记号就在那句话上，正文怎么改它都跟着走；Obsidian 认这两种写法，可以手写，Agent 读卡片时也看得到。
// 勾画不跨段，代码和公式里不勾画；把选区对回原文只认逐字相同、位置唯一确定的一处，对不准就不勾画。
import { useState } from "react";

import { IconButton, AutoText, keyOf } from "./ui";
import { t } from "./strings";
import { useApp } from "./store";

/** 原文里的一处勾画。start、end 是整个 ==…==[^id] 在正文里的位置。 */
export interface Mark {
  start: number;
  end: number;
  text: string;
  id?: string;
  note?: string;
}

// 代码、行内代码与公式换成等长的空白，位置不变，里面的 == 不算勾画
const mask = (body: string) => body.replace(/```[\s\S]*?(```|$)|`[^`\n]*`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$/gu, (part) => part.replace(/[^\n]/g, " "));
const MARK = /==(?=\S)([^\n=]*?\S)==(\[\^([^\]\s]+)\])?/gu;
const DEF = (id: string) => new RegExp(`^\\[\\^${id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\]:[ \\t]*(.*)$\\n?`, "mu");

/** 正文里的全部勾画，按先后。 */
export function findMarks(body: string): Mark[] {
  return [...mask(body).matchAll(MARK)].map((match) => {
    const start = match.index;
    const end = start + match[0].length;
    const id = match[3];
    const note = id ? DEF(id).exec(body)?.[1] : undefined;
    return { start, end, text: body.slice(start + 2, start + 2 + (match[1]?.length ?? 0)), ...(id ? { id } : {}), ...(note === undefined ? {} : { note }) };
  });
}

/**
 * 把选中的一段话勾画上。block 是选区所在的那一块（段落、列表项、表格的格、标题、引用）在原文里的起止位置；
 * 选区是这一块可见文字里同样文字的第 index 处（从 0 数），这一块一共 rendered 处。原文的这一块里也必须恰好有
 * 同样多处逐字相同、不在代码、公式、链接、图片和已有勾画里的地方，才取第 index 处，对不上返回 undefined。
 * 只在一块里对：被隐藏的脚注正文、别的段落里的链接文字都不在这一块里，不会和选区抵消。
 */
export function addMark(body: string, text: string, index: number, rendered: number, block: [number, number]): { body: string; start: number } | undefined {
  // 链接和图片整个遮住，界面上这些地方的字也不算（见 card.tsx 的 visibleText），两边按同样的规矩数
  const masked = mask(body).replace(/!?\[\[[^\]\n]*\]\]|!?\[[^\]\n]*\]\([^)\n]*\)|\[\^[^\]\n]*\]/gu, (part) => " ".repeat(part.length));
  const taken = findMarks(body);
  const spots: number[] = [];
  for (let at = masked.indexOf(text, block[0]); at >= 0 && at + text.length <= block[1]; at = masked.indexOf(text, at + 1)) {
    if (body.slice(at, at + text.length) === text && !taken.some((mark) => at < mark.end && at + text.length > mark.start)) spots.push(at);
  }
  const at = spots[index];
  if (spots.length !== rendered || at === undefined || text.includes("\n") || text.includes("==")) return undefined;
  return { body: `${body.slice(0, at)}==${text}==${body.slice(at + text.length)}`, start: at };
}

/** 给一处勾画写批注；note 为空就去掉批注。先在原文上换掉勾画，再删旧的脚注正文：脚注正文写在勾画前面时，位置也不会错。 */
export function setNote(body: string, mark: Mark, note: string): string {
  const clean = note.replace(/\s*\n\s*/gu, " ").trim();
  const id = mark.id ?? Array.from({ length: 999 }, (_, n) => `a${n + 1}`).find((name) => !body.includes(`[^${name}]`)) ?? "a0";
  let next = `${body.slice(0, mark.start)}==${mark.text}==${clean ? `[^${id}]` : ""}${body.slice(mark.end)}`;
  if (mark.id) next = next.replace(DEF(mark.id), "");
  if (!clean) return next;
  return `${next.replace(/\s*$/u, "")}\n\n[^${id}]: ${clean}\n`;
}

/** 去掉一处勾画和它的批注，那句话留下。 */
export function removeMark(body: string, mark: Mark): string {
  const next = `${body.slice(0, mark.start)}${mark.text}${body.slice(mark.end)}`;
  return mark.id ? next.replace(DEF(mark.id), "") : next;
}

interface MdNode { type: string; value?: string; identifier?: string; children?: MdNode[]; data?: Record<string, unknown> }

/** remark 插件：文字里的 ==…== 渲染成 mark.hl，按先后编号；紧跟的批注脚注换成一个小上标，它的脚注正文不显示。 */
export function remarkMarks() {
  return (tree: MdNode) => {
    let count = 0;
    let noted = 0;
    const hidden = new Set<string>();
    const walk = (node: MdNode) => {
      if (!node.children) return;
      const out: MdNode[] = [];
      for (const child of node.children) {
        const last = out.at(-1);
        if (child.type === "footnoteReference" && last?.data?.hName === "mark" && child.identifier) {
          hidden.add(child.identifier);
          out.push({ type: "fn", data: { hName: "sup", hProperties: { className: ["fn"] }, hChildren: [{ type: "text", value: String(++noted) }] } });
          continue;
        }
        if (child.type !== "text" || !child.value?.includes("==")) {
          walk(child);
          out.push(child);
          continue;
        }
        let rest = child.value;
        for (const match of child.value.matchAll(/==(?=\S)([^\n=]*?\S)==/gu)) {
          const before = rest.slice(0, rest.indexOf(match[0]));
          if (before) out.push({ type: "text", value: before });
          out.push({ type: "mark", data: { hName: "mark", hProperties: { className: ["hl"], dataHl: count++ } }, children: [{ type: "text", value: match[1] ?? "" }] });
          rest = rest.slice(before.length + match[0].length);
        }
        if (rest) out.push({ type: "text", value: rest });
      }
      node.children = out;
    };
    walk(tree);
    tree.children = tree.children?.filter((node) => !(node.type === "footnoteDefinition" && node.identifier && hidden.has(node.identifier)));
  };
}

/** 勾画便签：按正文先后列出每一处；停在一条上，正文里那句话加深，点一条滚到那句话。可以补批注、改批注、去掉勾画。 */
export function MarksList({ marks, editing, onHot, onEdit, onNote, onRemove }: {
  marks: Mark[]; editing: number | undefined; onHot: (index: number | undefined) => void; onEdit: (index: number | undefined) => void;
  onNote: (mark: Mark, note: string) => void; onRemove: (mark: Mark) => void;
}) {
  const { settings } = useApp();
  const [draft, setDraft] = useState<string>();
  return <ul className="marks">{marks.map((mark, index) => <li key={`${mark.start}${mark.text}`} onMouseEnter={() => onHot(index)} onMouseLeave={() => onHot(undefined)}
    onClick={() => document.querySelector(`mark.hl[data-hl="${index}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" })}>
    <p className="mk-q"><mark className="hl">{mark.text}</mark></p>
    {editing === index
      ? <AutoText className="mk-in" rows={2} autoFocus aria-label={t("marks.note")} value={draft ?? mark.note ?? ""} onClick={(event) => event.stopPropagation()} onChange={(event) => setDraft(event.target.value)}
        enter={() => { onNote(mark, draft ?? mark.note ?? ""); setDraft(undefined); }} enterKey={keyOf(settings?.keys, "send")}
        onKeyDown={(event) => { if (event.key === "Escape") { setDraft(undefined); onEdit(undefined); } }}
        onBlur={() => { if (draft !== undefined) onNote(mark, draft); setDraft(undefined); onEdit(undefined); }} />
      : mark.note && <p className="mk-n">{mark.note}</p>}
    <span className="mk-acts" onClick={(event) => event.stopPropagation()}>
      <IconButton icon="pencil" label={t("marks.note")} onClick={() => onEdit(index)} />
      <IconButton icon="x" label={t("marks.remove")} onClick={() => onRemove(mark)} />
    </span>
  </li>)}</ul>;
}
