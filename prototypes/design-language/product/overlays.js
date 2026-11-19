// What floats: the inline preview, search, the whole conversation, confirmation. What floats is round.
window.Overlays = (model) => {
  const { MD, h, phrase, tileIcon } = window;
  const OPEN_MS = 500, CLOSE_MS = 200;

  // ---- preview: "what was this again", without leaving where you are

  const peekBox = h("div", { class: "peek", role: "tooltip", hidden: true });
  document.body.append(peekBox);
  let openTimer, closeTimer, anchor = null, pinned = false;

  function peekContent(a) {
    if (a.dataset.kp) {
      const c = model.lib.card(a.dataset.kp);
      if (!c) return null;
      const first = c.definition.trim();
      return [
        h("div", { class: "peek-head" }, tileIcon({ ...model.lib.entry(c.id), index: c.index }, 20), h("b", {}, c.name)),
        c.aliases.length ? h("p", { class: "peek-alias" }, c.aliases.join("、")) : null,
        h("div", { class: "peek-text", html: MD.block(first) }),
        h("div", { class: "peek-foot" },
          h("span", {}, c.days === null ? c.words : c.days === 0 ? "今天学的" : `${c.days} 天前学的`),
          h("a", { href: `#/k/${c.id}`, class: "peek-open" }, "打开")),
      ];
    }
    const t = model.lib.topicCard(a.dataset.topic);
    if (!t?.readable) return null;
    return [
      h("div", { class: "peek-head" }, h("b", {}, phrase(t.title))),
      t.summary ? h("p", { class: "peek-text" }, t.summary) : null,
      h("div", { class: "peek-foot" }, h("span", {}, t.kps.join("、")), h("a", { href: `#/k/${t.id}`, class: "peek-open" }, "打开")),
    ];
  }

  function place(a) {
    const r = a.getBoundingClientRect();
    if (matchMedia("(pointer: coarse)").matches) { peekBox.style.left = peekBox.style.top = ""; return; }
    peekBox.style.left = "0"; peekBox.style.top = "0";
    const box = peekBox.getBoundingClientRect();
    const left = Math.max(16, Math.min(r.left, innerWidth - box.width - 16));
    const below = r.bottom + 8 + box.height < innerHeight - 16;
    const top = below ? r.bottom + 8 : Math.max(16, r.top - box.height - 8);
    peekBox.style.left = `${left}px`;
    peekBox.style.top = `${top}px`;
    peekBox.dataset.side = below ? "below" : "above";
  }

  function showPeek(a, pin = false) {
    clearTimeout(openTimer); clearTimeout(closeTimer);
    const content = peekContent(a);
    if (!content) { hidePeek(); return; }
    anchor = a; pinned = pin;
    peekBox.replaceChildren(...content.filter(Boolean));
    peekBox.hidden = false;
    place(a);
    a.setAttribute("aria-describedby", "peek");
  }
  function hidePeek() {
    clearTimeout(openTimer); clearTimeout(closeTimer);
    anchor?.removeAttribute("aria-describedby");
    anchor = null; pinned = false;
    peekBox.hidden = true;
  }
  peekBox.id = "peek";
  const target = (node) => node.closest?.("[data-kp], [data-topic-peek]");
  const normal = (a) => { if (a.dataset.topicPeek) a.dataset.topic = a.dataset.topicPeek; return a; };

  document.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const a = target(e.target);
    if (peekBox.contains(e.target)) { clearTimeout(closeTimer); return; }
    if (a) {
      clearTimeout(closeTimer);
      if (a === anchor) return;
      clearTimeout(openTimer);
      // Once one card is open, moving to the next link is reading on, not a stray pointer.
      openTimer = setTimeout(() => showPeek(normal(a)), anchor ? 120 : OPEN_MS);
      return;
    }
    clearTimeout(openTimer);
    if (anchor && !pinned) closeTimer = setTimeout(hidePeek, CLOSE_MS);
  });
  document.addEventListener("focusin", (e) => {
    const a = target(e.target);
    if (a && document.documentElement.dataset.input === "key") showPeek(normal(a));
    else if (anchor && !pinned && !peekBox.contains(e.target)) hidePeek();
  });
  document.addEventListener("click", (e) => {
    if (peekBox.contains(e.target)) { if (e.target.closest("a")) hidePeek(); return; }
    const concept = e.target.closest("a.concept");
    if (concept) { e.preventDefault(); showPeek(concept, true); return; }
    if (anchor) hidePeek();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && anchor) { const back = anchor; hidePeek(); back.focus?.(); e.stopPropagation(); }
  }, true);

  // ---- search

  const input = h("input", { class: "find-input", type: "text", placeholder: "搜索学过的内容", autocomplete: "off", spellcheck: false, role: "combobox", ariaExpanded: "true", ariaControls: "find-list", ariaLabel: "搜索" });
  const list = h("ul", { class: "find-list", id: "find-list", role: "listbox" });
  const finder = h("dialog", { class: "find", ariaLabel: "搜索" }, h("form", { method: "dialog", class: "find-form", onsubmit: (e) => e.preventDefault() }, input), list);
  document.body.append(finder);
  let results = [], active = 0;
  const hit = (text, q) => {
    const safe = MD.esc(text ?? "");
    if (!q) return safe;
    const at = safe.toLowerCase().indexOf(MD.esc(q).toLowerCase());
    return at < 0 ? safe : `${safe.slice(0, at)}<mark>${safe.slice(at, at + MD.esc(q).length)}</mark>${safe.slice(at + MD.esc(q).length)}`;
  };
  const openable = (r) => r.type === "kp" || r.readable;
  function go(r) {
    if (!r || !openable(r)) return;
    finder.close();
    location.hash = `#/k/${r.id}`;
  }
  function paint() {
    const q = input.value.trim();
    results = q ? model.lib.search(q) : model.lib.recent();
    active = Math.min(active, Math.max(0, results.length - 1));
    if (!openable(results[active] ?? {})) active = results.findIndex(openable);
    list.replaceChildren(...results.map((r, i) => {
      const entry = r.type === "kp" ? model.lib.entry(r.id) : model.lib.topicEntry(r.id);
      return h("li", { role: "option", id: `find-${i}`, class: "find-row", ariaSelected: String(i === active), ariaDisabled: openable(r) ? null : "true", onclick: () => go(r), onpointermove: () => { if (openable(r) && active !== i) { active = i; mark(); } } },
        tileIcon({ ...entry, index: entry.index ?? 0 }, 20),
        h("span", { class: "find-main" },
          h("span", { class: "find-name", html: hit(r.name, q) }),
          r.alias && r.alias !== r.name ? h("span", { class: "find-alias", html: hit(r.alias, q) }) : null,
          r.snippet ? h("span", { class: "find-text", html: hit(r.snippet, q) }) : !openable(r) ? h("span", { class: "find-text" }, "还没学") : null),
        r.topicTitle ? h("span", { class: "find-where" }, r.topicTitle) : null);
    }));
    list.hidden = !results.length;
    empty.hidden = !q || results.length > 0;
    input.setAttribute("aria-activedescendant", active >= 0 && results.length ? `find-${active}` : "");
  }
  const empty = h("p", { class: "find-empty", hidden: true }, "没有找到");
  finder.append(empty);
  const mark = () => {
    list.querySelectorAll(".find-row").forEach((row, i) => row.setAttribute("aria-selected", String(i === active)));
    input.setAttribute("aria-activedescendant", `find-${active}`);
    list.children[active]?.scrollIntoView({ block: "nearest" });
  };
  input.addEventListener("input", () => { active = 0; paint(); });
  input.addEventListener("keydown", (e) => {
    const step = (d) => { for (let i = active + d; i >= 0 && i < results.length; i += d) { if (openable(results[i])) { active = i; mark(); return; } } };
    if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
    else if (e.key === "Enter") { e.preventDefault(); if (!e.isComposing) go(results[active]); }
  });
  finder.addEventListener("click", (e) => { if (e.target === finder) finder.close(); });
  const openFinder = () => { if (model.view().shut || finder.open) return; hidePeek(); input.value = ""; active = 0; paint(); finder.showModal(); input.focus(); };

  // ---- the whole conversation

  const log = h("div", { class: "sheet-log" });
  const sheet = h("dialog", { class: "sheet", ariaLabel: "对话" },
    h("div", { class: "sheet-head" }, h("h2", {}, "对话"), h("button", { type: "button", class: "btn btn-quiet", onclick: () => sheet.close() }, "关闭")),
    log,
    h("div", { class: "sheet-foot" }));
  document.body.append(sheet);
  sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.close(); });
  const talkEntry = (m) => h("div", { class: "talk-entry" },
    m.where ? h("p", { class: "talk-where" }, m.where) : null,
    h("p", { class: "talk-me" }, m.me),
    m.reply === null ? h("p", { class: "talk-wait", role: "status" }, "…") : h("div", { class: "prose talk-reply", html: MD.block(m.reply) }));
  function paintSheet(v, askForm) {
    log.replaceChildren(...v.talk.map(talkEntry));
    sheet.querySelector(".sheet-foot").replaceChildren(...(askForm ? [askForm] : []));
    log.scrollTop = log.scrollHeight;
  }
  const openSheet = (v, askForm) => { hidePeek(); paintSheet(v, askForm); if (!sheet.open) sheet.showModal(); };

  // ---- confirmation

  function confirm({ title, body, yes, onYes }) {
    const box = h("dialog", { class: "confirm", ariaLabel: title },
      h("h2", {}, title),
      body ? h("p", {}, body) : null,
      h("div", { class: "confirm-actions" },
        h("button", { type: "button", class: "btn btn-quiet", onclick: () => box.close() }, "取消"),
        h("button", { type: "button", class: "btn btn-primary", onclick: () => { box.close(); onYes(); } }, yes)));
    box.addEventListener("close", () => box.remove());
    document.body.append(box);
    box.showModal();
  }

  return { openFinder, hidePeek, openSheet, paintSheet, sheetOpen: () => sheet.open, talkEntry, confirm };
};
