// 对话里的各项：学习者的话、Agent 的回答、收起的工具活动、改动与差异、题目卡片和确认卡片。
// 判定落在题目卡片上：grade 的结果按练习的 id 接回它判定的那次出题。
import { useEffect, useRef, useState } from "react";

import type { Item, Pending } from "@repa/protocol";

import { startReview, useLinks } from "./actions";
import { get, post, type CardSummary, type Change, type Today } from "./api";
import { Glyph, Icon, stoneOf } from "./glyph";
import type { IconName } from "./icons";
import { Markdown } from "./markdown";
import { go, update, useApp } from "./store";
import { t, type TextKey } from "./strings";
import { AutoText, IconButton, keyOf } from "./ui";

type Tool = Extract<Item, { type: "tool" }>;
type Result = "pass" | "partial" | "fail";
type Question = { text: string; options?: string[] };

const ICONS: Record<string, IconName> = { read: "file-text", bash: "terminal", grep: "search", find: "search", ls: "folder", kb_search: "search", kb_browse: "folder", practice_history: "list-checks", grade: "check" };
const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls", "kb_search", "kb_browse", "practice_history", "grade", "quiz"];
const label = (name: string) => (TOOLS.includes(name) ? t(`tool.${name}` as TextKey) : name);

/** 收起的一行工具活动，点开看输出。 */
function Act({ item }: { item: Tool }) {
  const [open, setOpen] = useState(false);
  const target = str(item.args.path) ?? str(item.args.command) ?? str(item.args.query) ?? str(item.args.pattern) ?? str(item.args.card) ?? str(item.args.folder) ?? "";
  return <div>
    <button type="button" className="act" aria-expanded={open} data-run={item.done ? undefined : ""} data-err={item.isError ? "" : undefined} onClick={() => setOpen(!open)}>
      <Icon name={ICONS[item.name] ?? "file-text"} />{label(item.name)}{target && <code>{item.name === "read" ? nameOf(target) : target}</code>}<Icon name="chevron-right" className={open ? "chev open" : "chev"} />
    </button>
    {open && item.output && <pre className="act-out">{item.output}</pre>}
  </div>;
}

/** 一次改动：增删的行数和“撤回”，展开是逐行的差异。撤回以后可以恢复。 */
function ChangeRow({ item, path }: { item: Tool; path: string }) {
  const [open, setOpen] = useState(false);
  const [change, setChange] = useState<Change>();
  const [undone, setUndone] = useState<string>();
  useEffect(() => {
    if (item.done && !item.isError) void get<Change>("/api/change", { path, tool: item.id }).then(setChange);
  }, [item.done, item.isError, item.id, path]);
  const lines = (change?.diff ?? []).flatMap((part) => part.value.replace(/\n$/u, "").split("\n").map((text) => ({ text, kind: part.added ? "add" : part.removed ? "del" : "same" })));
  const added = lines.filter((line) => line.kind === "add").length;
  const removed = lines.filter((line) => line.kind === "del").length;
  // 没改的行只留改动前后各一行
  const near = (index: number) => [index - 1, index, index + 1].some((other) => lines[other] && lines[other].kind !== "same");
  const flip = async () => {
    if (!change) return;
    const { saved } = await post<{ saved: string }>("/api/revert", { path, version: undone ?? change.version });
    setUndone(undone ? undefined : saved);
  };
  return <div className="change">
    <div className="change-head">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevron-down" : "chevron-right"} className="chev" /><span>{t(change?.created ? "change.created" : "change.edit")} <code>{nameOf(path)}</code>{change && <span className="delta num">+{added} −{removed}</span>}</span>
      </button>
      {change && <IconButton icon={undone ? "redo-2" : "undo-2"} label={t(undone ? "change.redo" : "change.undo")} onClick={() => void flip()} />}
    </div>
    {open && <div className="diff">{lines.map((line, index) => (line.kind !== "same" || near(index) ? <div key={index} className={line.kind}>{line.text}</div> : null))}</div>}
  </div>;
}

/** 复习判定以后：下一张，或者回到今日。不自动跳，可能还想就这一张再问几句。 */
function After({ card }: { card?: string }) {
  const [next, setNext] = useState<CardSummary | null>();
  const { tick } = useApp();
  useEffect(() => {
    void get<Today>("/api/today").then((today) => setNext([...today.due, ...today.fresh].find((item) => item.path !== card) ?? null));
  }, [card, tick]);
  return <div className="after">
    {next && <button type="button" className="btn btn-solid next" onClick={() => void startReview(next.path)}>
      <span className="next-w">{t("quiz.next")}</span><Glyph stone={stoneOf(next)} size={18} /><span className="next-n">{next.title}</span>
    </button>}
    <button type="button" className="btn btn-text" onClick={() => { update({ chat: false, talk: undefined }); go({ page: "today" }); }}>{t("quiz.backToday")}</button>
  </div>;
}

/** 题目卡片。等作答时整张一次提交：回车跳到下一题，到最后一题时提交，Shift+回车换行；“跳过”记为没有作答。判定以后落在作答的位置。 */
function Quiz({ item, pending, grade, folder, after }: { item: Tool; pending?: Pending; grade?: { result: Result; note: string }; folder: string; after: boolean }) {
  const { settings } = useApp();
  const links = useLinks(folder);
  const questions = ((pending?.kind === "quiz" ? pending.questions : item.args.questions) ?? []) as Question[];
  const details = item.details as { card?: string; answers?: string[] | null } | undefined;
  const card = (pending?.kind === "quiz" ? pending.card : undefined) ?? details?.card;
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ""));
  const form = useRef<HTMLFormElement>(null);
  const reply = (value: string[] | null) => void post(`/api/pending/${encodeURIComponent(item.id)}`, { answers: value });
  const focusNext = (index: number) => {
    const next = form.current?.querySelectorAll<HTMLElement>("[data-q]")[index + 1];
    if (next) next.focus();
    else reply(answers);
  };
  const set = (index: number, value: string) => setAnswers(answers.map((answer, other) => (other === index ? value : answer)));
  const of = card && <p className="quiz-of"><a href="#" onClick={(event) => { event.preventDefault(); go({ page: "card", path: card }); }}>{nameOf(card).replace(/\.md$/u, "")}</a></p>;
  const text = (question: Question, index: number) => <div className="q-text"><span className="no">{index + 1}</span><Markdown text={question.text} links={links} /></div>;
  if (pending) {
    return <form ref={form} className="quiz" aria-label={t("tool.quiz")} onSubmit={(event) => { event.preventDefault(); reply(answers); }}>
      {of}
      <ol className="qs">{questions.map((question, index) => <li key={index} className="q">
        {text(question, index)}
        {question.options?.length
          ? <ul className="opts" role="radiogroup">{question.options.map((option) => <li key={option}>
            <button type="button" className="opt" role="radio" data-q={option === question.options?.[0] ? "" : undefined} aria-checked={answers[index] === option} onClick={() => { set(index, option); }}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); set(index, option); focusNext(index); } }}><span className="radio" />{option}</button>
          </li>)}</ul>
          : <AutoText className="answer" data-q="" aria-label={t("quiz.answer", { n: index + 1 })} autoFocus={index === 0} value={answers[index] ?? ""} onChange={(event) => set(index, event.target.value)} enter={() => focusNext(index)} enterKey={keyOf(settings?.keys, "submit")} />}
      </li>)}</ol>
      <p className="quiz-foot"><button type="submit" className="btn btn-solid">{t("quiz.submit")}</button><button type="button" className="btn btn-text" onClick={() => reply(null)}>{t("quiz.skip")}</button></p>
    </form>;
  }
  const given = details?.answers;
  const mark = grade && grade.result !== "partial" ? grade.result : undefined;
  return <><div className="quiz" aria-label={t("tool.quiz")}>
    {of}
    <ol className="qs">{questions.map((question, index) => <li key={index} className="q" data-v={mark}>
      {text(question, index)}
      {given === null
        ? index === 0 && <p className="said">{t("quiz.noAnswer")}</p>
        : question.options?.length && mark
          ? <p className="said picked"><Icon name={mark === "pass" ? "check" : "x"} className={`judged ${mark === "pass" ? "ok" : "no"}`} />{given?.[index]}</p>
          : <p className="said">{given?.[index] || "—"}</p>}
    </li>)}</ol>
    {grade && <p className="verdict" data-v={grade.result}><b>{t(`quiz.${grade.result}`)}</b><span>{grade.note}</span></p>}
  </div>{after && grade && <After {...(card ? { card } : {})} />}</>;
}

/** 确认卡片：允许才执行；拒绝以后可以写一句理由。 */
function Confirm({ pending }: { pending: Extract<Pending, { kind: "confirm" }> }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const { settings } = useApp();
  const reply = (approve: boolean) => void post(`/api/pending/${encodeURIComponent(pending.id)}`, { approve, ...(reason.trim() ? { reason: reason.trim() } : {}) });
  const bash = pending.tool === "bash";
  return <div className={`confirm${rejecting ? " rejected" : ""}`}>
    <p className="quiz-of">{bash ? t("confirm.bash") : t("confirm.edit", { target: nameOf(pending.target) })}</p>
    <pre><code>{bash && <span className="ps">$</span>}{pending.target}</code></pre>
    {rejecting
      ? <div className="reason"><AutoText aria-label={t("confirm.reason")} autoFocus value={reason} onChange={(event) => setReason(event.target.value)} enter={() => reply(false)} enterKey={keyOf(settings?.keys, "send")} />
        <button type="button" className="send" data-on="" aria-label={t("chat.send")} data-tip={t("chat.send")} onClick={() => reply(false)}><Icon name="arrow-up" /></button></div>
      : <p className="quiz-foot"><button type="button" className="btn btn-solid" onClick={() => reply(true)}>{t("confirm.allow")}</button><button type="button" className="btn btn-text" onClick={() => setRejecting(true)}>{t("confirm.reject")}</button></p>}
  </div>;
}

/** 对话的全部内容。kind 是 review 时，最后一张判定过的题目卡片下面给出“下一张”。 */
export function Items({ items, pending, running, folder, review }: { items: Item[]; pending: Pending[]; running: boolean; folder: string; review: boolean }) {
  const links = useLinks(folder);
  const grades = new Map<string, { result: Result; note: string }>();
  const quizzes = new Set<string>();
  for (const item of items) {
    if (item.type !== "tool") continue;
    const details = item.details as { quiz?: string; result?: Result; note?: string } | undefined;
    if (item.name === "quiz" && details?.quiz) quizzes.add(details.quiz);
    if (item.name === "grade" && details?.quiz && details.result) grades.set(details.quiz, { result: details.result, note: details.note ?? "" });
  }
  const lastQuiz = items.findLastIndex((item) => item.type === "tool" && item.name === "quiz");
  return <>{items.map((item, index) => {
    switch (item.type) {
      // 复习对话的第一条“复习「…」”是程序替你发的，画稿里不显示
      case "user": return review && index === 0 ? null : <div key={index} className="me">{item.quote && <blockquote>{item.quote}</blockquote>}{item.text}</div>;
      case "assistant": return item.text.trim() ? <Markdown key={index} className="ai" text={item.text} links={links} streaming={running && index === items.length - 1} /> : null;
      case "compaction": return <p key={index} className="compacted">{t("chat.compacted")}</p>;
      case "error": return <p key={index} className="fault">{item.text}</p>;
      case "tool": {
        const waiting = pending.find((card) => card.id === item.id);
        if (waiting?.kind === "confirm") return <Confirm key={item.id} pending={waiting} />;
        const details = item.details as { quiz?: string } | undefined;
        if (item.name === "quiz") {
          const grade = details?.quiz ? grades.get(details.quiz) : undefined;
          return <Quiz key={item.id} item={item} {...(waiting ? { pending: waiting } : {})} {...(grade ? { grade } : {})} folder={folder} after={review && index === lastQuiz && !running} />;
        }
        if (item.name === "grade" && details?.quiz && quizzes.has(details.quiz)) return null;
        if (item.change) return <ChangeRow key={item.id} item={item} path={item.change} />;
        return <Act key={item.id} item={item} />;
      }
    }
  })}</>;
}

