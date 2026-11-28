// The product: today, a task, the knowledge base. One map under everything; the tile you are in becomes the page.
(() => {
  const { h, phrase, tileIcon, MD, Tile } = window;
  const params = new URLSearchParams(location.search);
  if (params.get("dark") === "1") document.documentElement.classList.add("dark");
  const model = window.createRepa({ later: params.get("later") === "1", empty: params.get("empty") === "1", instant: params.has("go"), upTo: params.has("upTo") ? Number(params.get("upTo")) : undefined });
  const forms = window.Forms(model);
  const over = window.Overlays(model);

  // ---- the page's parts, made once

  const app = document.querySelector("#app");
  const backToTask = h("a", { class: "bar-resume", href: "#/learn", hidden: true });
  const offline = h("p", { class: "offline", role: "status", hidden: true }, "连接断开，正在重连。作答没有丢。");
  const findButton = h("button", { type: "button", class: "find-btn", onclick: () => over.openFinder() }, h("span", {}, "搜索"), h("kbd", {}, "/"));
  const bar = h("header", { class: "bar" },
    h("a", { class: "mark", href: "#/", ariaLabel: "Repa", html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 0A12 12 0 0 1 0 12M24 12A12 12 0 0 0 12 24"/></svg>repa' }),
    h("nav", { class: "nav", ariaLabel: "主导航" }, h("a", { href: "#/", dataNav: "today" }, "今天"), h("a", { href: "#/k/", dataNav: "k" }, "知识库")),
    backToTask,
    h("div", { class: "tools" }, findButton, h("a", { class: "tool", href: "#/settings", dataNav: "settings" }, "设置")));
  const ground = h("div", { class: "ground", tabindex: "0", role: "group", ariaLabel: "课程地图" });
  const plan = h("aside", { class: "plan", ariaLabel: "今天" });
  const note = h("div", { class: "plan-note", ariaLive: "polite" });
  const cell = h("section", { class: "cell", ariaLabel: "任务" });
  const wedge = h("div", { class: "wedge", ariaHidden: "true" });
  const world = h("div", { class: "world" }, ground, plan, wedge, cell);
  const libRoot = h("main", { class: "lib" });
  const setRoot = h("main", { class: "settings" });
  app.append(bar, world, libRoot, setRoot, offline);
  const library = window.Library(model, libRoot, forms);

  // ---- routes: every place has an address

  const route = () => {
    const [, name = "", arg = ""] = location.hash.split("/");
    if (name === "learn") return { name: "learn" };
    if (name === "result") return { name: "result" };
    if (["k", "map", "tower"].includes(name)) return { name, arg, lib: true };
    if (name === "settings") return { name };
    return { name: "today" };
  };

  // ---- the map

  let L = { cols: 10, tile: 64, left: 48, top: 88 };
  function fit(count) {
    const W = innerWidth, H = innerHeight;
    const narrow = W < 960;
    const frame = Math.min(W, 1440);
    const availW = narrow ? W - 32 : frame - 48 * 2 - 400 - 64;
    const availH = narrow ? Infinity : H - 88 - 48;
    let best = { cols: 1, tile: 0 };
    for (let cols = 1; cols <= count; cols += 1) {
      const rows = Math.ceil(count / cols);
      const tile = Math.min(112, Math.floor(Math.min(availW / cols, availH / rows)));
      if (tile >= best.tile) best = { cols, tile, rows };
    }
    if (narrow) { best = { cols: 12, tile: Math.floor(availW / 12), rows: Math.ceil(count / 12) }; }
    L = { ...best, left: narrow ? 16 : (W - frame) / 2 + 48, top: 88, narrow };
  }

  let fieldKey = "";
  let tiles = [];
  const UNIT = 96;
  function drawField(v) {
    fit(v.progress.length);
    const key = JSON.stringify([L.cols, L.tile, v.progress.map((e) => [e.passed, e.attempts, Math.round(e.memory * 20), e.current, e.just])]);
    if (key === fieldKey) return;
    fieldKey = key;
    const svg = Tile.element("svg", { viewBox: `0 0 ${L.cols * UNIT} ${L.rows * UNIT}`, class: "tile-field", width: L.cols * L.tile, height: L.rows * L.tile, "aria-hidden": "true" });
    v.progress.forEach((entry, i) => {
      const g = Tile.draw(svg, (i % L.cols) * UNIT, Math.floor(i / L.cols) * UNIT, UNIT, i, entry);
      g.dataset.topic = entry.topic.id;
      if (entry.just) { g.dataset.just = ""; g.querySelectorAll("path").forEach((p) => p.setAttribute("pathLength", "1")); }
    });
    const cursor = Tile.element("rect", { class: "tile-cursor", width: UNIT, height: UNIT, visibility: "hidden" }, svg);
    ground.replaceChildren(svg);
    ground.style.setProperty("--tile", `${L.tile}px`);
    tiles = [...svg.querySelectorAll(".tile")];
    tiles.cursor = cursor;
    if (v.progress.some((e) => e.just)) setTimeout(() => model.actions.settled(), 1400);
  }

  function placeGround(v, inside) {
    if (L.narrow) { ground.style.transform = ""; return; }
    if (inside) {
      const focus = v.task?.focusKp ? v.progress.findIndex((e) => e.kp.id === v.task.focusKp) : Math.floor(v.progress.length / 2);
      const cx = (focus % L.cols + 0.5) * L.tile, cy = (Math.floor(focus / L.cols) + 0.5) * L.tile;
      const scale = (cell.offsetWidth || 760) / L.tile;
      ground.style.transform = `translate(${innerWidth / 2 - cx * scale}px, ${innerHeight / 2 - cy * scale}px) scale(${scale})`;
    } else ground.style.transform = `translate(${L.left}px, ${L.top}px)`;
  }

  const lightTopics = (ids) => {
    ground.toggleAttribute("data-focus", ids.length > 0);
    tiles.forEach((g) => g.toggleAttribute("data-on", ids.includes(g.dataset.topic)));
  };

  let hover = null;
  /** What a tile is: the map answers this for anything you point at or arrive at by keyboard. */
  function focusTile(i) {
    hover = i;
    const v = model.view();
    const entry = i === null ? null : v.progress[i];
    lightTopics(entry ? [entry.topic.id] : []);
    if (tiles.cursor) {
      tiles.cursor.setAttribute("visibility", entry ? "visible" : "hidden");
      if (entry) { tiles.cursor.setAttribute("x", (i % L.cols) * UNIT); tiles.cursor.setAttribute("y", Math.floor(i / L.cols) * UNIT); }
    }
    ground.style.cursor = entry?.readable ? "pointer" : "default";
    paintNote(entry);
  }
  function paintNote(entry) {
    const v = model.view();
    const shown = entry ?? v.progress.find((e) => e.current);
    if (!shown) { note.replaceChildren(); return; }
    note.replaceChildren(
      tileIcon({ id: shown.kp.id, index: shown.index, passed: shown.passed, attempts: shown.attempts, memory: shown.memory }, 32),
      h("div", {},
        h("p", { class: "note-name" }, shown.readable ? shown.kp.name : shown.topic.title),
        h("p", { class: "note-meta" }, shown.readable ? `${shown.topic.title}，${shown.words}` : shown.words)));
  }
  ground.addEventListener("pointermove", (e) => {
    if (route().name !== "today") return;
    const g = e.target.closest?.(".tile");
    const i = g ? Number(g.dataset.index) : null;
    if (i !== hover) focusTile(i);
  });
  ground.addEventListener("pointerleave", () => { if (route().name === "today") focusTile(null); });
  ground.addEventListener("click", (e) => {
    const g = e.target.closest?.(".tile");
    if (!g || route().name !== "today") return;
    const entry = model.view().progress[Number(g.dataset.index)];
    if (entry.readable) location.hash = `#/k/${entry.kp.id}`;
  });
  ground.addEventListener("focus", () => { if (hover === null && route().name === "today" && window.onKeyboard()) focusTile(Math.max(0, model.view().progress.findIndex((e) => e.current))); });
  ground.addEventListener("blur", () => { if (route().name === "today") focusTile(null); });
  ground.addEventListener("keydown", (e) => {
    if (route().name !== "today" || hover === null) return;
    const count = model.view().progress.length;
    const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -L.cols, ArrowDown: L.cols }[e.key];
    if (move) { e.preventDefault(); focusTile(Math.max(0, Math.min(count - 1, hover + move))); }
    if (e.key === "Enter") { const entry = model.view().progress[hover]; if (entry.readable) location.hash = `#/k/${entry.kp.id}`; }
  });

  // ---- today

  const goal = (v) => {
    const met = v.xp.today >= v.xp.goal;
    return h("div", { class: "goal" },
      h("div", { class: "goal-line" }, h("span", {}, `今天 ${v.xp.today} / ${v.xp.goal} XP`), h("span", {}, met ? "目标达到了" : `还差 ${v.xp.goal - v.xp.today}`)),
      h("div", { class: "goal-cells", role: "meter", ariaLabel: "今天的 XP", ariaValuemin: "0", ariaValuemax: String(v.xp.goal), ariaValuenow: String(v.xp.today) },
        ...Array.from({ length: v.xp.goal }, (_, i) => h("i", i < v.xp.today ? { dataOn: "1" } : {}))));
  };

  const CHEV = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5 7.5 6 4 9.5"/></svg>';
  const enter = (id) => { model.actions.start(id); location.hash = "#/learn"; };
  function taskRow(item, first, met) {
    const body = [
      h("span", { class: "task-top" }, h("span", { class: "task-kind" }, item.kindName), item.why ? h("span", { class: "task-why" }, item.why) : null, h("span", { class: "task-xp" }, `${item.xp} XP`)),
      h("span", { class: "task-title" }, phrase(item.title)),
    ];
    if (first && !met) body.push(h("span", { class: "task-go" }, "开始", h("span", { class: "chev", html: CHEV })));
    return h("button", { type: "button", class: `task${first && !met ? " task-first" : ""}`, onclick: () => enter(item.id), onpointerenter: () => lightTopics(item.topicIds), onpointerleave: () => lightTopics([]), onfocus: () => lightTopics(item.topicIds), onblur: () => lightTopics([]) }, ...body);
  }

  const ago = (t) => (t.closed && t.deadline ? clockText(t.deadline) : "");
  const clockText = (deadline) => {
    const left = Math.max(0, deadline - Date.now());
    return `${String(Math.floor(left / 60000)).padStart(2, "0")}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")}`;
  };
  const whereWords = (t) => {
    if (t.stage === "completed") return "已结束";
    if (t.stage === "explanation") return "讲解";
    if (t.stage === "example") return "例题";
    return `第 ${Math.min(t.qi + 1, t.total)} / ${t.total} 题`;
  };
  function resumeBlock(t) {
    return h("div", { class: "resume" },
      h("a", { class: "task task-first", href: "#/learn" },
        h("span", { class: "task-top" }, h("span", { class: "task-kind" }, t.kindName), h("span", { class: "task-why" }, whereWords(t)), t.deadline ? h("span", { class: "task-xp clock", dataClock: "1" }, clockText(t.deadline)) : null),
        h("span", { class: "task-title" }, phrase(t.restricted ? t.kindName : t.title)),
        h("span", { class: "task-go" }, "继续", h("span", { class: "chev", html: CHEV }))),
      t.stage === "completed" ? null : h("button", { type: "button", class: "link-btn resume-abort", onclick: () => over.confirm({ title: `中止这次${t.kindName}？`, body: t.kind === "lesson" ? "已通过的知识点会保留。" : t.kind === "review" ? "已有的作答仍然计入。" : "没有作答的题按答错计。", yes: "中止", onYes: () => model.actions.abort() }) }, "中止"));
  }

  const titleOf = (q) => {
    const text = (q.body ?? "").replace(/```[\s\S]*?```/g, "").split("\n").map((line) => line.replace(/^>\s?/, "").trim()).find(Boolean);
    return (text ?? q.slots[0].prompt ?? "题目").replace(/[`*]/g, "").slice(0, 48);
  };

  let askText = "";
  function askForm(onSent) {
    const input = h("input", { type: "text", class: "ask-input", placeholder: "问一下", ariaLabel: "问辅导", autocomplete: "off", value: askText, oninput: (e) => { askText = e.target.value; } });
    return h("form", { class: "ask", onsubmit: (e) => {
      e.preventDefault();
      const text = input.value;
      if (!text.trim()) return;
      input.value = "";
      askText = "";
      model.actions.ask(text);
      onSent?.();
    } }, input, h("button", { type: "submit", class: "ask-send", ariaLabel: "发送", html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>' }));
  }

  function renderPlan(v) {
    const met = v.xp.today >= v.xp.goal;
    const tasks = v.task ? resumeBlock(v.task)
      : v.menu.length ? h("div", { class: "tasks" }, ...v.menu.map((item, i) => taskRow(item, i === 0, met)))
        : h("div", { class: "plan-empty" }, h("p", { class: "plan-empty-title" }, "现在没有可做的任务"), h("p", {}, "11 月 6 日 18:40 可以重学"));
    plan.replaceChildren(...[
      h("h1", { class: "plan-course" }, phrase(v.course.title)),
      goal(v),
      tasks,
      v.last ? h("a", { class: "link-btn plan-last", href: "#/result" }, `看刚才的${v.last.kindName}结果`) : null,
      v.shut ? null : askForm(() => over.openSheet(model.view(), askForm())),
      note].filter(Boolean));
    paintNote(null);
  }

  // ---- a task

  const fmtOutcome = { passed: "通过", failed: "没有通过", timeout: "时间到", unresolved: "还有作答在判" };

  function pathBar(t) {
    const flex = (seg) => (seg.kind === "read" ? 2 : 1);
    return h("div", { class: "path", role: "img", ariaLabel: t.restricted ? `第 ${t.qi + 1} 题，共 ${t.total} 题` : "这节课的进度" },
      ...t.path.map((group) => h("div", { class: "path-group", style: `flex:${group.reduce((a, s) => a + flex(s), 0)}` },
        ...group.map((seg) => h("i", { style: `flex:${flex(seg)}`, dataState: seg.state })))));
  }

  /** "Earlier in this lesson" is a real place: what has passed in this topic can be reread, unless an answer is outstanding. */
  function kpSwitch(t) {
    const label = `${t.kp.n} / ${t.kp.of}`;
    if (!t.kpList.length || !t.kpList.some((one) => one.passed && !one.here)) return h("span", { class: "line-n" }, label);
    const menu = h("div", { class: "kp-menu", role: "menu", hidden: true },
      ...t.kpList.map((one, i) => h("button", { type: "button", role: "menuitem", disabled: !(one.passed || one.here), ariaCurrent: one.id === (t.back?.kpId ?? (one.here ? one.id : null)) ? "true" : null, onclick: () => { menu.hidden = true; if (one.here) model.actions.closeBack(); else model.actions.readBack("explanation", one.id); } }, h("span", { class: "kp-menu-n" }, String(i + 1)), one.title)));
    const toggle = h("button", { type: "button", class: "line-n step-back", ariaHaspopup: "menu", onclick: () => { menu.hidden = !menu.hidden; if (!menu.hidden) menu.querySelector("button:not(:disabled)")?.focus(); } }, label);
    menu.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); menu.hidden = true; toggle.focus(); } });
    return h("span", { class: "line-switch" }, toggle, menu);
  }

  function stepRow(t) {
    if (t.stage === "completed") return null;
    if (t.restricted) return h("div", { class: "line" }, h("span", { class: "line-kp" }, `第 ${t.qi + 1} / ${t.total} 题`));
    const inQ = ["answering", "feedback", "judging", "recovery"].includes(t.stage);
    const viewing = t.back?.page ?? (inQ ? "practice" : t.stage);
    const step = (key, label) => {
      const past = key === "explanation" ? t.stage !== "explanation" : key === "example" ? inQ : false;
      const here = viewing === key;
      if (!here && t.back && key !== "practice") return h("button", { type: "button", class: "step step-back", onclick: () => model.actions.readBack(key, t.back.kpId) }, label);
      if (!here && past && t.canBack) return h("button", { type: "button", class: "step step-back", onclick: () => model.actions.readBack(key) }, label);
      if (!here && key === "practice" && t.back) return h("button", { type: "button", class: "step step-back", onclick: () => model.actions.closeBack() }, label);
      return h("span", { class: "step", ariaCurrent: here ? "step" : null, dataPast: String(past) }, label);
    };
    const done = t.answered;
    return h("div", { class: "line" },
      h("span", { class: "line-kp" }, t.kp.of > 1 ? kpSwitch(t) : null, t.back?.kpTitle ?? t.kp.title),
      h("span", { class: "steps" }, step("explanation", "讲解"), step("example", "例题"), step("practice", inQ ? `练习 ${Math.min(done + (["answering", "judging", "recovery"].includes(t.stage) ? 1 : 0), t.total)} / ${t.total}` : "练习")));
  }

  function resultPage(t) {
    return h("div", { class: "result" },
      h("h2", { class: "result-outcome", dataOutcome: t.outcome }, fmtOutcome[t.outcome]),
      t.outcome === "unresolved" ? h("p", { class: "result-note" }, "判出来以后会更新结论和 XP。") : t.reward ? h("p", { class: "result-xp" }, `+ ${t.reward} XP`) : null,
      t.wrapup ? h("div", { class: "prose result-wrap", html: MD.block(t.wrapup) }) : null,
      t.kind === "lesson" && t.outcome === "failed" ? h("p", { class: "result-note" }, "48 小时后可以重学，已通过的知识点保留。") : null,
      t.restricted && t.submissions.length ? h("ol", { class: "result-list" }, ...t.submissions.map((x, i) => {
        const card = x.kpId ? model.lib.card(x.kpId) : null;
        return h("li", { dataResult: x.correct ? "right" : "wrong" },
          h("details", { open: !x.correct },
            h("summary", { html: `${forms.ICON[x.correct ? "right" : "wrong"]}<span class="sr">${x.correct ? "答对" : "答错"}</span><span class="result-n">${i + 1}</span><span>${MD.esc(x.kpName ?? titleOf(x.question))}</span>` }),
            forms.question(x.question, { locked: true, reveal: true, response: x.response }),
            x.question.explanation ? h("div", { class: "prose fb-why", html: MD.block(x.question.explanation) }) : null,
            card ? h("a", { class: "rel-item result-card", href: `#/k/${x.kpId}`, dataKp: x.kpId }, tileIcon({ ...model.lib.entry(x.kpId), index: card.index }, 16), card.name) : null));
      })) : null);
  }

  let talkBox = null;
  function paintTalk(v) {
    if (!talkBox) return;
    const here = v.talk.filter((m) => m.page === v.pageKey);
    talkBox.replaceChildren(...here.map((m) => over.talkEntry({ ...m, where: null })));
    talkBox.hidden = here.length === 0;
    const link = cell.querySelector(".c-talk");
    if (link) { link.hidden = !v.talk.length; link.textContent = `对话 ${v.talk.length}`; }
    if (here.length) talkBox.lastElementChild.scrollIntoView({ block: "nearest" });
  }

  function bodyOf(t) {
    if (t.back) {
      return t.back.page === "explanation"
        ? h("div", { class: "prose", html: MD.block(t.back.body) })
        : forms.worked(t.back.question);
    }
    if (t.stage === "explanation") return h("div", { class: "prose", html: MD.block(t.reading.body) });
    if (t.stage === "example") return forms.worked(t.reading.question);
    if (t.stage === "answering") return forms.question(t.question);
    if (t.stage === "judging" || t.stage === "recovery") return forms.question(t.question, { locked: true, response: t.response });
    if (t.stage === "feedback") {
      return h("div", {},
        forms.question(t.question, { locked: true, reveal: true, response: t.response }),
        t.question.explanation ? h("div", { class: "prose fb", html: MD.block(t.question.explanation) }) : null);
    }
    return resultPage(t);
  }

  function primaryOf(t) {
    const a = model.actions;
    const btn = (label, fn) => h("button", { type: "button", class: "btn btn-primary", dataPrimary: "1", onclick: fn }, label);
    if (t.reopened) return btn("回到今天", () => { location.hash = "#/"; });
    if (t.back) return btn(t.stage === "feedback" ? "回到这题" : t.stage === "example" ? "回到例题" : "回到讲解", a.closeBack);
    if (t.stage === "explanation") return btn("看例题", a.advance);
    if (t.stage === "example") return btn("开始练习", a.advance);
    if (t.stage === "answering") return btn(t.kind === "quiz" && t.qi === t.total - 1 ? "交卷" : "提交", () => forms.trySubmit());
    if (t.stage === "feedback") return btn("继续", a.advance);
    if (t.stage === "judging") { const b = btn("继续", () => {}); b.disabled = true; b.setAttribute("aria-busy", "true"); return b; }
    if (t.stage === "recovery") return btn("再判一次", a.retry);
    return btn("继续", () => { a.finish(); location.hash = "#/"; });
  }

  function footOf(t) {
    // The verdict lands where the learner just pressed, and stays in view however long the question is.
    const verdict = t.stage === "feedback" && !t.back ? forms.verdict(t.verdict) : null;
    if (t.stage === "judging") return h("div", { class: "c-foot" }, h("p", { class: "c-status", role: "status" }, "正在判分…"), primaryOf(t));
    if (t.stage === "recovery") return h("div", { class: "c-foot" }, h("p", { class: "c-status", role: "status" }, "没能判出结果，这份作答先不算对错"), h("button", { type: "button", class: "btn btn-quiet", onclick: model.actions.skipGrading }, "先做下一题"), primaryOf(t));
    const left = t.canAsk
      ? askForm(() => paintTalk(model.view()))
      : t.stage === "answering" && t.kind !== "quiz" ? h("button", { type: "button", class: "btn btn-quiet", onclick: model.actions.dontKnow }, "不会") : h("span");
    return h("div", { class: "c-foot" }, verdict, left, primaryOf(t));
  }

  let cellKey = "";
  // Where you were reading is part of where you were.
  const scrolled = new Map();
  function renderCell(v, reopened) {
    const t = reopened ? { ...v.last, reopened: true } : v.task;
    const key = reopened ? "result" : `${v.pageKey}|${t.back?.page ?? ""}|${t.back?.kpId ?? ""}|${t.outcome ?? ""}`;
    if (key === cellKey) { paintTalk(v); return; }
    const sameQuestion = cellKey.split("|")[0].replace(/:(answering|feedback):/, ":") === key.split("|")[0].replace(/:(answering|feedback):/, ":") && t.stage === "feedback";
    const oldBody = cell.querySelector(".c-body");
    const keep = sameQuestion ? oldBody?.scrollTop ?? 0 : scrolled.get(key) ?? 0;
    cellKey = key;
    const content = bodyOf(t);
    talkBox = h("div", { class: "talk", hidden: true });
    const body = h("div", { class: "c-body", tabindex: "-1", onscroll: () => { scrolled.set(key, body.scrollTop); placeWedge(); } }, content, t.canAsk ? talkBox : null);
    cell.dataset.stage = t.stage;
    cell.dataset.kind = t.kind;
    cell.replaceChildren(...[
      h("div", { class: "c-top" },
        h("a", { class: "c-back", href: "#/", html: `<span class="chev chev-back">${CHEV}</span>今天` }),
        t.deadline && t.stage !== "completed" ? h("span", { class: "clock", role: "timer", dataClock: "1" }, clockText(t.deadline)) : null,
        t.canAsk ? h("button", { type: "button", class: "link-btn c-find", onclick: () => over.openFinder() }, "搜索") : null,
        h("button", { type: "button", class: "link-btn c-talk", hidden: true, onclick: () => over.openSheet(model.view(), askForm()) })),
      h("h1", { class: "c-title" }, phrase(t.title)),
      pathBar(t),
      stepRow(t),
      body,
      footOf(t)].filter(Boolean));
    cell.style.setProperty("--sb", `${body.offsetWidth - body.clientWidth}px`);
    body.scrollTop = keep;
    if (!scrolled.has(key)) showResult(t, body);
    paintTalk(v);
    placeWedge();
    settle(t);
    document.title = `${t.title} - ${t.kindName}`;
  }

  /** A long question can push the answer out of view. Bring it back, with what explains it, without moving anything that is already visible. */
  function showResult(t, body) {
    if (t.stage !== "feedback" || t.back) return;
    const first = cell.querySelector('.slot[data-result="wrong"]') ?? cell.querySelector('.slot[data-result="right"]');
    if (!first) return;
    const box = body.getBoundingClientRect(), r = first.getBoundingClientRect();
    const why = (cell.querySelector(".fb") ?? first).getBoundingClientRect();
    // As far as it takes to show the reason too, never past the answer it is about.
    const wanted = Math.max(0, why.bottom - box.bottom + 16);
    const most = Math.max(0, r.top - box.top - 16);
    if (r.top < box.top) body.scrollTop += r.top - box.top - 16;
    else if (wanted > 0) body.scrollTop += Math.min(wanted, most);
  }

  /** Focus follows the task, so Enter keeps going and a screen reader arrives where the eye does. Touch keeps its keyboard shut. */
  function settle(t) {
    const fine = matchMedia("(pointer: fine)").matches;
    if (t.stage === "answering" && fine) {
      (cell.querySelector(".c-body .field:not([readonly]), .c-body .editor-text") ?? cell.querySelector("[data-primary]"))?.focus({ preventScroll: true });
      return;
    }
    if (fine) { cell.querySelector("[data-primary]")?.focus({ preventScroll: true }); return; }
    cell.querySelector(".c-body")?.focus({ preventScroll: true });
  }

  /** The sting stays outside the page and points at the wrong answer, wherever the page has scrolled it. */
  function placeWedge() {
    const reader = cell.querySelector(".c-body");
    if (reader) cell.dataset.more = String(reader.scrollTop + reader.clientHeight < reader.scrollHeight - 8);
    const t = model.view().task;
    const slot = route().name === "learn" && t?.stage === "feedback" && t.verdict === "wrong" && !t.back ? cell.querySelector('.slot[data-result="wrong"]') : null;
    const wrong = slot ? slot.querySelector('.field, .option[data-result="wrong"], td[data-result="wrong"], .order-row[data-result="wrong"], .option') ?? slot : null;
    if (!wrong) { wedge.dataset.on = "false"; return; }
    const r = wrong.getBoundingClientRect(), body = cell.querySelector(".c-body").getBoundingClientRect(), box = cell.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    const seen = mid > body.top && mid < body.bottom;
    wedge.dataset.on = String(seen);
    wedge.style.top = `${mid - 24}px`;
    wedge.style.left = `${box.left - 96}px`;
  }

  // ---- settings

  function renderSettings(v) {
    const dark = document.documentElement.classList.contains("dark");
    setRoot.replaceChildren(h("div", { class: "set" },
      h("h1", {}, "设置"),
      h("div", { class: "set-row" },
        h("span", { class: "set-name" }, "每天的目标"),
        h("span", { class: "stepper" },
          h("button", { type: "button", ariaLabel: "减少", onclick: () => model.actions.setGoal(v.xp.goal - 5) }, "−"),
          h("output", {}, `${v.xp.goal} XP`),
          h("button", { type: "button", ariaLabel: "增加", onclick: () => model.actions.setGoal(v.xp.goal + 5) }, "+"))),
      h("div", { class: "set-row" },
        h("span", { class: "set-name" }, "外观"),
        h("span", { class: "segmented", role: "radiogroup", ariaLabel: "外观" },
          ...[["浅色", false], ["深色", true]].map(([label, on]) => h("button", { type: "button", role: "radio", ariaChecked: String(dark === on), onclick: () => { document.documentElement.classList.toggle("dark", on); render(); } }, label))))));
  }

  // ---- the whole

  function render() {
    const v = model.view();
    let r = route();
    if (r.name === "learn" && !v.task) { location.replace("#/"); return; }
    if (r.name === "result" && !v.last) { location.replace("#/"); return; }
    // While an answer is outstanding the rest of the product is closed, whatever the address says.
    if (v.shut && r.name !== "learn" && r.name !== "today") { location.replace("#/learn"); return; }
    const inside = r.name === "learn" || r.name === "result";
    app.dataset.route = inside ? "learn" : r.name;
    app.dataset.input = window.onKeyboard() ? "key" : "pointer";
    world.hidden = !(r.name === "today" || inside);
    libRoot.hidden = !r.lib;
    setRoot.hidden = r.name !== "settings";
    bar.inert = inside;
    plan.inert = inside;
    cell.inert = !inside;
    world.dataset.in = String(inside);
    ground.tabIndex = inside ? -1 : 0;
    findButton.hidden = v.shut;
    offline.hidden = !v.offline;
    // Reading in the knowledge base mid-lesson is one click from the lesson.
    backToTask.hidden = !(v.task && !inside && r.name !== "today");
    if (!backToTask.hidden) backToTask.replaceChildren(h("span", { class: "bar-resume-kind" }, "继续"), v.task.title);
    // Reference content is shut while an answer is outstanding, and the way there says so.
    const toLib = bar.querySelector('[data-nav="k"]');
    toLib.toggleAttribute("data-shut", v.shut);
    if (v.shut) { toLib.removeAttribute("href"); toLib.setAttribute("aria-disabled", "true"); toLib.title = "作答结束后可以看"; } else { toLib.href = "#/k/"; toLib.removeAttribute("aria-disabled"); toLib.removeAttribute("title"); }
    bar.querySelectorAll("[data-nav]").forEach((a) => { if (a.dataset.nav === (r.lib ? "k" : r.name)) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    if (!world.hidden) {
      drawField(v);
      if (inside) { renderCell(v, r.name === "result"); } else { cellKey = ""; document.title = "今天 - Repa"; renderPlan(v); wedge.dataset.on = "false"; }
      placeGround(v, inside);
      if (!L.narrow) plan.style.height = `${Math.max(L.rows * L.tile, 480)}px`;
      if (over.sheetOpen()) over.paintSheet(v, askForm());
    }
    if (r.lib) { library.invalidate(); const id = library.render(r); document.title = `知识库 - Repa`; void id; }
    if (r.name === "settings") { renderSettings(v); document.title = "设置 - Repa"; }
    document.querySelector("#theme-color").content = getComputedStyle(document.body).backgroundColor;
  }

  model.subscribe(render);
  addEventListener("hashchange", () => { over.hidePeek(); render(); if (route().lib) return; });
  let raf;
  addEventListener("resize", () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(render); });
  setInterval(() => {
    const t = model.view().task;
    if (!t?.deadline || t.stage === "completed") return;
    document.querySelectorAll("[data-clock]").forEach((node) => { node.textContent = clockText(t.deadline); });
    if (Date.now() >= t.deadline) model.actions.timeUp();
  }, 1000);

  addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== "radio" && e.target.type !== "checkbox";
    if ((e.key === "/" && !typing) || (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey))) { e.preventDefault(); over.openFinder(); return; }
    if (typing || document.querySelector("dialog[open]")) return;
    const t = model.view().task;
    if (route().name !== "learn" || !t) return;
    // A digit picks an option while answering: reviews are done daily, by hand.
    if (t.stage === "answering" && /^[1-9]$/.test(e.key)) {
      const option = cell.querySelectorAll(".option input:not(:disabled)")[Number(e.key) - 1];
      if (option) { option.click(); option.focus(); e.preventDefault(); }
      return;
    }
    if (e.key === "Enter" && !e.target.closest("button, a, summary")) { e.preventDefault(); cell.querySelector("[data-primary]")?.click(); }
  });

  // ---- demonstration states: each is reached through the real actions

  function demo(go) {
    const a = model.actions;
    const first = (kind) => model.view().menu.find((m) => !kind || m.kind === kind)?.id;
    const toLearn = () => { location.hash = "#/learn"; };
    const answer = (right) => a.__answer(right);
    const walk = (fn) => { for (let i = 0; i < 80 && model.view().task && model.view().task.stage !== "completed"; i += 1) { const t = model.view().task; if (["explanation", "example", "feedback"].includes(t.stage)) a.advance(); else fn(t); } };
    const steps = {
      explain() { a.start(first("lesson")); toLearn(); },
      example() { a.start(first("lesson")); a.advance(); toLearn(); },
      answer() { a.start(first("lesson")); a.advance(); a.advance(); toLearn(); },
      wrong() { steps.answer(); answer(false); },
      right() { steps.answer(); answer(true); },
      second() { steps.answer(); answer(false); a.advance(); },
      back() { steps.wrong(); a.readBack("explanation"); },
      pass() { a.start(first("lesson")); walk(() => answer(true)); toLearn(); },
      fail() { a.start(first("lesson")); walk(() => answer(false)); toLearn(); },
      woven() { steps.pass(); a.finish(); location.hash = "#/"; },
      resume() { steps.answer(); location.hash = "#/"; },
      review() { a.start(first("review")); toLearn(); },
      quiz() { a.start(first("quiz")); toLearn(); },
      reviewdone() { a.start(first("review")); walk(() => answer(true)); toLearn(); },
      quizdone() { a.start(first("quiz")); let n = 0; walk(() => { answer(n % 2 === 0); n += 1; }); toLearn(); },
      chat() { steps.wrong(); a.ask("为什么不是 13？"); },
      judging() { steps.answer(); a.__state("judging"); },
      recovery() { steps.answer(); a.__state("recovery"); },
      unresolved() { steps.quizdone(); a.__state("unresolved"); },
      offline() { steps.answer(); a.__state("offline"); },
      goal() { a.setGoal(10); },
      reading() { steps.explain(); location.hash = "#/k/"; },
    };
    steps[go]?.();
  }
  if (params.has("go")) demo(params.get("go"));
  render();
  window.__repa = { model, forms };
})();
