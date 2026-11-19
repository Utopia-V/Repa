// The question forms, one per slot type. A result is shown beside what it is about, and nothing above the answer moves when it arrives.
window.Forms = (model) => {
  const { MD } = window;
  const el = window.h;
  const ICON = {
    right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.6 4.6L19 7.5"/></svg>',
    wrong: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
    in: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    out: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  };
  // A draft belongs to its question, so leaving and coming back costs nothing.
  const drafts = new Map();
  let draft = {};
  let currentId = null;
  let uid = 0;
  const use = (id) => { currentId = id; draft = drafts.get(id) ?? {}; drafts.set(id, draft); };
  const norm = (value) => String(value ?? "").trim();

  const note = (html) => el("p", { class: "slot-note", html });
  const keyLine = (label, value) => el("p", { class: "slot-key" }, el("span", {}, label), el("code", { translate: "no" }, String(value)));

  const textField = (slot, { locked, reveal, value }) => {
    const id = `f-${slot.id}-${uid += 1}`;
    const right = reveal && norm(value) === norm(slot.key);
    const said = reveal ? (slot.feedback ?? []).find((f) => norm(f.when) === norm(value))?.message : null;
    const answered = locked && value !== undefined && value !== null;
    const typed = locked ? (answered ? value : "") : draft[slot.id] ?? "";
    return el("div", { class: "slot", dataSlot: slot.id, dataResult: reveal ? (right ? "right" : "wrong") : "none" },
      slot.prompt ? el("label", { class: "slot-prompt", for: id, html: MD.inline(slot.prompt) }) : null,
      el("div", { class: "field-row" },
        el("input", { class: "field", id, ...(slot.prompt ? {} : { ariaLabel: "作答" }), inputmode: slot.format === "integer" ? "numeric" : "text", autocomplete: "off", spellcheck: false, translate: false, readOnly: locked, value: typed, placeholder: locked && !answered ? "没有作答" : "", oninput: (e) => { draft[slot.id] = e.target.value; }, onkeydown: (e) => { if (e.key === "Enter" && !locked) { e.preventDefault(); trySubmit(); } } }),
        slot.suffix ? el("span", { class: "field-suffix" }, slot.suffix) : null),
      reveal && !right ? keyLine("正确答案", slot.key) : null,
      said ? note(MD.inline(said)) : null);
  };

  const choiceField = (slot, { locked, reveal, value, worked: isWorked }) => {
    const type = slot.multiple ? "checkbox" : "radio";
    const name = `c-${slot.id}-${uid += 1}`;
    const allRight = reveal && (slot.multiple ? JSON.stringify([...(value ?? [])].sort()) === JSON.stringify([...(slot.key ?? [])].sort()) : value === slot.key);
    return el("fieldset", { class: "slot options", dataSlot: slot.id, dataResult: reveal ? (allRight ? "right" : "wrong") : "none" },
      el("legend", { class: "slot-prompt", html: MD.inline(slot.prompt ?? "") }),
      ...slot.options.map((option, index) => {
        const chosen = locked ? value : draft[slot.id];
        const picked = slot.multiple ? (chosen ?? []).includes(option.id) : chosen === option.id;
        const isKey = reveal && (slot.multiple ? (slot.key ?? []).includes(option.id) : slot.key === option.id);
        const result = reveal ? (isKey ? "right" : picked ? "wrong" : "none") : "none";
        return el("label", { class: "option", dataResult: result, dataLocked: String(locked), dataPicked: String(picked) },
          el("input", { type, name, checked: picked, disabled: locked, dataIndex: String(index), onchange: (e) => {
            if (slot.multiple) { const set = new Set(draft[slot.id] ?? []); if (e.target.checked) set.add(option.id); else set.delete(option.id); draft[slot.id] = [...set]; } else draft[slot.id] = option.id;
          } }),
          el("span", { class: "option-body" },
            el("span", { class: "option-text", html: MD.block(String(option.content)) }),
            locked && picked && !isWorked ? el("span", { class: "tag" }, "你的选择") : null,
            isKey ? el("span", { class: "tag tag-key" }, "正确") : null,
            reveal && picked && option.feedback ? el("span", { class: "option-why", html: MD.inline(option.feedback) }) : null));
      }));
  };

  const itemHtml = (item) => (item.code !== undefined ? MD.esc(String(item.code)) : MD.inline(String(item.text ?? item.content ?? item.label ?? "")));
  const orderField = (slot, { locked, reveal, value }) => {
    const order = () => (locked ? value : draft[slot.id]) ?? slot.items.map((i) => i.id);
    const indents = () => (locked ? null : draft[`${slot.id}#indent`]) ?? {};
    const box = el("div", { class: "order" });
    const paint = () => {
      if (!locked) draft[slot.id] = order();
      box.replaceChildren(...order().map((id, index) => {
        const item = slot.items.find((x) => x.id === id);
        const level = indents()[id] ?? 0;
        const move = (delta) => { const list = [...order()]; const to = index + delta; if (to < 0 || to >= list.length) return; [list[index], list[to]] = [list[to], list[index]]; draft[slot.id] = list; paint(); box.querySelectorAll(".order-row")[to]?.querySelector(delta < 0 ? '[data-move="up"]' : '[data-move="down"]')?.focus(); };
        const shift = (delta) => { draft[`${slot.id}#indent`] = { ...indents(), [id]: Math.max(0, level + delta) }; paint(); };
        const place = reveal ? (slot.key?.[index] === id ? "right" : "wrong") : "none";
        return el("div", { class: "order-row", dataResult: place, style: `--indent:${level}` },
          el("span", { class: "order-index" }, String(index + 1)),
          el("code", { class: "order-code", translate: "no", html: itemHtml(item) }),
          locked ? null : el("span", { class: "order-move" },
            slot.indent ? el("button", { type: "button", ariaLabel: "减少缩进", onclick: () => shift(-1), html: ICON.out }) : null,
            slot.indent ? el("button", { type: "button", ariaLabel: "增加缩进", onclick: () => shift(1), html: ICON.in }) : null,
            el("button", { type: "button", ariaLabel: "上移", dataMove: "up", disabled: index === 0, onclick: () => move(-1), html: ICON.up }),
            el("button", { type: "button", ariaLabel: "下移", dataMove: "down", disabled: index === order().length - 1, onclick: () => move(1), html: ICON.down })));
      }));
    };
    paint();
    const wrong = reveal && JSON.stringify(order()) !== JSON.stringify(slot.key);
    return el("div", { class: "slot", dataSlot: slot.id, dataResult: reveal ? (wrong ? "wrong" : "right") : "none" },
      el("p", { class: "slot-prompt", html: MD.inline(slot.prompt ?? "") }),
      box,
      wrong ? el("div", { class: "order-key" }, el("p", { class: "slot-key" }, el("span", {}, "正确顺序")), el("pre", { class: "code", translate: "no" }, el("code", {}, ...slot.key.map((id) => el("span", { class: "ln", html: itemHtml(slot.items.find((x) => x.id === id)) }))))) : null);
  };

  /** A cell is whatever its column asks for: a number, True or False, one of a few options, or text with quick fills. */
  function cellInput(slot, row, col, { locked, value }) {
    const kind = typeof col.input === "object" ? col.input.type : col.input;
    const set = (next) => { draft[slot.id] = { ...(draft[slot.id] ?? {}), [row.id]: { ...(draft[slot.id]?.[row.id] ?? {}), [col.id]: next } }; };
    const label = `${Object.values(row.cells)[0] ?? row.id} 的 ${col.header}`;
    const pick = (options) => {
      const name = `t-${uid += 1}`;
      return el("span", { class: "cell-pick", role: "radiogroup", ariaLabel: label }, ...options.map(({ id, text }) => el("label", { class: "cell-opt" },
        el("input", { type: "radio", name, disabled: locked, checked: norm(value).toLowerCase() === id.toLowerCase(), onchange: () => set(id) }),
        el("span", { translate: "no" }, text))));
    };
    if (kind === "bool") return pick([{ id: "true", text: "True" }, { id: "false", text: "False" }]);
    if (kind === "choice") return pick(col.input.options.map((o) => ({ id: o.id, text: o.label })));
    const quick = typeof col.input === "object" ? col.input.quick : null;
    const input = el("input", { class: "field field-cell", readOnly: locked, value: value ?? "", ariaLabel: label, inputmode: (kind === "integer" || col.input?.format === "integer") ? "numeric" : "text", autocomplete: "off", spellcheck: false, translate: false, oninput: (e) => set(e.target.value) });
    return quick && !locked
      ? el("span", { class: "cell-quick" }, input, ...quick.map((word) => el("button", { type: "button", class: "quick", translate: "no", onclick: () => { input.value = word; set(word); } }, word)))
      : input;
  }

  /** No Han in it: an identifier, a value or a line of code, so it takes the code face. */
  const isCode = (cell) => !/[\u3400-\u9fff]/.test(String(cell)) || /^`[^`]+`$/.test(String(cell));
  const tableField = (slot, { locked, reveal, value }) => {
    const shown = (cell) => (cell === true ? "True" : cell === false ? "False" : String(cell));
    const anyWrong = reveal && slot.rows.some((row) => slot.columns.some((c) => c.input && norm(value?.[row.id]?.[c.id]).toLowerCase() !== norm(row.cells[c.id]).toLowerCase()));
    return el("div", { class: "slot", dataSlot: slot.id, dataResult: reveal ? (anyWrong ? "wrong" : "right") : "none" },
      slot.prompt ? el("p", { class: "slot-prompt", html: MD.inline(slot.prompt) }) : null,
      el("div", { class: "table-wrap" }, el("table", { class: "grid-table" },
        el("thead", {}, el("tr", {}, ...slot.columns.map((c) => el("th", { translate: "no", class: isCode(c.header) ? "is-code" : null, html: MD.inline(String(c.header)) })))),
        el("tbody", {}, ...slot.rows.map((row) => el("tr", {}, ...slot.columns.map((c) => {
          if (!c.input) return el("td", { translate: "no", class: isCode(row.cells[c.id]) ? "is-code" : null, html: MD.inline(shown(row.cells[c.id])) });
          const typed = (locked ? value : draft[slot.id])?.[row.id]?.[c.id];
          const correct = reveal && norm(typed).toLowerCase() === norm(row.cells[c.id]).toLowerCase();
          const answer = typeof c.input === "object" && c.input.type === "choice" ? c.input.options.find((o) => o.id === row.cells[c.id])?.label : shown(row.cells[c.id]);
          return el("td", { dataResult: reveal ? (correct ? "right" : "wrong") : "none" },
            cellInput(slot, row, c, { locked, value: typed }),
            reveal && !correct ? el("b", { class: "cell-key", translate: "no" }, answer) : null);
        })))))));
  };

  const codeField = (slot, { locked, reveal, value, worked: isWorked }) => {
    const output = el("pre", { class: "output", hidden: true });
    const passed = norm(value) === norm(slot.solution) || (slot.accepts ?? []).map(norm).includes(norm(value));
    return el("div", { class: "slot", dataSlot: slot.id, dataResult: reveal ? (passed ? "right" : "wrong") : "none" },
      slot.prompt ? el("p", { class: "slot-prompt", html: MD.inline(slot.prompt) }) : null,
      el("div", { class: "editor" },
        el("textarea", { class: "editor-text", spellcheck: false, translate: false, readOnly: locked, ariaLabel: "代码", value: (locked ? value : draft[slot.id]) ?? slot.starter ?? "", rows: Math.max(3, slot.maxLines ?? 3), oninput: (e) => { draft[slot.id] = e.target.value; } }),
        locked ? null : el("div", { class: "editor-run" }, el("button", { type: "button", class: "btn btn-plane", onclick: () => { output.hidden = false; output.textContent = "（原型不运行代码）"; } }, "运行"))),
      output,
      reveal && !isWorked ? el("ul", { class: "tests" }, ...(slot.tests ?? []).filter((t) => !t.hidden).map((t) => el("li", { dataResult: passed ? "right" : "wrong" }, el("i"), t.name))) : null);
  };

  const FIELDS = { text: textField, choice: choiceField, order: orderField, table: tableField, code: codeField };

  /** Submits through the model. If it refuses, say why beside the field and move focus there. */
  function trySubmit() {
    document.querySelectorAll(".field-error").forEach((node) => node.remove());
    document.querySelectorAll('[aria-invalid="true"]').forEach((node) => { node.removeAttribute("aria-invalid"); node.removeAttribute("aria-describedby"); });
    const answering = currentId;
    const found = model.actions.submit({ ...draft });
    if (!found.length) drafts.delete(answering);
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
  }

  const dataset = (d) => {
    if (d.kind === "python") return d.display ? el("div", { class: "dataset prose", html: MD.block(d.display) }) : null;
    if (d.kind !== "dataframe") return null;
    // An index that is not 0, 1, 2 is part of what is being taught: it is drawn, under its own header.
    const withIndex = Boolean(d.index) && d.showIndex !== false;
    const names = [...(withIndex ? [d.indexHeader ?? ""] : []), ...Object.keys(d.columns)];
    const first = Object.values(d.columns)[0] ?? [];
    const rows = first.map((_, i) => [...(withIndex ? [d.index[i]] : []), ...Object.values(d.columns).map((col) => col[i])]);
    const shown = (cell) => (cell === null ? "NaN" : cell === true ? "True" : cell === false ? "False" : String(cell));
    return el("figure", { class: "dataset" },
      d.caption ? el("figcaption", {}, d.caption, d.name ? el("code", { translate: "no" }, d.name) : null) : null,
      el("div", { class: "table-wrap" }, el("table", { class: "md-table" },
        el("thead", {}, el("tr", {}, ...names.map((n) => el("th", { translate: "no", class: isCode(n) ? "is-code" : null }, n)))),
        el("tbody", {}, ...rows.map((row) => el("tr", {}, ...row.map((cell) => el("td", { translate: "no", class: isCode(shown(cell)) ? "is-code" : null }, shown(cell)))))))));
  };

  const question = (q, { locked = false, reveal = false, response, worked: isWorked = false } = {}) => {
    if (!locked) use(q.id);
    const tables = (q.datasets ?? []).map(dataset).filter(Boolean);
    return el("div", { class: "question" },
      el("div", { class: "prose", html: MD.block(q.body ?? "") }),
      tables.length ? el("div", { class: "datasets" }, ...tables) : null,
      ...q.slots.map((slot) => FIELDS[slot.type](slot, { locked, reveal, worked: isWorked, value: locked ? response?.[slot.id] : undefined })));
  };

  /** A worked example: the steps are answered, nothing to fill in. */
  const worked = (q) => {
    const answers = Object.fromEntries(q.slots.map((slot) => [slot.id, slot.type === "table" ? Object.fromEntries(slot.rows.map((r) => [r.id, r.cells])) : slot.type === "order" ? slot.key : slot.type === "code" ? slot.solution : slot.key]));
    const node = question(q, { locked: true, reveal: true, worked: true, response: answers });
    node.classList.add("worked");
    return el("div", {}, node, q.explanation ? el("div", { class: "prose worked-why", html: MD.block(q.explanation) }) : null);
  };

  const verdict = (kind) => el("p", { class: "verdict", dataVerdict: kind, role: "status", html: `${ICON[kind]}${kind === "right" ? "答对了" : "答错了"}` });

  return { trySubmit, question, worked, verdict, dataset, ICON };
};
