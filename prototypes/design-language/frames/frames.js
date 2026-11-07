// A frame takes the view and the parts and decides where everything goes. It holds no truth of its own.
window.Frames = {};
(() => {
  // Actions started from the keyboard do not animate (Emil, Rauno): they happen many times, and a person holding Enter is waiting.
  addEventListener("keydown", () => { document.documentElement.dataset.input = "keyboard"; }, true);
  addEventListener("pointerdown", () => { document.documentElement.dataset.input = "pointer"; }, true);
  const keyboard = () => document.documentElement.dataset.input === "keyboard";
  /** The row of tiles around the current KP, for frames that want the course quietly present. */
  const strip = (v) => {
    const at = Math.max(0, v.progress.findIndex((e) => e.current || e.state === "current"));
    const from = at - (at % 10);
    return window.Tile.field(v.progress.slice(from, from + 10), 10, 32, from);
  };
  const home = (p, v) => {
    const figure = p.el("div", { class: "h-left" }, window.Tile.field(v.progress, 10, 32));
    return p.el("div", { class: "f-home" }, p.el("h1", { class: "topic" }, v.course.title), figure,
      p.el("div", { class: "h-right" }, p.goal(v), p.menu(v)));
  };
  const turn = (node, keyframes, options) => {
    if (!keyboard() && !window.matchMedia("(prefers-reduced-motion: reduce)").matches && node.animate) return node.animate(keyframes, options);
    return null;
  };

  // ---- three columns: the baseline

  window.Frames.columns = { name: "三栏", mount(root, app, p) {
    return { render(v) {
      if (v.stage === "idle") { root.replaceChildren(p.offline(v) ?? "", home(p, v)); return; }
      const rail = v.restricted ? null : p.el("div", { class: "c-rail" }, p.topic(v), p.steps(v), p.kps(v), strip(v));
      const tutor = v.restricted && v.stage !== "completed" ? null : p.tutor(v);
      const frame = p.el("div", { class: `f-columns${v.restricted && v.stage !== "completed" ? " is-restricted" : ""}` },
        p.el("header", { class: "c-bar" }, v.restricted ? p.kindLabel(v) : null, p.clock(v), p.course(v), p.xp(v), p.abort(v)),
        rail, p.el("main", { class: "c-work" }, p.screen(v), p.actions(v)), tutor);
      root.replaceChildren(...[p.offline(v), frame].filter(Boolean));
    } };
  } };

  // ---- long scroll

  window.Frames.river = { name: "长卷", mount(root, app, p) {
    const mark = (entry, index, size = 32) => { const svg = window.Tile.element("svg", { viewBox: `0 0 ${size} ${size}`, "aria-hidden": "true" }); window.Tile.draw(svg, 0, 0, size, index, entry); return svg; };
    return { render(v) {
      const blocks = [];
      const at = v.progress.findIndex((e) => e.current);
      // What you have learned stays on the page above you, except while an answer is outstanding: then it is shut.
      if (!v.answering) {
        for (const topic of v.learned) {
          const index = v.progress.findIndex((e) => e.topic.id === topic.id);
          blocks.push(p.el("section", { class: "r-block r-past" },
            p.el("div", { class: "r-mark" }, mark(v.progress[index], index)),
            p.el("div", { class: "r-body" }, p.el("p", { class: "menu-title" }, topic.title),
              p.el("p", { class: "course" }, topic.names.join("、")))));
        }
      }
      if (v.stage === "idle") {
        blocks.push(p.el("section", { class: "r-block" }, p.el("div", { class: "r-mark" }, mark(v.progress[Math.max(0, at)], Math.max(0, at))),
          p.el("div", { class: "r-body r-now" }, p.goal(v), p.el("div", { style: "height:var(--t)" }), p.menu(v))));
      } else {
        blocks.push(p.el("section", { class: "r-block" },
          p.el("div", { class: "r-mark" }, mark(v.progress[Math.max(0, at)], Math.max(0, at))),
          p.el("div", { class: "r-body r-now" }, v.restricted ? p.kindLabel(v) : p.topic(v), v.restricted ? p.clock(v) : p.steps(v), v.answering ? null : p.kps(v), p.screen(v), p.actions(v)),
          p.el("div", { class: "r-note" }, p.tutor(v))));
      }
      for (const entry of v.progress.filter((e) => e.state === "untouched").slice(0, 3)) {
        blocks.push(p.el("section", { class: "r-block r-future" }, p.el("div", { class: "r-mark" }, mark(entry, v.progress.indexOf(entry))), p.el("div", { class: "r-body" }, p.el("p", { class: "course" }, entry.topic.title))));
      }
      const frame = p.el("div", { class: `f-river${v.restricted && v.stage !== "completed" ? " is-restricted" : ""}` },
        p.el("div", { class: "r-status" }, p.xp(v), p.abort(v)), ...blocks);
      root.replaceChildren(...[p.offline(v), frame].filter(Boolean));
      root.querySelector(".r-now")?.scrollIntoView({ block: "start" });
    } };
  } };

  // ---- one screen

  window.Frames.focus = { name: "一屏", mount(root, app, p) {
    let page = 0, lastStage, band, sheetOpen = false;
    return { render(v) {
      if (v.stage !== lastStage) { page = 0; sheetOpen = false; lastStage = v.stage; }
      band ??= p.figure("huiwen");
      band.update(v);
      const top = p.el("div", { class: "o-top" }, p.course(v), p.clock(v), p.xp(v), p.abort(v));
      let inner;
      if (v.stage === "idle") inner = p.el("div", { class: "o-inner" }, p.goal(v), p.el("div", { style: "height:var(--t)" }), p.menu(v));
      else if (v.stage === "explanation") {
        // One idea per screen: the lesson is paged by paragraph.
        const prose = p.screen(v);
        const items = [...prose.children];
        const pages = [];
        items.forEach((node) => { if (node.matches("ol,ul,.code,.md-table") && pages.length) pages[pages.length - 1].push(node); else pages.push([node]); });
        const shown = p.el("div", { class: "prose" }, ...pages[page]);
        const more = page < pages.length - 1;
        inner = p.el("div", { class: "o-inner" }, shown, more ? p.el("div", { class: "actions" }, p.button("继续", "primary", () => { page += 1; app.emit(); })) : p.actions(v));
      } else inner = p.el("div", { class: "o-inner" }, p.screen(v), p.actions(v));
      const summon = p.button("辅导", "quiet", () => { sheetOpen = !sheetOpen; sheet.dataset.open = String(sheetOpen); sheet.inert = !sheetOpen; });
      summon.className = "o-summon";
      summon.disabled = !v.tutorAllowed;
      const sheet = p.el("div", { class: "o-sheet", dataOpen: String(sheetOpen), inert: !sheetOpen }, p.tutor(v));
      root.replaceChildren(...[p.offline(v), p.el("div", { class: "f-focus" }, p.el("div", { class: "o-band" }, band.box), top, p.el("main", { class: "o-stage" }, inner), v.restricted && v.stage !== "completed" ? null : summon, sheet)].filter(Boolean));
      band.update(v);
    }, stop() { band?.stop(); } };
  } };

  // ---- map

  window.Frames.zoom = { name: "地图", mount(root, app, p) {
    const frame = p.el("div", { class: "f-zoom" });
    const ground = p.el("div", { class: "z-ground" });
    const name = p.el("div", { class: "z-name" });
    const menu = p.el("div", { class: "z-menu" });
    const cell = p.el("div", { class: "z-cell" });
    const tutorBox = p.el("div", { class: "z-tutor" });
    const wedge = p.el("div", { class: "z-wedge", ariaHidden: "true" });
    frame.append(ground, name, menu, wedge, cell, tutorBox);
    root.replaceChildren(frame);
    return { render(v) {
      ground.replaceChildren(window.Tile.field(v.progress.map((entry) => ({ ...entry, missed: false })), 10, 96));
      const inTask = v.stage !== "idle";
      frame.dataset.in = String(inTask);
      frame.dataset.done = String(v.stage === "completed");
      frame.classList.toggle("is-restricted", v.restricted);
      menu.inert = inTask; cell.inert = !inTask; name.inert = inTask;
      const W = window.innerWidth, H = window.innerHeight, TILE = 96;
      const at = Math.max(0, v.progress.findIndex((e) => e.current));
      const cx = (at % 10) * TILE + TILE / 2, cy = Math.floor(at / 10) * TILE + TILE / 2;
      if (inTask) {
        // The tile you are in becomes the page: its edge lands exactly on the panel's edge.
        const scale = (cell.offsetWidth || 760) / TILE;
        ground.style.transform = `translate(${W / 2 - cx * scale}px, ${H / 2 - cy * scale}px) scale(${scale})`;
      } else {
        const rows = Math.ceil(v.progress.length / 10), scale = Math.min(H / (rows * TILE), W / (10 * TILE)) * 0.96;
        ground.style.transform = `translate(${Math.max(24, W * 0.06)}px, ${(H - rows * TILE * scale) / 2}px) scale(${scale})`;
      }
      name.replaceChildren(p.phrase(v.course.title));
      menu.replaceChildren(p.goal(v), p.menu(v), p.el("a", { class: "z-link", href: `repa.html?later=${v.later ? 1 : 0}#/k/` }, "知识库"));
      if (inTask) {
        cell.replaceChildren(p.el("div", { class: "z-head" }, v.restricted ? p.kindLabel(v) : p.course(v), p.clock(v), p.xp(v), p.abort(v)),
          v.restricted ? p.el("span") : p.topic(v), v.restricted ? p.el("span") : p.steps(v), v.showKps ? p.kps(v) : p.el("span"), p.screen(v), p.actions(v));
        cell.scrollTop = 0;
        // The sting stays outside the page and points at the wrong answer.
        const wrong = cell.querySelector('.slot[data-result="wrong"], .option[data-result="wrong"], td[data-result="wrong"]');
        wedge.dataset.on = String(v.stage === "feedback" && v.verdict === "wrong");
        if (wrong) wedge.style.top = `${wrong.getBoundingClientRect().bottom - 20}px`;
        else wedge.style.top = "50%";
        wedge.style.right = `calc(50% + ${(cell.offsetWidth || 760) / 2}px)`;
      } else { cell.replaceChildren(); wedge.dataset.on = "false"; }
      tutorBox.replaceChildren(p.tutor(v));
    } };
  } };

  // ---- book

  window.Frames.spread = { name: "对开书", mount(root, app, p) {
    let lastKey, noteOpen = false;
    return { render(v) {
      const key = `${v.stage}:${v.q}`;
      const changed = lastKey !== undefined && lastKey !== key;
      const oldRight = root.querySelector(".b-page + .b-page")?.cloneNode(true);
      lastKey = key;
      const left = p.el("section", { class: "b-page" }, p.el("div", { class: "b-head" }, v.restricted ? p.kindLabel(v) : p.course(v), p.clock(v)));
      const right = p.el("section", { class: "b-page" }, p.el("div", { class: "b-head" }, p.el("span", { style: "flex:1" }), p.xp(v), p.abort(v)));
      if (v.stage === "idle") {
        left.append(window.Tile.field(v.progress, 10, 32));
        right.append(p.goal(v), p.el("div", { style: "height:var(--t)" }), p.menu(v));
      } else if (v.stage === "answering" || v.stage === "feedback" || v.stage === "judging" || v.stage === "recovery") {
        // Stem on the left, what you do about it on the right: the eye crosses the spine once.
        const screen = p.screen(v);
        const question = screen.querySelector(".question");
        const stem = question.querySelector(".prose");
        if (!v.restricted) left.append(p.topic(v), p.el("div", { style: "height:var(--s4)" }));
        left.append(stem);
        right.append(screen, p.actions(v));
      } else if (v.stage === "completed") {
        left.append(v.restricted ? p.el("span") : p.topic(v), v.showKps ? p.kps(v) : p.el("span"));
        right.append(p.screen(v), p.actions(v));
      } else {
        // A lesson's text runs down the left page; what comes next waits on the right.
        left.append(p.topic(v), p.el("div", { style: "height:var(--s3)" }), p.steps(v), p.el("div", { style: "height:var(--s4)" }), p.screen(v));
        right.append(p.kps(v), p.el("div", { style: "height:var(--s4)" }), strip(v), p.actions(v));
      }
      left.append(p.el("span", { class: "b-folio" }, String(2 * (v.q + 1) + v.stepIndex * 2)));
      right.append(p.el("span", { class: "b-folio" }, String(2 * (v.q + 1) + v.stepIndex * 2 + 1)));
      const tab = p.button("辅导", "quiet", () => { noteOpen = !noteOpen; note.dataset.open = String(noteOpen); });
      tab.className = "b-tab";
      tab.disabled = !v.tutorAllowed;
      const note = p.el("div", { class: "b-note", dataOpen: String(noteOpen) }, p.tutor(v));
      const book = p.el("div", { class: "b-book" }, left, right, tab, note);
      root.replaceChildren(...[p.offline(v), p.el("div", { class: "f-spread" }, book)].filter(Boolean));
      if (changed && oldRight) {
        const leaf = p.el("div", { class: "b-leaf" }, oldRight);
        book.append(leaf);
        const animation = turn(leaf, [{ transform: "rotateY(0)" }, { transform: "rotateY(-180deg)" }], { duration: 420, easing: "cubic-bezier(.2,0,.38,.9)" });
        if (animation) animation.onfinish = () => leaf.remove(); else leaf.remove();
      }
    } };
  } };

  // ---- one voice

  window.Frames.chat = { name: "一个对象", mount(root, app, p) {
    let log = [], lastKey;
    const speaker = () => { const svg = window.Tile.element("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" }); window.Tile.draw(svg, 0, 0, 24, 3, { kp: { id: "repa" }, passed: true, memory: 1 }); return svg; };
    const turnNode = (content, kind = "repa") => (kind === "me" ? p.el("div", { class: "h-me" }, content) : p.el("div", { class: "h-turn" }, p.el("div", { class: "h-mark" }, speaker()), p.el("div", {}, content)));
    return { render(v) {
      const key = `${v.stage}:${v.q}:${v.tutorMessages.length}`;
      if (key !== lastKey) {
        lastKey = key;
        if (v.stage === "feedback" && v.response) {
          const text = Object.values(v.response).filter((x) => typeof x === "string").join("、");
          if (text) log.push({ stage: "me", node: turnNode(text, "me") });
        }
        if (!(v.stage === "answering" && log.at(-1)?.stage === `answering:${v.q}`)) log.push({ stage: v.stage === "answering" ? `answering:${v.q}` : v.stage, node: turnNode(p.screen(v)), q: v.q });
      }
      // While an answer is outstanding everything before the question is folded: the contract shuts reference content, and this conversation is reference content.
      const visible = v.answering ? log.filter((b) => b.stage === `answering:${v.q}`) : log.filter((b) => !b.stage.startsWith("answering"));
      const hidden = log.length - visible.length;
      const inner = p.el("div", { class: "h-inner" }, ...(v.answering && hidden ? [p.el("p", { class: "h-fold" }, `前面 ${hidden} 段，答完可看`)] : []), ...(v.stage === "idle" ? [turnNode(p.el("div", {}, p.goal(v), p.el("div", { style: "height:var(--s4)" }), p.menu(v)))] : visible.map((b) => b.node)));
      const single = v.stage === "answering" && v.question.slots.length === 1 && v.question.slots[0].type === "text";
      let box;
      if (single) {
        // The one box takes the answer: the field inside the question gives way to it.
        const slot = v.question.slots[0];
        const lastScreen = visible.at(-1)?.node;
        lastScreen?.querySelector(".slot")?.remove();
        const prompt = p.el("p", { class: "slot-prompt", style: "margin-top:var(--s3)", html: window.MD.inline(slot.prompt ?? "") });
        lastScreen?.querySelector(".question")?.append(prompt);
        const input = p.el("input", { ariaLabel: slot.prompt, autocomplete: "off", inputmode: "numeric", onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); p.trySubmit({ [slot.id]: input.value }); } } });
        box = p.el("div", { class: "h-box", dataSlot: slot.id }, input, p.el("button", { type: "button", class: "tutor-send", ariaLabel: "提交", html: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M6 11l6-6 6 6"/></svg>', onclick: () => p.trySubmit({ [slot.id]: input.value }) }));
      } else if (v.answering) {
        box = p.el("div", { class: "h-box", dataClosed: "true" }, p.el("textarea", { disabled: true, ariaLabel: "问辅导" }));
      } else {
        const area = p.el("textarea", { rows: 1, ariaLabel: "问辅导" });
        box = p.el("div", { class: "h-box" }, area, p.el("button", { type: "button", class: "tutor-send", ariaLabel: "发送", html: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M6 11l6-6 6 6"/></svg>', onclick: () => { if (area.value.trim()) { log.push({ stage: "me", node: turnNode(area.value.trim(), "me") }); app.actions.ask(area.value.trim()); } } }));
      }
      const logBox = p.el("div", { class: "h-log" }, inner);
      const dock = p.el("div", { class: "h-dock" }, p.el("div", { class: "h-dock-inner" },
        v.stage === "idle" ? null : p.el("div", { class: "h-chips" }, single ? p.dontKnow(v) : p.actions(v)), box));
      root.replaceChildren(...[p.offline(v), p.el("div", { class: "f-chat" }, p.el("div", { class: "h-top" }, p.course(v), p.clock(v), p.xp(v), p.abort(v)), logBox, dock)].filter(Boolean));
      logBox.scrollTop = logBox.scrollHeight;
    } };
  } };

  // ---- prism

  window.Frames.cube = { name: "棱柱", mount(root, app, p) {
    const frame = p.el("div", { class: "f-cube" });
    const stage = p.el("div", { class: "q-stage" });
    const faces = [0, 1, 2, 3].map(() => p.el("section", { class: "q-face" }));
    faces.forEach((face) => stage.append(face));
    const side = p.el("div", { class: "q-side" });
    frame.append(stage, side);
    root.replaceChildren(frame);
    let index = 0, previous = -1, step = 0;
    const FACE = { idle: 0, explanation: 1, example: 2, answering: 3, judging: 3, recovery: 3, feedback: 4, completed: 5 };
    return { render(v) {
      const target = FACE[v.stage] + (v.stage === "answering" || v.stage === "feedback" ? v.q * 2 : 0);
      if (target !== previous) { if (previous >= 0) step += 1; previous = target; }
      index = step % 4;
      const width = stage.offsetWidth || 860, depth = width / 2;
      // Each face turns about the shared axis, rather than the stage turning, so the face in front is an ordinary hit target.
      stage.style.transform = `translateZ(${-depth}px)`;
      faces.forEach((face, i) => { face.style.transform = `rotateY(${(i - step) * 90}deg) translateZ(${depth}px)`; });
      faces.forEach((face, i) => { if (i !== index && !face.querySelector(".q-blank")) face.replaceChildren(p.el("div", { class: "q-blank" }, window.Tile.field(v.progress.slice(0, 40), 10, 32))); });
      const face = faces[index];
      if (v.stage === "idle") face.replaceChildren(p.el("h1", { class: "topic" }, v.course.title), p.el("div", { style: "height:var(--t)" }), p.goal(v), p.el("div", { style: "height:var(--t)" }), p.menu(v));
      else face.replaceChildren(p.el("div", { class: "q-head" }, v.restricted ? p.kindLabel(v) : p.course(v), p.clock(v), p.xp(v), p.abort(v)), v.restricted ? p.el("span") : p.topic(v), v.restricted ? p.el("span") : p.el("div", { style: "margin:var(--s3) 0 var(--s4)" }, p.steps(v)), p.screen(v), p.actions(v));
      frame.classList.toggle("is-restricted", v.restricted);
      frame.dataset.done = String(v.stage === "completed");
      side.replaceChildren(p.tutor(v));
    } };
  } };

  // ---- desk

  window.Frames.desk = { name: "桌面", mount(root, app, p) {
    const W = window.innerWidth, H = window.innerHeight;
    const DEFAULT = { work: { x: 352, y: 32, w: 672, h: Math.min(H - 64, 800) }, map: { x: 32, y: 32, w: 288, h: 384 }, tutor: { x: 1056, y: 32, w: Math.max(288, W - 1088), h: Math.min(H - 64, 640) } };
    let layout;
    try { layout = JSON.parse(localStorage.getItem("repa-desk")); } catch { layout = null; }
    layout = { ...DEFAULT, ...(layout ?? {}) };
    const frame = p.el("div", { class: "f-desk" });
    root.replaceChildren(frame);
    const wins = {};
    let top = 1;
    const windowFor = (id, title) => {
      const body = p.el("div", { class: "d-body" });
      const bar = p.el("div", { class: "d-title" }, title);
      const win = p.el("section", { class: "d-win", dataWin: id }, bar, body);
      const place = () => { const r = layout[id]; win.style.left = `${r.x}px`; win.style.top = `${r.y}px`; win.style.width = `${r.w}px`; win.style.height = `${r.h}px`; };
      place();
      let drag;
      bar.addEventListener("pointerdown", (e) => { drag = { x: e.clientX - layout[id].x, y: e.clientY - layout[id].y }; bar.setPointerCapture(e.pointerId); top += 1; win.style.zIndex = top; });
      bar.addEventListener("pointermove", (e) => {
        if (!drag) return;
        // Windows snap to the tile grid: freedom, but the page stays composed.
        layout[id] = { ...layout[id], x: Math.round((e.clientX - drag.x) / 32) * 32, y: Math.round((e.clientY - drag.y) / 32) * 32 };
        place();
      });
      bar.addEventListener("pointerup", () => { drag = undefined; try { localStorage.setItem("repa-desk", JSON.stringify(layout)); } catch { /* stays for this page only */ } });
      frame.append(win);
      wins[id] = { win, body, bar };
    };
    windowFor("work", "题"); windowFor("map", "全课"); windowFor("tutor", "辅导");
    let figure;
    return { render(v) {
      wins.work.bar.textContent = v.restricted ? v.kindName : v.topic;
      if (v.stage === "idle") wins.work.body.replaceChildren(p.goal(v), p.el("div", { style: "height:var(--t)" }), p.menu(v));
      else wins.work.body.replaceChildren(v.restricted ? p.el("span") : p.el("div", { style: "margin-bottom:var(--s4)" }, p.steps(v)), p.clock(v) ?? p.el("span"), p.screen(v), p.actions(v));
      figure ??= p.figure("truchet");
      if (!wins.map.body.contains(figure.box)) wins.map.body.replaceChildren(figure.box);
      figure.update(v);
      wins.map.win.hidden = v.answering;
      wins.tutor.win.style.display = v.restricted && v.stage !== "completed" ? "none" : "flex";
      wins.tutor.body.replaceChildren(p.tutor(v));
    }, stop() { figure?.stop(); } };
  } };
})();
