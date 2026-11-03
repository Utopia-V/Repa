// The knowledge base. Each view does the job it is good at: the tree orients, the page is for reading back, the relations beside it say what this stands on and leads to, the whole map shows the course filling in.
window.Library = (model, root, forms) => {
  const { MD, h, phrase, tileIcon } = window;
  const tree = h("nav", { class: "lib-tree", ariaLabel: "目录" });
  const main = h("div", { class: "lib-main" });
  const rail = h("aside", { class: "lib-rail" });
  const tabsBox = h("div", { class: "lib-tabs", role: "tablist", ariaLabel: "视图" });
  const side = h("div", { class: "lib-side" }, tabsBox, rail);
  // On a phone the page comes first; tree and relations open from here when wanted.
  const sheet = (name) => { root.dataset.sheet = root.dataset.sheet === name ? "" : name; if (root.dataset.sheet === "tree") reveal(); };
  const phoneBar = h("div", { class: "lib-bar" },
    h("button", { type: "button", class: "lib-open", onclick: () => sheet("tree") }, "目录"),
    h("button", { type: "button", class: "lib-open", onclick: () => sheet("rail") }, "关系"));
  const scrim = h("div", { class: "lib-scrim", onclick: () => { root.dataset.sheet = ""; } });
  root.append(phoneBar, tree, main, side, scrim);
  addEventListener("keydown", (e) => { if (e.key === "Escape" && root.dataset.sheet) root.dataset.sheet = ""; });
  const narrow = () => matchMedia("(max-width: 960px)").matches;
  let railOnSelect = false;

  const expanded = new Set();
  const FUTURE = "__future";
  let selected = null, roving = null, buffer = "", bufferAt = 0, spy = null, mainKey = null, towerOn = false;

  const chevron = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5 7.5 6 4 9.5"/></svg>';

  // ---- tree

  function nodes() {
    const topics = model.lib.topics();
    const open = topics.filter((t) => t.readable || t.tried);
    const later = topics.filter((t) => !t.readable && !t.tried);
    return { open, later };
  }
  function visible() {
    const { open, later } = nodes();
    const out = [];
    for (const t of open) {
      out.push({ id: t.id, depth: 1, topic: t, parent: null });
      if (expanded.has(t.id)) for (const kp of t.kps) out.push({ id: kp.id, depth: 2, kp, parent: t.id });
    }
    if (later.length) {
      out.push({ id: FUTURE, depth: 1, parent: null });
      if (expanded.has(FUTURE)) for (const t of later) out.push({ id: t.id, depth: 2, later: t, parent: FUTURE });
    }
    return out;
  }
  const activate = (node) => {
    if (node.topic?.readable) location.hash = `#/k/${node.id}`;
    else if (node.kp?.readable) location.hash = `#/k/${node.id}`;
    else if (node.topic || node.id === FUTURE) { toggle(node.id); }
  };
  function toggle(id) { if (expanded.has(id)) expanded.delete(id); else expanded.add(id); renderTree(); focusRow(id); }

  function row(node) {
    const isSel = selected === node.id;
    if (node.id === FUTURE) {
      const { later } = nodes();
      return h("div", { class: "row row-group", onclick: () => toggle(FUTURE) },
        h("span", { class: "chev", html: chevron }), h("span", { class: "row-name" }, "还没学"), h("span", { class: "row-count" }, String(later.length)));
    }
    if (node.later) {
      return h("div", { class: "row row-later" }, tileIcon(model.lib.topicEntry(node.id), 16), h("span", { class: "row-name" }, node.later.title));
    }
    if (node.kp) {
      return h("div", { class: "row row-kp", dataDim: node.kp.readable ? null : "1", onclick: () => { if (node.kp.readable) location.hash = `#/k/${node.id}`; } },
        tileIcon(model.lib.entry(node.id), 16), h("span", { class: "row-name" }, node.kp.name));
    }
    return h("div", { class: "row row-topic", onclick: (e) => {
      if (e.target.closest(".chev")) { toggle(node.id); return; }
      expanded.add(node.id);
      if (node.topic.readable) location.hash = `#/k/${node.id}`; else toggle(node.id);
    } },
      h("span", { class: "chev", html: chevron }), tileIcon(model.lib.topicEntry(node.id), 16), h("span", { class: "row-name" }, node.topic.title));
  }

  function renderTree() {
    const list = visible();
    if (!roving || !list.some((n) => n.id === roving)) roving = selected && list.some((n) => n.id === selected) ? selected : list[0]?.id;
    const ul = h("ul", { role: "tree", ariaLabel: "目录", class: "tree-list", onkeydown: onTreeKey });
    const items = new Map();
    for (const node of list) {
      const hasKids = node.topic || node.id === FUTURE;
      const li = h("li", { role: "treeitem", dataNode: node.id, ariaLevel: String(node.depth), tabindex: node.id === roving ? "0" : "-1", ariaSelected: String(selected === node.id), ariaExpanded: hasKids ? String(expanded.has(node.id)) : null, ariaDisabled: node.later || (node.kp && !node.kp.readable) ? "true" : null, ariaLabel: node.kp ? `${node.kp.name}，${node.kp.words}` : null, onfocus: () => { roving = node.id; } }, row(node));
      if (node.parent && items.has(node.parent)) {
        const parent = items.get(node.parent);
        let group = parent.querySelector(":scope > ul");
        if (!group) { group = h("ul", { role: "group" }); parent.append(group); }
        group.append(li);
      } else ul.append(li);
      items.set(node.id, li);
    }
    const { open } = nodes();
    const passed = open.filter((t) => t.learned).length;
    const many = [...expanded].filter((id) => id !== FUTURE).length > 1 || (expanded.has(FUTURE) && open.length > 0);
    tree.replaceChildren(
      h("div", { class: "tree-head" },
        h("span", { class: "tree-count" }, `已学 ${passed} / ${model.view().course.total}`),
        many ? h("button", { type: "button", class: "link-btn", onclick: () => { expanded.clear(); if (selected) { const t = model.lib.topicOf(selected) ?? selected; expanded.add(t); } renderTree(); reveal(); } }, "收起其余") : null),
      ul);
  }
  const focusRow = (id) => tree.querySelector(`[data-node="${id}"]`)?.focus({ preventScroll: false });
  /** Bring the open item into view, without moving the tree if it is already there. */
  const reveal = () => {
    const row = tree.querySelector('[aria-selected="true"] > .row');
    if (!row) return;
    const r = row.getBoundingClientRect(), box = tree.getBoundingClientRect();
    // The tree's own scroll, never the page's: on a phone the page is what was asked for.
    if (r.top < box.top + 40 || r.bottom > box.bottom) tree.scrollTop += r.top - box.top - box.height / 2;
  };

  /** https://www.w3.org/WAI/ARIA/apg/patterns/treeview/ */
  function onTreeKey(e) {
    const list = visible();
    const i = list.findIndex((n) => n.id === roving);
    const node = list[i];
    if (!node) return;
    const go = (next) => { if (next) { roving = next.id; renderTree(); focusRow(next.id); } };
    const hasKids = node.topic || node.id === FUTURE;
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); go(list[i + 1]); return;
      case "ArrowUp": e.preventDefault(); go(list[i - 1]); return;
      case "Home": e.preventDefault(); go(list[0]); return;
      case "End": e.preventDefault(); go(list[list.length - 1]); return;
      case "ArrowRight":
        e.preventDefault();
        if (hasKids && !expanded.has(node.id)) { expanded.add(node.id); renderTree(); focusRow(node.id); } else if (hasKids) go(list[i + 1]);
        return;
      case "ArrowLeft":
        e.preventDefault();
        if (hasKids && expanded.has(node.id)) { expanded.delete(node.id); renderTree(); focusRow(node.id); } else if (node.parent) go(list.find((n) => n.id === node.parent));
        return;
      case "Enter": case " ":
        e.preventDefault();
        if (node.later) return;
        activate(node);
        return;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const now = performance.now();
          buffer = now - bufferAt > 500 ? e.key : buffer + e.key;
          bufferAt = now;
          const text = (n) => (n.kp?.name ?? n.topic?.title ?? n.later?.title ?? "").toLowerCase();
          const rest = [...list.slice(i + 1), ...list.slice(0, i + 1)];
          go(rest.find((n) => text(n).startsWith(buffer.toLowerCase())));
        }
    }
  }

  // ---- reading page

  const prose = (text, cls = "prose") => h("div", { class: cls, html: MD.block(text) });
  const whenLine = (p) => {
    if (p.days === null || p.days === undefined) return "正在学";
    const when = p.days === 0 ? "今天学的" : `${p.days} 天前学的`;
    return p.memory !== null && p.memory < 0.45 ? `${when}，记忆较弱` : when;
  };

  function relation(label, ids) {
    if (!ids.length) return null;
    return h("div", { class: "rel" }, h("span", { class: "rel-label" }, label), h("span", { class: "rel-items" },
      ...ids.map((id) => {
        const card = model.lib.card(id);
        return h("a", { class: "rel-item", href: `#/k/${id}`, dataKp: id }, tileIcon({ ...model.lib.entry(id), index: card.index }, 16), card.name);
      })));
  }

  function renderPage(topicId, anchor) {
    const p = model.lib.page(topicId);
    if (!p) {
      main.replaceChildren(h("div", { class: "lib-empty" }, h("h1", {}, "还没有学过的内容"), h("p", {}, "学过的 topic 会出现在这里"), h("a", { class: "btn btn-primary", href: "#/" }, "回到今天")));
      return;
    }
    const article = h("article", { class: "kpage" },
      h("header", { class: "kpage-head" },
        h("h1", {}, phrase(p.title)),
        h("p", { class: "kpage-meta" }, whenLine(p)),
        h("p", { class: "kpage-summary" }, p.summary)),
      ...p.kps.map((kp) => h("section", { class: "kp-sec", id: kp.id, dataKpSec: kp.id },
        h("h2", {}, h("span", { class: "kp-name" }, kp.card.name), kp.card.aliases?.length ? h("span", { class: "kp-aliases" }, kp.card.aliases.join("、")) : null),
        prose(kp.card.definition),
        kp.card.conditions?.length ? h("ul", { class: "kp-conditions" }, ...kp.card.conditions.map((line) => h("li", { html: MD.inline(line) }))) : null,
        kp.card.datasets?.length ? h("div", { class: "datasets" }, ...kp.card.datasets.map(forms.dataset).filter(Boolean)) : null,
        kp.card.example ? prose(kp.card.example) : null,
        h("details", { class: "kp-more" }, h("summary", {}, h("span", { class: "chev", html: chevron }), "讲解"), prose(kp.lesson)),
        relation("这里用到", kp.links),
        relation("用到它的", kp.usedBy))),
      p.hidden ? h("p", { class: "kpage-hidden" }, `还有 ${p.hidden} 个知识点没有通过`) : null,
      p.wrapup ? h("section", { class: "kp-wrap" }, prose(p.wrapup)) : null);
    main.replaceChildren(article);
    main.scrollTop = 0;
    if (narrow()) scrollTo(0, 0);
    // The first knowledge point sits under the topic's name: open at the top so the name is seen.
    if (anchor && anchor !== topicId && anchor !== p.kps[0]?.id) main.querySelector(`[id="${anchor}"]`)?.scrollIntoView({ block: "start" });
    spy?.disconnect();
    const sections = [...article.querySelectorAll(".kp-sec")];
    spy = new IntersectionObserver(() => {
      // The section whose start has reached the top of the reading area is the one being read.
      const line = (narrow() ? 0 : main.getBoundingClientRect().top) + 72;
      const seen = sections.filter((sec) => sec.getBoundingClientRect().top <= line).pop() ?? sections[0];
      if (seen && selected !== seen.id && model.lib.topicOf(seen.id) === topicId) {
        selected = seen.id;
        tree.querySelectorAll('[aria-selected="true"]').forEach((n) => n.setAttribute("aria-selected", "false"));
        tree.querySelector(`[data-node="${selected}"]`)?.setAttribute("aria-selected", "true");
      }
    }, { root: narrow() ? null : main, rootMargin: "0px 0px -70% 0px" });
    // After the jump has landed, so arriving at a knowledge point does not reselect whatever scrolled past.
    requestAnimationFrame(() => requestAnimationFrame(() => article.querySelectorAll(".kp-sec").forEach((sec) => spy.observe(sec))));
  }

  // ---- relations: one hop, beside the page

  const TABS = [["k", "页面"], ["map", "全图"], ["tower", "塔"]];
  function renderRail(topicId, view) {
    tabsBox.replaceChildren(...TABS.map(([key, label]) => h("a", { role: "tab", href: key === "tower" ? `#/tower/${topicId ?? ""}` : `#/${key}/${topicId ?? ""}`, ariaSelected: String(view === key) }, label)));
    (narrow() ? phoneBar : side).prepend(tabsBox);
    if (!topicId) { rail.replaceChildren(); return; }
    const t = model.lib.topics().find((x) => x.id === topicId);
    const link = (id) => {
      const other = model.lib.topics().find((x) => x.id === id);
      const body = [tileIcon(model.lib.topicEntry(id), 20), h("span", {}, phrase(other.title))];
      return other.readable
        ? h("a", { class: "stack-row", href: `#/${view === "k" ? "k" : view}/${id}`, dataTopicPeek: id, onpointerenter: () => main.querySelector(`[data-node-id="${id}"]`)?.setAttribute("data-hot", ""), onpointerleave: () => main.querySelector(`[data-node-id="${id}"]`)?.removeAttribute("data-hot") }, ...body)
        : h("span", { class: "stack-row stack-off", title: "还没学" }, ...body);
    };
    const before = model.lib.prereq(topicId), after = model.lib.successors(topicId);
    rail.replaceChildren(h("div", { class: "stack" },
      before.length ? h("p", { class: "stack-label" }, "要先会") : null,
      ...before.map(link),
      h("div", { class: "stack-row stack-here" }, tileIcon(model.lib.topicEntry(topicId), 20), h("span", {}, phrase(t.title)), view !== "k" && t.readable ? h("a", { class: "stack-open", href: `#/k/${topicId}` }, "打开") : null),
      after.length ? h("p", { class: "stack-label" }, "后面用到") : null,
      ...after.map(link)));
  }

  // ---- the whole course: prerequisites run down the page on a lattice

  let lattice = null;
  function layout() {
    if (lattice) return lattice;
    const topics = model.lib.topics();
    const ids = new Set(topics.map((t) => t.id));
    const depth = new Map();
    const depthOf = (id) => {
      if (depth.has(id)) return depth.get(id);
      const d = Math.max(-1, ...model.lib.prereq(id).filter((p) => ids.has(p)).map(depthOf)) + 1;
      depth.set(id, d);
      return d;
    };
    topics.forEach((t) => depthOf(t.id));
    const COLS = 9;
    const col = new Map();
    const rows = [];
    topics.forEach((t) => { (rows[depth.get(t.id)] ??= []).push(t.id); });
    rows.forEach((row) => {
      const wish = (id) => { const ps = model.lib.prereq(id).filter((p) => col.has(p)); return ps.length ? ps.reduce((a, p) => a + col.get(p), 0) / ps.length : (COLS - 1) / 2; };
      const taken = new Set();
      [...row].sort((a, b) => wish(a) - wish(b)).forEach((id) => {
        let best = 0, far = Infinity;
        for (let c = 0; c < COLS; c += 1) { if (!taken.has(c) && Math.abs(c - wish(id)) < far) { far = Math.abs(c - wish(id)); best = c; } }
        taken.add(best); col.set(id, best);
      });
    });
    lattice = { depth, col, COLS, rows: rows.length };
    return lattice;
  }

  function renderMap(focus) {
    const { depth, col, COLS, rows } = layout();
    const room = main.clientWidth || 640;
    const CW = Math.min(76, Math.floor(room / COLS));
    const TILE = CW < 56 ? 24 : 32, RH = TILE + (CW < 56 ? 28 : 40), PAD = 8;
    const width = COLS * CW, height = rows * RH + PAD;
    const x = (id) => col.get(id) * CW + (CW - TILE) / 2, y = (id) => depth.get(id) * RH + PAD;
    const svg = window.Tile.element("svg", { class: "map-edges", width, height, "aria-hidden": "true" });
    const R = 8;
    const route = (a, b) => {
      const x1 = x(a) + TILE / 2, y1 = y(a) + TILE, x2 = x(b) + TILE / 2, y2 = y(b);
      const turn = y2 - (RH - TILE) / 2;
      const corner = (fromX, atY, toX) => { const d = Math.sign(toX - fromX); return d === 0 ? `V${atY}` : `V${atY - R}Q${fromX} ${atY} ${fromX + d * R} ${atY}H${toX - d * R}Q${toX} ${atY} ${toX} ${atY + R}`; };
      if (depth.get(b) === depth.get(a) + 1) return `M${x1} ${y1}${corner(x1, turn, x2)}V${y2}`;
      // Long edges leave by the lane beside their own column, so they never run through a tile.
      const lane = x1 + (x2 >= x1 ? CW / 2 : -CW / 2);
      const out = y1 + (RH - TILE) / 2;
      return `M${x1} ${y1}${corner(x1, out, lane)}${corner(lane, turn, x2)}V${y2}`;
    };
    const lit = (a, b) => (a === focus ? "after" : b === focus ? "before" : null);
    const topics = model.lib.topics();
    const edges = [];
    for (const t of topics) for (const p of model.lib.prereq(t.id)) edges.push([p, t.id]);
    edges.sort((a, b) => Boolean(lit(...a)) - Boolean(lit(...b)));
    edges.forEach(([a, b]) => window.Tile.element("path", { class: "map-edge", d: route(a, b), "data-lit": lit(a, b) ?? "" }, svg));
    const label = h("div", { class: "map-label", hidden: true });
    const stage = h("div", { class: "map", style: `width:${width}px;height:${height}px` }, svg);
    const taken = new Map();
    const under = new Map();
    topics.forEach((t) => { const d = depth.get(t.id); if (!taken.has(d)) taken.set(d, []); taken.get(d).push(col.get(t.id)); });
    /** A name beside its tile, in the free room on that row: to the right if there is room, otherwise to the left. */
    const placeName = (node, id) => {
      const here = col.get(id), row = taken.get(depth.get(id));
      const next = Math.min(COLS, ...row.filter((c) => c > here)), prev = Math.max(-1, ...row.filter((c) => c < here));
      const right = (next - here) * CW - TILE - 10, left = (here - prev) * CW - TILE - 10;
      const onRight = right >= left || right >= 112;
      // A row too crowded for a name beside the tile: under it, in the gap between rows.
      if (Math.max(right, left) < 112) {
        node.dataset.under = "1";
        // Two names under one row take a line each, so they never run together.
        const line = node.classList.contains("map-near") ? under.get(depth.get(id)) ?? 0 : 0;
        if (node.classList.contains("map-near")) under.set(depth.get(id), line + 1);
        node.style.top = `${y(id) + TILE + 1 + line * 20}px`;
        node.style.left = `${Math.max(112, Math.min(width - 112, x(id) + TILE / 2))}px`;
        node.style.right = "auto";
        node.style.maxWidth = "224px";
        return;
      }
      node.dataset.under = "";
      node.style.top = `${y(id) + TILE / 2 - 10}px`;
      node.style.maxWidth = `${onRight ? right : left}px`;
      node.style.left = onRight ? `${x(id) + TILE + 6}px` : "auto";
      node.style.right = onRight ? "auto" : `${width - x(id) + 6}px`;
    };
    const showLabel = (id) => {
      const t = topics.find((x2) => x2.id === id);
      label.textContent = t.title;
      label.hidden = false;
      placeName(label, id);
      label.dataset.main = id === focus ? "1" : "";
    };
    // The ends of the lit edges are named: following a branch should not mean remembering each tile.
    if (focus && !narrow()) {
      for (const id of [...model.lib.prereq(focus), ...model.lib.successors(focus)]) {
        const near = h("div", { class: "map-near" }, topics.find((x2) => x2.id === id).title);
        placeName(near, id);
        stage.append(near);
      }
    }
    for (const t of topics) {
      const entry = model.lib.topicEntry(t.id);
      const node = h("a", { class: "map-node", href: `#/map/${t.id}`, dataNodeId: t.id, onclick: () => { railOnSelect = narrow(); }, style: `left:${x(t.id)}px;top:${y(t.id)}px`, dataOff: t.readable ? null : "1", ariaCurrent: t.id === focus ? "true" : null, ariaLabel: `${t.title}，${t.learned ? "已学" : t.readable ? "正在学" : "还没学"}`,
        onpointerenter: () => showLabel(t.id), onpointerleave: () => { if (focus) showLabel(focus); else label.hidden = true; }, onfocus: () => showLabel(t.id),
        ondblclick: (e) => { e.preventDefault(); if (t.readable) location.hash = `#/k/${t.id}`; },
        onkeydown: (e) => { if (e.key === "Enter" && t.id === focus && t.readable) { e.preventDefault(); location.hash = `#/k/${t.id}`; } } }, tileIcon(entry, TILE));
      if (t.id === focus) node.append(window.Tile.element("svg", { class: "map-frame", viewBox: "0 0 44 44", width: 44, height: 44, "aria-hidden": "true" }));
      stage.append(node);
    }
    stage.append(label);
    if (focus) showLabel(focus);
    main.replaceChildren(h("h1", { class: "sr" }, "全图"), h("div", { class: "map-wrap" }, stage));
    if (focus && !narrow()) { const spot = stage.querySelector('[aria-current="true"]'); const box = main.getBoundingClientRect(); const r = spot.getBoundingClientRect(); if (r.top < box.top || r.bottom > box.bottom) main.scrollTop += r.top - box.top - box.height / 2; }
  }

  function renderTower() {
    const wrap = h("div", { class: "tower-view" });
    main.replaceChildren(h("h1", { class: "sr" }, "塔"), wrap);
    window.paints.tower.mount(wrap);
    window.paints.tower.update(wrap, { progress: model.view().progress.map((e) => ({ ...e, state: e.passed ? "done" : e.current ? "current" : e.attempts ? "tried" : "untouched", retention: e.memory })), stage: "explanation" });
    towerOn = wrap;
  }

  function render(route) {
    const { name, arg } = route;
    let topicId = arg ? (arg.includes(".") ? model.lib.topicOf(arg) : arg) : null;
    const topics = model.lib.topics();
    if (!topics.some((t) => t.id === topicId)) topicId = null;
    if (!topicId || (name === "k" && !topics.find((t) => t.id === topicId)?.readable)) {
      const inTask = topics.find((t) => t.inTask);
      const last = [...topics].reverse().find((t) => t.readable);
      topicId = (name === "k" ? (inTask ?? last)?.id : (topicId ?? inTask?.id ?? last?.id)) ?? null;
    }
    selected = arg && arg.includes(".") && topicId === model.lib.topicOf(arg) ? arg : topicId;
    roving = selected;
    if (topicId) expanded.add(topicId);
    if (!topics.some((t) => t.readable)) expanded.add(FUTURE);
    if (towerOn) { window.paints.tower.unmount(towerOn); towerOn = false; }
    const key = `${name}:${topicId}`;
    const samePage = key === mainKey && name === "k";
    mainKey = key;
    root.dataset.sheet = railOnSelect ? "rail" : "";
    railOnSelect = false;
    renderTree();
    renderRail(topicId, name);
    main.dataset.view = name;
    if (name === "k") {
      if (samePage && arg?.includes(".")) main.querySelector(`[id="${arg}"]`)?.scrollIntoView({ block: "start" });
      else if (!samePage) renderPage(topicId, arg);
    } else { spy?.disconnect(); if (name === "map") renderMap(topicId); else renderTower(); }
    requestAnimationFrame(reveal);
    return topicId;
  }

  return { render, invalidate: () => { mainKey = null; } };
};
