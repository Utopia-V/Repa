// The one module of the language: a square tile holding two quarter arcs. Every figure in Repa is this tile repeated, and a tile's look is a KP's state.
window.Tile = (() => {
  const NS = "http://www.w3.org/2000/svg";

  const element = (name, attributes, parent) => {
    const node = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    parent?.append(node);
    return node;
  };

  /** A tile keeps its orientation for as long as the KP keeps its id, so inserting a KP elsewhere moves nothing. */
  const flipped = (key) => {
    let h = 2166136261;
    for (const c of String(key)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    h ^= h >>> 15;
    h = Math.imul(h, 2246822519) >>> 0;
    h ^= h >>> 13;
    return ((h >>> 9) & 1) === 1;
  };

  /** Arcs join side midpoints, so neighbouring tiles always connect; each runs a hair past its edge so no seam shows at the join. */
  const LAP = 0.4;
  function arcs(size, index) {
    const r = size / 2;
    return flipped(index)
      ? [`M${r} ${-LAP}V0A${r} ${r} 0 0 1 0 ${r}H${-LAP}`, `M${size + LAP} ${r}H${size}A${r} ${r} 0 0 0 ${r} ${size}V${size + LAP}`]
      : [`M${r} ${-LAP}V0A${r} ${r} 0 0 0 ${size} ${r}H${size + LAP}`, `M${-LAP} ${r}H0A${r} ${r} 0 0 1 ${r} ${size}V${size + LAP}`];
  }

  /**
   * Four independent facts, drawn independently:
   * history (ever attempted) gives a thread; qualification (passed) gives a ribbon and can be lost again on regrading;
   * memory (the student model's estimate, per topic) gives the ribbon's strength; selection (current) gives the frame.
   */
  function draw(parent, x, y, size, index, entry) {
    const key = entry.kp?.id ?? index;
    const passed = entry.passed ?? entry.state === "done";
    const attempts = entry.attempts ?? (entry.state === "tried" ? 1 : 0);
    const isCurrent = entry.current ?? entry.state === "current";
    const group = element("g", { class: "tile", transform: `translate(${x} ${y})`, "data-passed": String(passed), "data-index": index }, parent);
    element("rect", { class: "tile-hit", width: size, height: size }, group);
    const [first, second] = arcs(size, key);
    if (passed) {
      for (const d of [first, second]) element("path", { class: "tile-ribbon", d, "stroke-width": size * 0.3, style: `--memory:${Math.round((0.3 + 0.7 * (entry.memory ?? entry.retention ?? 1)) * 100)}%` }, group);
    } else if (attempts > 0) {
      for (const d of attempts >= 2 ? [first, second] : [first]) element("path", { class: "tile-thread", d }, group);
    } else {
      element("circle", { class: "tile-dot", cx: size / 2, cy: size / 2, r: Math.max(1, size * 0.045) }, group);
    }
    if (isCurrent) element("rect", { class: "tile-frame", x: 0.75, y: 0.75, width: size - 1.5, height: size - 1.5 }, group);
    if (entry.missed) element("path", { class: "tile-miss", d: `M0 ${size * 0.2}L${size * 0.86} ${size / 2}L0 ${size * 0.8}Z` }, group);
    return group;
  }

  /** A row-major field of tiles; returns the svg. */
  function field(progress, columns, size, offset = 0) {
    const rows = Math.ceil(progress.length / columns);
    const svg = element("svg", { viewBox: `0 0 ${columns * size} ${rows * size}`, preserveAspectRatio: "xMinYMin meet", class: "tile-field" });
    progress.forEach((entry, index) => {
      const group = draw(svg, (index % columns) * size, Math.floor(index / columns) * size, size, index + offset, entry);
      const words = entry.passed ? ((entry.memory ?? 1) < 0.45 ? "已通过，记忆较弱" : "已通过") : entry.current ? "正在学" : entry.attempts ? "作答过" : "没有作答";
      element("title", {}, group).textContent = `${entry.topic.title}，${words}`;
    });
    return svg;
  }

  return { element, draw, field };
})();

/** Stands in for the student model: every KP's state, day one or a simulated later day. */
window.simulateProgress = ({ later = false, attempts = 0, missed = false, at } = {}) => {
  const kps = window.COURSE.flatMap((topic) => topic.items.map((kp) => ({ topic, kp })));
  const current = at ?? (later ? 71 : 0);
  // The student model estimates memory per topic, so the KPs of one topic fade together.
  const fade = (topic, index) => {
    let h = Math.imul(window.COURSE.indexOf(topic) + 7, 2654435761) >>> 0;
    h ^= h >>> 13;
    const first = kps.findIndex((k) => k.topic === topic);
    const age = (current - first) / Math.max(1, current);
    return Math.max(0, Math.min(1, 1.05 - age * 0.7 - ((h >>> 8) & 255) / 255 * 0.5));
  };
  return kps.map(({ topic, kp }, index) => {
    if (index < current) { const memory = fade(topic, index); return { topic, kp, state: "done", passed: true, retention: memory, memory }; }
    if (index === current) return { topic, kp, state: "current", current: true, attempts: attempts + (later ? 2 : 0), missed };
    if ((later || at) && index < current + 3) return { topic, kp, state: "tried", attempts: index === current + 1 ? 2 : 1 };
    return { topic, kp, state: "untouched", attempts: 0 };
  });
};
