// Other modules on the same grid: nested squares, the Chinese meander, movable type, halftone, text mode.
(() => {
  const { alpha, level, color } = window.FigureKit;
  const cell = (index, columns, size, ox = 0, oy = 0) => [ox + (index % columns) * size, oy + Math.floor(index / columns) * size];
  const fitGrid = (w, h, count, columns = 10) => {
    const rows = Math.ceil(count / columns), size = Math.floor(Math.min(w / columns, h / rows));
    return { size, columns, rows, ox: (w - columns * size) / 2, oy: (h - rows * size) / 2 };
  };

  /** Albers: evidence adds a nested square, sitting low as in his Homage. */
  window.staticFigure("albers", { name: "嵌套方格", group: "单元" }, (ctx, w, h, entries, colors) => {
    const { size, columns, ox, oy } = fitGrid(w, h, entries.length);
    entries.forEach((entry, i) => {
      const [x, y] = cell(i, columns, size, ox, oy);
      const depth = entry.state === "done" ? 4 : entry.state === "current" ? 2 + (entry.attempts ?? 0) : entry.state === "tried" ? 2 : 0;
      ctx.fillStyle = depth ? alpha(colors.blue, 0.14) : alpha(colors.faint, 0.09);
      ctx.fillRect(x + 1, y + 1, size - 2, size - 2);
      for (let d = 1; d < depth; d += 1) {
        const inset = (size * d) / 10;
        ctx.fillStyle = alpha(colors.blue, entry.state === "done" ? (0.2 + d * 0.22) * level(entry) : 0.25);
        ctx.fillRect(x + inset, y + inset * 1.5, size - inset * 2, size - inset * 2);
      }
      if (entry.state === "current") { ctx.strokeStyle = colors.ink; ctx.lineWidth = 1.5; ctx.strokeRect(x + 0.75, y + 0.75, size - 1.5, size - 1.5); }
    });
  });

  /** 回纹: a square spiral that enters and leaves on one line, so a row of tiles is one unbroken thread. */
  const SPIRAL = [[0, 8], [0, 1], [7, 1], [7, 6], [2, 6], [2, 3], [5, 3], [5, 4]];
  window.staticFigure("huiwen", { name: "回纹", group: "单元" }, (ctx, w, h, entries, colors) => {
    const { size, columns, ox, oy } = fitGrid(w, h, entries.length, colors.columns);
    const unit = size / 8;
    ctx.lineCap = "butt";
    ctx.lineJoin = "miter";
    entries.forEach((entry, i) => {
      const [x, y] = cell(i, columns, size, ox, oy);
      if (entry.state === "untouched") {
        ctx.fillStyle = alpha(colors.faint, 0.5);
        ctx.fillRect(x + size / 2 - 1, y + size / 2 - 1, 2, 2);
        return;
      }
      const flip = Math.floor(i / columns) % 2 === 1;
      ctx.beginPath();
      const points = entry.state === "done" ? SPIRAL : SPIRAL.slice(0, entry.state === "current" ? 3 + (entry.attempts ?? 0) : 3);
      points.forEach(([px, py], j) => {
        const fx = x + (flip ? 8 - px : px) * unit, fy = y + py * unit;
        if (j === 0) ctx.moveTo(fx, fy); else ctx.lineTo(fx, fy);
      });
      if (entry.state === "done") {
        // Tie into the next tile along the base line, so the thread does not break.
        ctx.moveTo(x + (flip ? 8 : 0) * unit, y + 8 * unit);
        ctx.lineTo(x + (flip ? 0 : 8) * unit, y + 8 * unit);
      }
      ctx.strokeStyle = entry.state === "done" ? alpha(colors.ink, level(entry)) : colors.blue;
      ctx.lineWidth = entry.state === "done" ? Math.max(1.5, unit * 0.62) : 1;
      ctx.stroke();
      if (entry.state === "current") { ctx.strokeStyle = colors.sting; ctx.lineWidth = 1.5; ctx.strokeRect(x + 0.75, y + 0.75, size - 1.5, size - 1.5); }
    });
  });

  /** 活字: every KP is the first character of its concept's name, a block of type. What you have learned is inked. */
  window.staticFigure("type", { name: "活字版", group: "单元" }, (ctx, w, h, entries, colors) => {
    const { size, columns, ox, oy } = fitGrid(w, h, entries.length);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${Math.round(size * 0.74)}px 'Noto Serif CJK SC', 'Songti SC', serif`;
    entries.forEach((entry, i) => {
      const [x, y] = cell(i, columns, size, ox, oy);
      const name = (entry.kp?.card?.name ?? entry.kp?.title ?? "·");
      const char = [...name].find((c) => /[一-鿿]/.test(c)) ?? [...name][0];
      if (entry.state === "current") {
        ctx.fillStyle = colors.ink;
        ctx.fillRect(x, y, size, size);
        ctx.fillStyle = colors.paper;
        ctx.fillText(char, x + size / 2, y + size / 2 + 1);
        return;
      }
      if (entry.state === "done") {
        ctx.fillStyle = alpha(colors.ink, level(entry));
        ctx.fillText(char, x + size / 2, y + size / 2 + 1);
        return;
      }
      ctx.strokeStyle = alpha(colors.faint, 0.45);
      ctx.lineWidth = 0.5;
      ctx.strokeText(char, x + size / 2, y + size / 2 + 1);
    });
  });

  /** Halftone in two spot inks, screens at different angles: memory is dot size, as in a riso print. */
  window.staticFigure("halftone", { name: "网点套印", group: "单元" }, (ctx, w, h, entries) => {
    const { size, columns, rows, ox, oy } = fitGrid(w, h, entries.length);
    const value = (px, py) => {
      const i = Math.floor((py - oy) / size) * columns + Math.floor((px - ox) / size);
      const inside = px >= ox && py >= oy && px < ox + columns * size && py < oy + rows * size;
      return inside && entries[i] ? level(entries[i]) : 0;
    };
    const screen = (ink, angle, pitch, shiftX, gain) => {
      ctx.fillStyle = ink;
      const c = Math.cos(angle), s = Math.sin(angle), R = Math.hypot(w, h);
      for (let u = -R; u < R; u += pitch) for (let v = -R; v < R; v += pitch) {
        const px = w / 2 + u * c - v * s + shiftX, py = h / 2 + u * s + v * c;
        if (px < 0 || py < 0 || px > w || py > h) continue;
        const amount = value(px - shiftX, py);
        ctx.beginPath();
        ctx.arc(px, py, Math.max(0.35, Math.sqrt(amount * gain) * pitch * 0.62), 0, Math.PI * 2);
        ctx.fill();
      }
    };
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    screen("#ff48b0", (75 * Math.PI) / 180, 5, 0, 0.7);
    screen("#0078bf", (15 * Math.PI) / 180, 5, 2, 1);
    ctx.restore();
  });

  /** 墨: a KP is a drop of ink on the paper; memory is how dense it stays. Breaks from the grid on purpose. */
  window.staticFigure("ink", { name: "墨点", group: "单元" }, (ctx, w, h, entries, colors) => {
    const { size, columns, ox, oy } = fitGrid(w, h, entries.length);
    entries.forEach((entry, i) => {
      let hash = Math.imul(i + 3, 2654435761) >>> 0;
      hash ^= hash >>> 13;
      const jx = (((hash >>> 3) & 255) / 255 - 0.5) * size * 0.5, jy = (((hash >>> 11) & 255) / 255 - 0.5) * size * 0.5;
      const [x, y] = cell(i, columns, size, ox, oy);
      const cx = x + size / 2 + jx, cy = y + size / 2 + jy, value = level(entry);
      if (!value) { ctx.fillStyle = alpha(colors.faint, 0.35); ctx.beginPath(); ctx.arc(cx, cy, 1, 0, Math.PI * 2); ctx.fill(); return; }
      const radius = size * (0.28 + 0.55 * value);
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      gradient.addColorStop(0, alpha(colors.ink, Math.min(1, value * 1.05)));
      gradient.addColorStop(0.55, alpha(colors.ink, value * 0.72));
      gradient.addColorStop(1, alpha(colors.ink, 0));
      ctx.fillStyle = gradient;
      ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill();
      if (entry.state === "current") { ctx.strokeStyle = colors.sting; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, cy, size * 0.42, 0, Math.PI * 2); ctx.stroke(); }
    });
  });

  /** 10 PRINT: the C64 one-liner, a maze from two characters. Unlearned positions are a dot. */
  window.staticFigure("tenprint", { name: "10 PRINT", group: "单元" }, (ctx, w, h, entries, colors) => {
    const { size, columns, ox, oy } = fitGrid(w, h, entries.length);
    ctx.lineCap = "square";
    entries.forEach((entry, i) => {
      const [x, y] = cell(i, columns, size, ox, oy);
      let hash = Math.imul(i + 1, 2654435761) >>> 0;
      hash ^= hash >>> 15;
      hash = Math.imul(hash, 2246822519) >>> 0;
      const flip = ((hash >>> 11) & 1) === 1;
      if (entry.state === "untouched") {
        ctx.fillStyle = alpha(colors.faint, 0.55);
        ctx.fillRect(x + size / 2 - 1, y + size / 2 - 1, 2, 2);
        return;
      }
      ctx.strokeStyle = entry.state === "done" ? alpha(colors.ink, level(entry)) : colors.blue;
      ctx.lineWidth = entry.state === "done" ? Math.max(2, size * 0.2) : 1.25;
      ctx.beginPath();
      ctx.moveTo(x + (flip ? size : 0), y);
      ctx.lineTo(x + (flip ? 0 : size), y + size);
      ctx.stroke();
    });
  });

  /** The Truchet weave of 复, drawn with the shared tile so it can stand on the same wall. */
  window.Figures.truchet = {
    name: "格纹（复）", group: "单元",
    mount(el) {
      return {
        update(entries) {
          el.replaceChildren(window.Tile.field(entries, 10, 32));
          const svg = el.firstElementChild;
          svg.style.cssText = "display:block;width:auto;height:100%;max-width:100%;margin:auto";
        },
        stop() {},
      };
    },
  };

  /** The tower from D, under the same mount. */
  window.Figures.tower = {
    name: "第三国际塔", group: "3D",
    mount(el) {
      // White on a dark plane in every scheme, as a blueprint is.
      el.style.background = "#14304a";
      window.paints.tower.mount(el);
      return { update(entries) { window.paints.tower.update(el, { progress: entries, stage: "explanation" }); }, stop() { window.paints.tower.unmount(el); } };
    },
  };
})();
