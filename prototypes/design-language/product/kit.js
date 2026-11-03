// Small helpers every view shares.
window.h = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (/^(aria|data)[A-Z]/.test(key)) node.setAttribute(key.replace(/^(aria|data)([A-Z])/, (m, a, c) => `${a}-${c.toLowerCase()}`).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), value);
    else if (["role", "for", "name", "type", "id", "style", "href", "tabindex", "inputmode", "autocomplete", "placeholder", "title"].includes(key)) node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
};

const segmenter = window.Intl?.Segmenter ? new Intl.Segmenter("zh", { granularity: "word" }) : null;
/** A name that breaks only between words. CSS keep-all forbids the rest. */
window.phrase = (text) => {
  if (!segmenter) return document.createTextNode(text);
  const box = document.createElement("span");
  box.className = "phrase";
  for (const { segment } of segmenter.segment(text)) box.append(segment, document.createElement("wbr"));
  return box;
};

/** The tile as a list icon. Dot, thread and ribbon stay readable at this size; the shade is a hint, not the message. */
window.tileIcon = (entry, size = 16) => {
  const svg = window.Tile.element("svg", { viewBox: `0 0 ${size} ${size}`, class: "tile-icon", width: size, height: size, "aria-hidden": "true" });
  window.Tile.draw(svg, 0, 0, size, entry.index ?? 0, { ...entry, kp: { id: entry.id } });
  return svg;
};

window.onKeyboard = () => document.documentElement.dataset.input === "key";
addEventListener("keydown", () => { document.documentElement.dataset.input = "key"; }, true);
addEventListener("pointerdown", () => { document.documentElement.dataset.input = "pointer"; }, true);
