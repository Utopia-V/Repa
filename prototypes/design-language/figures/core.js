// A figure draws the whole course from one array of KP states. Figures never know about pages or themes.
window.Figures = {};
window.FigureKit = (() => {
  /** Resolves a CSS custom property, including light-dark(), to a concrete colour. */
  function color(el, name, fallback = "#888") {
    const probe = document.createElement("span");
    probe.style.color = `var(${name}, ${fallback})`;
    probe.style.display = "none";
    el.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }
  const palette = (el) => ({
    ink: color(el, "--ink", "#1e2024"), paper: color(el, "--paper", "#f7f8f9"), blue: color(el, "--blue", "#396d92"),
    hair: color(el, "--hair", "#d9dfe5"), faint: color(el, "--faint", "#656b73"), sting: color(el, "--sting", "#c8321f"),
    columns: Number(getComputedStyle(el).getPropertyValue("--figure-columns")) || 10,
  });
  const alpha = (rgb, a) => rgb.replace(/^rgb\(([^)]+)\)$/, `rgba($1, ${a})`);

  /** How much a KP has been established, 0..1. The one mapping every figure shares. */
  const level = (entry) => {
    if (entry.state === "done") return 0.35 + 0.65 * (entry.retention ?? 1);
    if (entry.state === "current") return 0.3;
    if (entry.state === "tried") return 0.2;
    return 0;
  };

  /** A canvas that keeps itself the size of its parent; calls draw(ctx, w, h) on resize. */
  function canvasIn(el, draw) {
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "display:block;width:100%;height:100%";
    el.replaceChildren(canvas);
    const ctx = canvas.getContext("2d");
    let width = 0, height = 0;
    const size = () => {
      const box = el.getBoundingClientRect();
      width = box.width; height = box.height;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      paint();
    };
    const paint = () => { if (width && height) draw(ctx, width, height); };
    const observer = new ResizeObserver(size);
    observer.observe(el);
    size();
    return { canvas, ctx, paint, stop: () => observer.disconnect() };
  }

  /** Fits a set of points into a box, returning a mapper. */
  function fitter(points, width, height, pad = 8) {
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const scale = Math.min((width - pad * 2) / (maxX - minX || 1), (height - pad * 2) / (maxY - minY || 1));
    const ox = (width - (maxX - minX) * scale) / 2 - minX * scale;
    const oy = (height - (maxY - minY) * scale) / 2 - minY * scale;
    return { scale, x: (x) => x * scale + ox, y: (y) => y * scale + oy };
  }

  /** Drag to rotate; turns slowly on its own unless the person asked for less motion. Only runs while on screen. */
  function spinner(el, canvas, redraw, { yaw = 0.5, pitch = 0.35, speed = 0.004 } = {}) {
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const view = { yaw, pitch };
    let dragging = false, lastX = 0, lastY = 0, frame = 0, visible = true;
    const down = (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId); };
    const move = (e) => {
      if (!dragging) return;
      view.yaw += (e.clientX - lastX) * 0.008;
      view.pitch += (e.clientY - lastY) * 0.008;
      lastX = e.clientX; lastY = e.clientY;
      redraw();
    };
    const up = () => { dragging = false; };
    canvas.style.touchAction = "none";
    canvas.style.cursor = "grab";
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    const seen = new IntersectionObserver((list) => { visible = list[0].isIntersecting; });
    seen.observe(el);
    const tick = () => {
      if (!calm && !dragging && visible && !window.FigureKit.frozen) { view.yaw += speed; redraw(); }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return { view, stop: () => { cancelAnimationFrame(frame); seen.disconnect(); } };
  }

  /** Rotate by yaw and pitch, then a simple perspective. */
  function project([x, y, z], view, width, height, { scale = 1, camera = 5, cx = 0.5, cy = 0.5 } = {}) {
    const cosY = Math.cos(view.yaw), sinY = Math.sin(view.yaw);
    const rx = x * cosY + z * sinY, rz = -x * sinY + z * cosY;
    const cosP = Math.cos(view.pitch), sinP = Math.sin(view.pitch);
    const py = y * cosP - rz * sinP, pz = y * sinP + rz * cosP;
    const fit = Math.min(width, height) * 0.5 * scale * camera / (camera + pz);
    return { x: width * cx + rx * fit, y: height * cy - py * fit, z: pz };
  }

  /** The grid-of-tiles layout most flat figures share. */
  const gridOf = (count, columns = 10) => ({ columns, rows: Math.ceil(count / columns) });

  return { color, palette, alpha, level, canvasIn, fitter, spinner, project, gridOf, frozen: false };
})();

/** Registers a figure drawn by one pure function of the entries; redraws on update. */
window.staticFigure = (name, meta, draw) => {
  window.Figures[name] = {
    ...meta,
    mount(el) {
      let entries = [];
      const colors = () => window.FigureKit.palette(el);
      const surface = window.FigureKit.canvasIn(el, (ctx, w, h) => { ctx.clearRect(0, 0, w, h); if (entries.length) draw(ctx, w, h, entries, colors()); });
      return { update(next) { entries = next; surface.paint(); }, stop: surface.stop };
    },
  };
};

/** A figure that turns: draw(ctx, w, h, entries, colors, view). */
window.spinningFigure = (name, meta, draw, options) => {
  window.Figures[name] = {
    ...meta,
    mount(el) {
      let entries = [];
      const colors = () => window.FigureKit.palette(el);
      let spin;
      const surface = window.FigureKit.canvasIn(el, (ctx, w, h) => { ctx.clearRect(0, 0, w, h); if (entries.length && spin) draw(ctx, w, h, entries, colors(), spin.view); });
      spin = window.FigureKit.spinner(el, surface.canvas, surface.paint, options);
      return { update(next) { entries = next; surface.paint(); }, stop() { spin.stop(); surface.stop(); } };
    },
  };
};
