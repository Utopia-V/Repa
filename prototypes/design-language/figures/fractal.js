// Recursive and space-filling figures: complexity from one rule applied again.
(() => {
  const { alpha, level, fitter } = window.FigureKit;

  /** One KP is one segment of a line. Learning thickens the line; nothing else moves. */
  function drawPath(ctx, entries, colors, points, map, widthFor) {
    ctx.lineCap = "square";
    ctx.lineJoin = "miter";
    ctx.strokeStyle = colors.hair;
    ctx.lineWidth = 1;
    ctx.beginPath();
    points.forEach((p, i) => { if (i === 0) ctx.moveTo(map.x(p[0]), map.y(p[1])); else ctx.lineTo(map.x(p[0]), map.y(p[1])); });
    ctx.stroke();
    entries.forEach((entry, i) => {
      const a = points[i], b = points[i + 1];
      if (!b || entry.state === "untouched") return;
      ctx.strokeStyle = entry.state === "done" ? alpha(colors.blue, level(entry)) : colors.blue;
      ctx.lineWidth = entry.state === "done" ? widthFor : 1.5;
      ctx.beginPath();
      ctx.moveTo(map.x(a[0]), map.y(a[1]));
      ctx.lineTo(map.x(b[0]), map.y(b[1]));
      ctx.stroke();
    });
    const at = entries.findIndex((entry) => entry.state === "current");
    if (at >= 0 && points[at]) {
      ctx.fillStyle = colors.ink;
      ctx.fillRect(map.x(points[at][0]) - 4, map.y(points[at][1]) - 4, 8, 8);
    }
  }

  /** The paperfolding sequence: fold a strip in half again and again, then open every fold to 90°. */
  function dragon(count) {
    const points = [[0, 0]];
    let dir = 0;
    const steps = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    for (let n = 1; n <= count; n += 1) {
      const [dx, dy] = steps[dir];
      const [x, y] = points[points.length - 1];
      points.push([x + dx, y + dy]);
      const turnLeft = (((n & -n) << 1) & n) !== 0;
      dir = (dir + (turnLeft ? 3 : 1)) % 4;
    }
    return points;
  }
  window.staticFigure("dragon", { name: "龙形曲线", group: "分形" }, (ctx, w, h, entries, colors) => {
    const points = dragon(entries.length);
    const map = fitter(points, w, h, 12);
    drawPath(ctx, entries, colors, points, map, Math.max(2, map.scale * 0.5));
  });

  /** A generalised Hilbert curve (Červený's gilbert) that fills any rectangle exactly once. */
  function gilbert(width, height) {
    const out = [];
    const sgn = (v) => Math.sign(v);
    const step = (x, y, ax, ay, bx, by) => {
      const w = Math.abs(ax + ay), h = Math.abs(bx + by);
      const dax = sgn(ax), day = sgn(ay), dbx = sgn(bx), dby = sgn(by);
      if (h === 1) { for (let i = 0; i < w; i += 1) { out.push([x, y]); x += dax; y += day; } return; }
      if (w === 1) { for (let i = 0; i < h; i += 1) { out.push([x, y]); x += dbx; y += dby; } return; }
      let ax2 = Math.floor(ax / 2), ay2 = Math.floor(ay / 2), bx2 = Math.floor(bx / 2), by2 = Math.floor(by / 2);
      const w2 = Math.abs(ax2 + ay2), h2 = Math.abs(bx2 + by2);
      if (2 * w > 3 * h) {
        if (w2 % 2 && w > 2) { ax2 += dax; ay2 += day; }
        step(x, y, ax2, ay2, bx, by);
        step(x + ax2, y + ay2, ax - ax2, ay - ay2, bx, by);
      } else {
        if (h2 % 2 && h > 2) { bx2 += dbx; by2 += dby; }
        step(x, y, bx2, by2, ax2, ay2);
        step(x + bx2, y + by2, ax, ay, bx - bx2, by - by2);
        step(x + (ax - dax) + (bx2 - dbx), y + (ay - day) + (by2 - dby), -bx2, -by2, -(ax - ax2), -(ay - ay2));
      }
    };
    if (width >= height) step(0, 0, width, 0, 0, height); else step(0, 0, 0, height, width, 0);
    return out;
  }
  window.staticFigure("hilbert", { name: "希尔伯特路径", group: "分形" }, (ctx, w, h, entries, colors) => {
    const points = gilbert(10, Math.ceil(entries.length / 10));
    const map = fitter(points, w, h, 14);
    drawPath(ctx, entries, colors, points, map, Math.max(2, map.scale * 0.45));
  });

  /** Squares on squares: each square raises two more, so the course grows as a tree. */
  window.staticFigure("pythagoras", { name: "毕达哥拉斯树", group: "分形" }, (ctx, w, h, entries, colors) => {
    const angle = (40 * Math.PI) / 180;
    const squares = [];
    let level0 = [{ x: 0, y: 0, ux: 1, uy: 0 }];
    while (squares.length < entries.length) {
      const next = [];
      for (const s of level0) {
        const vx = -s.uy, vy = s.ux;
        squares.push([[s.x, s.y], [s.x + s.ux, s.y + s.uy], [s.x + s.ux + vx, s.y + s.uy + vy], [s.x + vx, s.y + vy]]);
        const c = Math.cos(angle), n = Math.sin(angle);
        const lx = (s.ux * c + vx * n) * c, ly = (s.uy * c + vy * n) * c;
        next.push({ x: s.x + vx, y: s.y + vy, ux: lx, uy: ly });
        const rx = s.x + vx + lx, ry = s.y + vy + ly;
        const ex = s.x + s.ux + vx - rx, ey = s.y + s.uy + vy - ry;
        next.push({ x: rx, y: ry, ux: ex, uy: ey });
      }
      level0 = next;
    }
    const used = squares.slice(0, entries.length);
    const map = fitter(used.flat().map(([x, y]) => [x, -y]), w, h, 10);
    used.forEach((square, i) => {
      const entry = entries[i];
      ctx.beginPath();
      square.forEach(([x, y], j) => { const px = map.x(x), py = map.y(-y); if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
      ctx.closePath();
      if (entry.state === "done") { ctx.fillStyle = alpha(colors.blue, level(entry)); ctx.fill(); }
      else {
        ctx.strokeStyle = entry.state === "untouched" ? colors.hair : colors.blue;
        ctx.lineWidth = entry.state === "current" ? 2 : 1;
        ctx.stroke();
      }
    });
  });

  /** Mutually tangent circles: every gap holds the next circle. The opening KPs are the largest. */
  function gasket(count) {
    const r = 2 * Math.sqrt(3) - 3;
    const start = [{ k: -1, x: 0, y: 0 }];
    for (let i = 0; i < 3; i += 1) {
      const t = (i * 2 * Math.PI) / 3 - Math.PI / 2;
      start.push({ k: 1 / r, x: (1 - r) * Math.cos(t), y: (1 - r) * Math.sin(t) });
    }
    const circles = start.slice(1);
    const other = (a, b, c, d) => {
      const k = 2 * (a.k + b.k + c.k) - d.k;
      const kx = 2 * (a.k * a.x + b.k * b.x + c.k * c.x) - d.k * d.x;
      const ky = 2 * (a.k * a.y + b.k * b.y + c.k * c.y) - d.k * d.y;
      return { k, x: kx / k, y: ky / k };
    };
    const queue = [];
    const push = (a, b, c, d) => queue.push({ a, b, c, d, circle: other(a, b, c, d) });
    const [o, p, q, s] = start;
    push(o, p, q, s); push(o, p, s, q); push(o, q, s, p); push(p, q, s, o);
    while (circles.length < count && queue.length) {
      queue.sort((m, n) => m.circle.k - n.circle.k);
      const { a, b, c, circle: e } = queue.shift();
      circles.push(e);
      push(a, b, e, c); push(a, c, e, b); push(b, c, e, a);
    }
    return circles;
  }
  window.staticFigure("apollonian", { name: "阿波罗尼奥斯垫片", group: "分形" }, (ctx, w, h, entries, colors) => {
    const circles = gasket(entries.length);
    const radius = Math.min(w, h) / 2 - 6, cx = w / 2, cy = h / 2;
    ctx.strokeStyle = colors.ink;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    circles.forEach((c, i) => {
      const entry = entries[i];
      if (!entry) return;
      ctx.beginPath();
      ctx.arc(cx + c.x * radius, cy + c.y * radius, Math.abs(1 / c.k) * radius - 0.5, 0, Math.PI * 2);
      if (entry.state === "done") { ctx.fillStyle = alpha(colors.blue, level(entry)); ctx.fill(); }
      else {
        ctx.strokeStyle = entry.state === "untouched" ? colors.hair : colors.blue;
        ctx.lineWidth = entry.state === "current" ? 2 : 1;
        ctx.stroke();
      }
    });
  });

  /** Course, topic, KP: the page split in two again and again, a Mondrian that is really a table of contents. */
  window.staticFigure("partition", { name: "递归分割", group: "分形" }, (ctx, w, h, entries, colors) => {
    const topics = [];
    entries.forEach((entry) => {
      const last = topics[topics.length - 1];
      if (last && last.topic.id === entry.topic.id) last.items.push(entry); else topics.push({ topic: entry.topic, items: [entry] });
    });
    const split = (list, x, y, width, height, leaf) => {
      if (list.length === 1) { leaf(list[0], x, y, width, height); return; }
      const total = list.reduce((sum, item) => sum + (item.items?.length ?? 1), 0);
      let acc = 0, cut = 0;
      while (cut < list.length - 1 && acc + (list[cut].items?.length ?? 1) <= total / 2) { acc += list[cut].items?.length ?? 1; cut += 1; }
      if (cut === 0) { acc = list[0].items?.length ?? 1; cut = 1; }
      const part = acc / total;
      if (width >= height) {
        split(list.slice(0, cut), x, y, width * part, height, leaf);
        split(list.slice(cut), x + width * part, y, width * (1 - part), height, leaf);
      } else {
        split(list.slice(0, cut), x, y, width, height * part, leaf);
        split(list.slice(cut), x, y + height * part, width, height * (1 - part), leaf);
      }
    };
    const pad = 4;
    split(topics, pad, pad, w - pad * 2, h - pad * 2, (group, x, y, width, height) => {
      split(group.items, x, y, width, height, (entry, ex, ey, ew, eh) => {
        if (entry.state === "done") { ctx.fillStyle = alpha(colors.blue, level(entry)); ctx.fillRect(ex, ey, ew, eh); }
        else if (entry.state !== "untouched") { ctx.fillStyle = alpha(colors.blue, 0.18); ctx.fillRect(ex, ey, ew, eh); }
        ctx.strokeStyle = entry.state === "current" ? colors.ink : colors.hair;
        ctx.lineWidth = entry.state === "current" ? 2 : 1;
        ctx.strokeRect(ex + 0.5, ey + 0.5, ew - 1, eh - 1);
      });
      ctx.strokeStyle = colors.ink;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(x, y, width, height);
    });
  });
})();
