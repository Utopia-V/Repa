// Semantic pieces of the interface. A frame arranges these; a skin styles them; neither decides what is true.
window.Parts = (app) => {
  const { MD } = window;
  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "class") node.className = value;
      else if (key === "html") node.innerHTML = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (/^(aria|data)[A-Z]/.test(key)) node.setAttribute(key.replace(/^(aria|data)([A-Z])/, (m, a, c) => `${a}-${c.toLowerCase()}`).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), value);
      else if (["role", "for", "name", "type", "id", "style"].includes(key)) node.setAttribute(key, value);
      else node[key] = value;
    }
    node.append(...children.filter((c) => c !== null && c !== undefined));
    return node;
  };
  const segmenter = window.Intl?.Segmenter ? new Intl.Segmenter("zh", { granularity: "word" }) : null;
  /** A heading as a node that breaks only between words. CSS keep-all forbids the rest. */
  const phrase = (text) => {
    if (!segmenter) return document.createTextNode(text);
    const box = document.createElement("span");
    box.className = "phrase";
    for (const { segment } of segmenter.segment(text)) { box.append(segment, document.createElement("wbr")); }
    return box;
  };
  const button = (label, kind, handler, extra = {}) => el("button", { type: "button", class: `btn btn-${kind}`, onclick: handler, ...extra }, label);
  const ICON = {
    right: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16 9.5"/></svg>',
    wrong: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5 5 19"/></svg>',
    lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="11" width="12" height="9"/><path d="M9 11V8a3 3 0 0 1 6 0v3"/></svg>',
    up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
    in: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    out: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
    send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  };
  const icon = (name) => el("span", { class: "icon", html: ICON[name] });
  let draft = {};

  // ---- status pieces

  const xp = (v) => el("p", { class: "xp" }, `今天 ${v.xp.today}\u00a0/\u00a0${v.xp.goal}\u00a0XP`);
  const course = (v) => el("p", { class: "course" }, v.course.title);
  const abort = (v) => (["completed", "idle"].includes(v.stage) ? null : button(`中止${v.kindName}`, "quiet", () => app.actions.home()));
  const clock = (v) => (v.clock ? el("p", { class: "clock", role: "timer" }, v.clock) : null);
  const kindLabel = (v) => el("p", { class: "kind" }, v.kindName);
  const topic = (v) => el("h1", { class: "topic" }, phrase(v.topic));
  const steps = (v) => el("ol", { class: "steps" }, ...v.steps.map(([key, label], i) => el("li", { class: "step", dataPassed: String(i < v.stepIndex), ...(i === v.stepIndex ? { ariaCurrent: "step" } : {}) }, label)));
  const kps = (v) => (v.showKps ? el("ul", { class: "kps" }, ...v.kps.map((kp) => el("li", { class: "kp", dataPassed: String(kp.passed) },
    el("span", { class: "kp-title" }, kp.title),
    el("span", { class: "kp-marks", role: "img", ariaLabel: `作答 ${kp.attempts} 次，连续答对 ${kp.consecutive} 次，${kp.passed ? "已通过" : "未通过"}` }, ...kp.marks.map((m) => el("i", { dataMark: m })))))) : null);

  // ---- forms

  let uid = 0;
  const textField = (slot, v, { locked, value, reveal }) => {
    const id = `f-${slot.id}-${uid += 1}`;
    return el("div", { class: "slot", dataSlot: slot.id, dataResult: reveal ? (String(value ?? "").trim() === String(slot.key) ? "right" : "wrong") : "none" },
      el("label", { class: "slot-prompt", for: id, html: MD.inline(slot.prompt ?? "") }),
      el("input", { class: "field", id, ...(slot.prompt ? {} : { ariaLabel: "作答" }), inputmode: slot.format === "integer" ? "numeric" : "text", autocomplete: "off", spellcheck: false, translate: false, readOnly: locked, value: value ?? "", oninput: (e) => { draft[slot.id] = e.target.value; }, onkeydown: (e) => { if (e.key === "Enter" && !locked) { e.preventDefault(); trySubmit(); } } }));
  };

  const choiceField = (slot, v, { locked, value, reveal }) => {
    const type = slot.multiple ? "checkbox" : "radio";
    return el("fieldset", { class: "slot options", dataSlot: slot.id, dataMultiple: String(Boolean(slot.multiple)) },
      el("legend", { class: "slot-prompt", html: MD.inline(slot.prompt ?? "") }),
      ...slot.options.map((option) => {
        const picked = slot.multiple ? (value ?? []).includes(option.id) : value === option.id;
        const isKey = reveal && (slot.multiple ? (slot.key ?? []).includes(option.id) : slot.key === option.id);
        const result = reveal ? (isKey ? "right" : picked ? "wrong" : "none") : "none";
        return el("label", { class: "option", dataResult: result, dataLocked: String(locked) },
          el("input", { type, name: `${slot.id}-${uid}`, checked: picked, disabled: locked, onchange: (e) => {
            if (slot.multiple) { const set = new Set(draft[slot.id] ?? []); if (e.target.checked) set.add(option.id); else set.delete(option.id); draft[slot.id] = [...set]; } else draft[slot.id] = option.id;
          } }),
          el("span", { class: "option-body" },
            el("span", { class: "option-text", html: MD.block(option.content) }),
            locked && picked ? el("span", { class: "tag" }, "你的选择") : null,
            isKey ? el("span", { class: "tag tag-key" }, "正确") : null,
            reveal && picked && option.feedback ? el("span", { class: "option-why", html: MD.inline(option.feedback) }) : null));
      }));
  };

  const orderField = (slot, v, { locked, value }) => {
    const order = () => draft[slot.id] ?? value ?? slot.items.map((i) => i.id);
    const indents = () => draft[`${slot.id}#indent`] ?? {};
    const box = el("div", { class: "slot order", dataSlot: slot.id });
    const paint = () => {
      if (!locked) draft[slot.id] = order();
      box.replaceChildren(...order().map((id, index) => {
        const item = slot.items.find((x) => x.id === id);
        const level = indents()[id] ?? 0;
        const move = (delta) => { const list = [...order()]; const to = index + delta; if (to < 0 || to >= list.length) return; [list[index], list[to]] = [list[to], list[index]]; draft[slot.id] = list; paint(); box.querySelectorAll(".order-row")[to]?.querySelector("button")?.focus(); };
        const shift = (delta) => { draft[`${slot.id}#indent`] = { ...indents(), [id]: Math.max(0, level + delta) }; paint(); };
        return el("div", { class: "order-row", style: `--indent:${level}` },
          el("span", { class: "order-index" }, String(index + 1)),
          el("code", { class: "order-code" }, item.code),
          locked ? null : el("span", { class: "order-move" },
            slot.indent ? el("button", { type: "button", ariaLabel: "减少缩进", onclick: () => shift(-1), html: ICON.out }) : null,
            slot.indent ? el("button", { type: "button", ariaLabel: "增加缩进", onclick: () => shift(1), html: ICON.in }) : null,
            el("button", { type: "button", ariaLabel: "上移", onclick: () => move(-1), html: ICON.up }),
            el("button", { type: "button", ariaLabel: "下移", onclick: () => move(1), html: ICON.down })));
      }));
    };
    paint();
    return box;
  };

  const tableField = (slot, v, { locked, value, reveal }) => el("div", { class: "slot", dataSlot: slot.id },
    el("p", { class: "slot-prompt", html: MD.inline(slot.prompt ?? "") }),
    el("table", { class: "grid-table" },
      el("thead", {}, el("tr", {}, ...slot.columns.map((c) => el("th", {}, c.header)))),
      el("tbody", {}, ...slot.rows.map((row) => el("tr", {}, ...slot.columns.map((c) => {
        if (!c.input) return el("td", {}, String(row.cells[c.id]));
        const typed = value?.[row.id]?.[c.id];
        const correct = reveal && String(typed ?? "") === String(row.cells[c.id]);
        return el("td", { dataResult: reveal ? (correct ? "right" : "wrong") : "none" },
          el("input", { class: "field field-cell", readOnly: locked, value: typed ?? "", ariaLabel: `${row.cells[slot.columns[0].id]} 的 ${c.header}`, oninput: (e) => { draft[slot.id] = { ...(draft[slot.id] ?? {}), [row.id]: { ...(draft[slot.id]?.[row.id] ?? {}), [c.id]: e.target.value } }; } }),
          reveal && !correct ? el("b", { class: "cell-key" }, String(row.cells[c.id])) : null);
      }))))));

  const codeField = (slot, v, { locked, value, reveal }) => {
    const output = el("pre", { class: "output", hidden: true });
    return el("div", { class: "slot", dataSlot: slot.id },
      el("div", { class: "editor" },
        el("textarea", { class: "editor-text", spellcheck: false, readOnly: locked, ariaLabel: "代码", value: value ?? slot.starter ?? "", rows: Math.max(3, slot.maxLines ?? 3), oninput: (e) => { draft[slot.id] = e.target.value; } }),
        locked ? null : el("div", { class: "editor-run" }, button("运行", "plane", () => { output.hidden = false; output.textContent = "capacity = 186"; }))),
      output,
      reveal ? el("ul", { class: "tests" }, ...(slot.tests ?? []).map((t) => el("li", { dataResult: v.verdict === "right" ? "right" : "wrong" }, el("i"), t.name))) : null);
  };
  const FIELDS = { text: textField, choice: choiceField, order: orderField, table: tableField, code: codeField };

  /** Submits through the model. If it does not accept the answer, say why beside the field and move focus there. */
  const trySubmit = (response = { ...draft }) => {
    document.querySelectorAll(".field-error").forEach((node) => node.remove());
    document.querySelectorAll('[aria-invalid="true"]').forEach((node) => { node.removeAttribute("aria-invalid"); node.removeAttribute("aria-describedby"); });
    const found = app.actions.submit(response);
    let first;
    for (const { slotId, message } of found) {
      const host = document.querySelector(`[data-slot="${slotId}"]`);
      if (!host) continue;
      const control = host.querySelector("input, textarea");
      const id = `e-${slotId}`;
      host.append(el("p", { class: "field-error", id, role: "alert" }, message));
      if (control && control.type !== "radio" && control.type !== "checkbox") { control.setAttribute("aria-invalid", "true"); control.setAttribute("aria-describedby", id); }
      first ??= control;
    }
    first?.focus();
  };

  // ---- screens

  const question = (v, q, { locked = false, reveal = false, response } = {}) => el("div", { class: "question" },
    el("div", { class: "prose", html: MD.block(q.body ?? "") }),
    ...q.slots.map((slot) => FIELDS[slot.type](slot, v, { locked, reveal, value: locked ? response?.[slot.id] : undefined })));

  const slotFeedback = (q, response) => {
    const notes = [];
    for (const slot of q.slots) {
      for (const f of slot.feedback ?? []) if (String(f.when) === String(response?.[slot.id] ?? "")) notes.push(f.message);
    }
    return notes.length ? el("div", { class: "slot-note prose", html: notes.map((n) => `<p>${MD.inline(n)}</p>`).join("") }) : null;
  };

  const verdict = (kind) => el("p", { class: "verdict", dataVerdict: kind, role: "status", html: `${ICON[kind]}${kind === "right" ? "答对了" : "答错了"}` });

  const keys = (q) => {
    const texts = q.slots.filter((s) => s.type === "text").map((s) => String(s.key));
    return texts.length ? el("section", { class: "reference" }, el("h3", {}, "参考答案"), el("p", { class: "reference-value" }, texts.join("、"))) : null;
  };
  const analysis = (q) => (q.explanation ? el("section", { class: "analysis prose" }, el("h3", {}, "解析"), el("div", { html: MD.block(q.explanation) })) : null);

  const OUTCOMES = { passed: "通过", failed: "没有通过", timeout: "时间到", unresolved: "还有作答在判" };

  const completed = (v) => el("div", { class: "result" },
    el("p", { class: "result-kind" }, `${v.kindName}结束`),
    el("h2", { class: "result-outcome", dataOutcome: v.outcome }, OUTCOMES[v.outcome]),
    v.outcome === "unresolved" ? el("p", { class: "result-xp" }, "XP 待定") : v.reward ? el("p", { class: "result-xp" }, `+\u00a0${v.reward}\u00a0XP`) : null,
    v.submissions.length ? el("ol", { class: "result-list" }, ...v.submissions.map((x) => el("li", { dataResult: x.correct ? "right" : "wrong" },
      el("details", { open: v.restricted && !x.correct },
        el("summary", { html: `${ICON[x.correct ? "right" : "wrong"]}<span class="sr">${x.correct ? "答对" : "答错"}</span>${MD.inline((x.question.slots[0].prompt ?? x.question.body ?? "").split("\n")[0].slice(0, 40))}` }),
        keys(x.question), analysis(x.question))))) : null);

  const screen = (v) => {
    if (v.stage === "explanation") return el("article", { class: "screen prose", html: MD.block(v.lesson) });
    if (v.stage === "example") return el("article", { class: "screen prose", html: MD.block(v.example.body) + MD.block(v.example.explanation) });
    if (v.stage === "answering") { draft = {}; return el("article", { class: "screen" }, question(v, v.question)); }
    if (v.stage === "judging") return el("article", { class: "screen" }, question(v, v.question, { locked: true, response: v.response }), el("p", { class: "judging", role: "status" }, "正在判分…"));
    if (v.stage === "recovery") return el("article", { class: "screen" }, question(v, v.question, { locked: true, response: v.response }), el("p", { class: "recovery", role: "status" }, "没能判出结果"));
    if (v.stage === "feedback") {
      return el("article", { class: "screen" }, verdict(v.verdict), question(v, v.question, { locked: true, reveal: true, response: v.response }), slotFeedback(v.question, v.response), keys(v.question), analysis(v.question));
    }
    if (v.stage === "completed") return el("article", { class: "screen" }, completed(v));
    return el("article", { class: "screen" });
  };

  const actions = (v) => {
    const a = app.actions;
    const row = (...items) => el("div", { class: "actions" }, ...items);
    if (v.stage === "explanation") return row(button("看例题", "primary", a.advance));
    if (v.stage === "example") return row(button("开始练习", "primary", a.advance));
    if (v.stage === "answering") return row(dontKnow(v), button(v.kind === "quiz" && v.q === v.total - 1 ? "交卷" : "提交", "primary", () => trySubmit()));
    if (v.stage === "recovery") return row(button("先做下一题", "quiet", a.advance), button("再判一次", "primary", a.retry));
    if (v.stage === "feedback") return row(button("继续", "primary", a.advance));
    if (v.stage === "completed") return row(button("继续", "primary", a.home));
    return row();
  };

  /** Whether "不会" exists is the contract's call, so a frame that wants it alone asks here. */
  const dontKnow = (v) => (v.stage === "answering" && v.kind !== "quiz" ? button("不会", "quiet", app.actions.dontKnow) : null);

  const tutor = (v) => {
    const closed = !v.tutorAllowed;
    return el("aside", { class: "tutor", ariaLabel: "辅导", dataClosed: String(closed) },
      el("h2", { class: "tutor-title" }, "辅导", closed ? icon("lock") : null),
      el("div", { class: "tutor-log" }, ...v.tutorMessages.map((m) => el("div", { class: m.me ? "msg-me" : "msg-tutor", html: m.me ? MD.inline(m.me) : m.html }))),
      el("form", { class: "tutor-input", onsubmit: (e) => { e.preventDefault(); const t = e.target.querySelector("textarea"); if (t.value.trim()) { app.actions.ask(t.value.trim()); } } },
        el("textarea", { rows: 1, ariaLabel: "问辅导", disabled: closed, onkeydown: (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.target.form.requestSubmit(); } } }),
        el("button", { type: "submit", ariaLabel: "发送", disabled: closed, class: "tutor-send", html: ICON.send })));
  };

  /** A figure in a box. Mounted once per box; the frame keeps the box. */
  const figure = (name) => {
    const box = el("div", { class: "figure", ariaHidden: "true" });
    const instance = window.Figures[name].mount(box);
    return { box, update: (v) => instance.update(v.progress), stop: () => instance.stop() };
  };

  const menu = (v) => el("div", { class: "menu" }, ...v.menu.map((m, i) => el("a", { class: `menu-item${i === 0 ? " is-first" : ""}`, href: "#", onclick: (e) => { e.preventDefault(); app.actions.start(m.kind); } },
    el("span", { class: "menu-kind" }, m.kindName), el("span", { class: "menu-title" }, phrase(m.title)))));
  const goal = (v) => el("div", { class: "goal" },
    el("span", { class: "xp" }, `今天 ${v.xp.today}\u00a0/\u00a0${v.xp.goal}\u00a0XP`),
    el("div", { class: "goal-cells", role: "meter", ariaLabel: "今天的 XP", ariaValuemin: "0", ariaValuemax: String(v.xp.goal), ariaValuenow: String(v.xp.today) },
      ...Array.from({ length: v.xp.goal }, (_, i) => el("i", i < v.xp.today ? { dataOn: "1" } : {}))));
  const offline = (v) => (v.offline ? el("p", { class: "offline", role: "status" }, "连接断开，正在重连…") : null);

  return { el, phrase, button, dontKnow, trySubmit, icon, xp, course, abort, clock, kindLabel, topic, steps, kps, question, screen, actions, tutor, figure, menu, goal, offline, verdict };
};
