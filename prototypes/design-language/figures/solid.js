// Figures in three dimensions. Each turns slowly and can be dragged; each KP is one face, edge or stretch of band.
(() => {
  const { alpha, level, project } = window.FigureKit;

  /** The icosahedron cut into 120 triangles (a disdyakis triacontahedron), pushed out to a sphere. Exactly one face per KP in this course. */
  function faces120() {
    const t = (1 + Math.sqrt(5)) / 2;
    const raw = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
    const norm = ([x, y, z]) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; };
    const mid = (...ps) => norm(ps.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]));
    const v = raw.map(norm);
    const tris = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    const out = [];
    for (const [a, b, c] of tris) {
      const A = v[a], B = v[b], C = v[c], G = mid(A, B, C), AB = mid(A, B), BC = mid(B, C), CA = mid(C, A);
      out.push([A, AB, G], [AB, B, G], [B, BC, G], [BC, C, G], [C, CA, G], [CA, A, G]);
    }
    // Learned from the south pole upward, turning as it climbs.
    const key = (f) => { const c = mid(...f); return (c[1] + 1) * 8 + (Math.atan2(c[2], c[0]) + Math.PI) / (2 * Math.PI); };
    return out.sort((p, q) => key(p) - key(q));
  }
  const FACES = faces120();
  const faceEntry = (entries, i) => entries[Math.min(entries.length - 1, Math.floor((i * entries.length) / FACES.length))];

  window.spinningFigure("polyhedron", { name: "120 面体", group: "3D" }, (ctx, w, h, entries, colors, view) => {
    const drawn = FACES.map((face, i) => {
      const ps = face.map((p) => project(p, view, w, h, { scale: 0.92 }));
      const cross = (ps[1].x - ps[0].x) * (ps[2].y - ps[0].y) - (ps[1].y - ps[0].y) * (ps[2].x - ps[0].x);
      return { ps, cross, entry: faceEntry(entries, i), z: (ps[0].z + ps[1].z + ps[2].z) / 3 };
    }).sort((a, b) => b.z - a.z);
    ctx.lineJoin = "round";
    for (const { ps, cross, entry, z } of drawn) {
      const front = cross < 0;
      ctx.beginPath();
      ps.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
      ctx.closePath();
      if (front && entry.state === "done") {
        ctx.fillStyle = alpha(colors.blue, level(entry) * (0.55 + 0.45 * Math.min(1, -z)));
        ctx.fill();
      }
      ctx.strokeStyle = front ? colors.hair : alpha(colors.hair, 0.35);
      ctx.lineWidth = entry.state === "current" ? 2 : 0.75;
      if (entry.state === "current" && front) ctx.strokeStyle = colors.ink;
      ctx.stroke();
    }
  });

  /** Sol LeWitt's open cubes: the lattice is its edges, one edge per KP, built from the floor up. */
  const LATTICE = (() => {
    const n = 4, edges = [];
    const at = (i) => (i / (n - 1)) * 1.3 - 0.65;
    for (let y = 0; y < n; y += 1) for (let z = 0; z < n; z += 1) for (let x = 0; x < n; x += 1) {
      if (x < n - 1) edges.push([[at(x), at(y), at(z)], [at(x + 1), at(y), at(z)]]);
      if (z < n - 1) edges.push([[at(x), at(y), at(z)], [at(x), at(y), at(z + 1)]]);
      if (y < n - 1) edges.push([[at(x), at(y), at(z)], [at(x), at(y + 1), at(z)]]);
    }
    return edges;
  })();
  window.spinningFigure("lattice3d", { name: "开放立方", group: "3D" }, (ctx, w, h, entries, colors, view) => {
    const lines = LATTICE.map((edge, i) => {
      const a = project(edge[0], view, w, h, { scale: 1 }), b = project(edge[1], view, w, h, { scale: 1 });
      return { a, b, z: (a.z + b.z) / 2, entry: entries[Math.floor((i * entries.length) / LATTICE.length)] };
    }).sort((p, q) => q.z - p.z);
    ctx.lineCap = "square";
    for (const { a, b, z, entry } of lines) {
      const near = 0.55 + 0.45 * Math.max(0, Math.min(1, 0.5 - z));
      ctx.strokeStyle = entry.state === "done" ? alpha(colors.blue, level(entry) * near) : alpha(colors.faint, 0.28 * near);
      ctx.lineWidth = entry.state === "done" ? 3.5 * near : entry.state === "current" ? 3 : 0.75;
      if (entry.state === "current") ctx.strokeStyle = colors.ink;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }, { yaw: 0.6, pitch: 0.45 });

  /** A torus knot: one band that returns to where it began, the shape of repetition. */
  const knotPoint = (s, p = 3, q = 5) => {
    const a = s * 2 * Math.PI, r = 0.62 + 0.26 * Math.cos(q * a);
    return [r * Math.cos(p * a), 0.26 * Math.sin(q * a), r * Math.sin(p * a)];
  };
  window.spinningFigure("knot", { name: "环面纽结", group: "3D" }, (ctx, w, h, entries, colors, view) => {
    const count = entries.length, SUB = 4, parts = [];
    for (let i = 0; i < count; i += 1) {
      for (let j = 0; j < SUB; j += 1) {
        const a = project(knotPoint((i + j / SUB) / count), view, w, h, { scale: 1 });
        const b = project(knotPoint((i + (j + 1) / SUB) / count), view, w, h, { scale: 1 });
        parts.push({ a, b, z: (a.z + b.z) / 2, entry: entries[i] });
      }
    }
    parts.sort((p, q) => q.z - p.z);
    ctx.lineCap = "round";
    for (const { a, b, z, entry } of parts) {
      const near = 0.6 + 0.4 * Math.max(0, Math.min(1, 0.5 - z));
      if (entry.state === "done") {
        // A paper-coloured halo first, so strands read as passing over one another.
        const band = Math.max(5, Math.min(w, h) * 0.045) * near;
        ctx.strokeStyle = colors.paper; ctx.lineWidth = band + 5;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.strokeStyle = alpha(colors.blue, level(entry)); ctx.lineWidth = band;
      } else {
        ctx.strokeStyle = entry.state === "current" ? colors.ink : alpha(colors.faint, 0.4 * near);
        ctx.lineWidth = entry.state === "current" ? 3 : 0.9;
      }
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
  }, { yaw: 0.3, pitch: 0.9, speed: 0.003 });

  /** The 120-faced solid again, drawn with a 4×4 ordered dither in two colours: the dither the ur4n0x ghost already speaks. */
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
  const parseRgb = (rgb) => rgb.match(/[\d.]+/g).slice(0, 3).map(Number);
  window.spinningFigure("dither", { name: "1-bit 抖动", group: "3D" }, (ctx, w, h, entries, colors, view) => {
    const PIXEL = 3, W = Math.floor(w / PIXEL), H = Math.floor(h / PIXEL);
    if (W < 2 || H < 2) return;
    const image = ctx.createImageData(W, H), depth = new Float32Array(W * H).fill(Infinity), shade = new Float32Array(W * H).fill(-1);
    const light = [-0.5, 0.65, -0.57];
    FACES.forEach((face, i) => {
      const entry = faceEntry(entries, i);
      const ps = face.map((p) => project(p, view, W, H, { scale: 0.92 }));
      const area = (ps[1].x - ps[0].x) * (ps[2].y - ps[0].y) - (ps[1].y - ps[0].y) * (ps[2].x - ps[0].x);
      if (area >= 0) return;
      const u = [face[1][0] - face[0][0], face[1][1] - face[0][1], face[1][2] - face[0][2]];
      const v = [face[2][0] - face[0][0], face[2][1] - face[0][1], face[2][2] - face[0][2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const nl = Math.hypot(...n) || 1;
      // Rotate the normal with the view so light stays fixed to the camera.
      const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
      const rx = (n[0] * cy + n[2] * sy) / nl, rz0 = (-n[0] * sy + n[2] * cy) / nl, ry = (n[1] * cp - rz0 * sp) / nl, rz = n[1] * sp / nl + rz0 * cp;
      const facing = Math.abs(rx * light[0] + ry * light[1] + rz * light[2]);
      const value = entry.state === "done" ? 0.18 + 0.82 * facing * level(entry) : entry.state === "current" ? 1 : 0.06 + 0.1 * facing;
      const minX = Math.max(0, Math.floor(Math.min(ps[0].x, ps[1].x, ps[2].x))), maxX = Math.min(W - 1, Math.ceil(Math.max(ps[0].x, ps[1].x, ps[2].x)));
      const minY = Math.max(0, Math.floor(Math.min(ps[0].y, ps[1].y, ps[2].y))), maxY = Math.min(H - 1, Math.ceil(Math.max(ps[0].y, ps[1].y, ps[2].y)));
      for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
        const w0 = ((ps[1].x - ps[0].x) * (y - ps[0].y) - (ps[1].y - ps[0].y) * (x - ps[0].x)) / area;
        const w1 = ((ps[2].x - ps[1].x) * (y - ps[1].y) - (ps[2].y - ps[1].y) * (x - ps[1].x)) / area;
        const w2 = ((ps[0].x - ps[2].x) * (y - ps[2].y) - (ps[0].y - ps[2].y) * (x - ps[2].x)) / area;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = (ps[0].z + ps[1].z + ps[2].z) / 3, at = y * W + x;
        if (z < depth[at]) { depth[at] = z; shade[at] = value; }
      }
    });
    const ink = parseRgb(colors.ink), paper = parseRgb(colors.paper);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
      const at = y * W + x, value = shade[at], c = value < 0 ? paper : value > BAYER[(y % 4) * 4 + (x % 4)] ? ink : paper;
      image.data.set([c[0], c[1], c[2], 255], at * 4);
    }
    const buffer = document.createElement("canvas");
    buffer.width = W; buffer.height = H;
    buffer.getContext("2d").putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(buffer, 0, 0, W * PIXEL, H * PIXEL);
  }, { yaw: 0.2, pitch: 0.3, speed: 0.005 });
})();
