// Theme D's figure: Tatlin's tower in plain canvas with a hand-written projection. No library.
// The double helix is the course: 120 KPs along it, a rung at each of the 48 topics. Unlearned parts are scaffold; learned parts are built.
window.paints = window.paints ?? {};
window.paints.tower = (() => {
  const TURNS = 5.5;
  const TILT = (-13 * Math.PI) / 180;
  const PITCH = 0.42;
  const CAMERA = 6;
  const STEPS_PER_KP = 5;
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
  let canvas, ctx, observer, frame, width = 0, height = 0;
  let yaw = 0.6, dragging = false, lastX = 0, data = { progress: [], stage: "explanation" };

  const radius = (s) => 0.5 * Math.pow(1 - s, 0.85) + 0.025;
  const helix = (s, phase) => {
    const angle = TURNS * 2 * Math.PI * s + phase;
    return [radius(s) * Math.cos(angle), s * 1.5 - 0.72, radius(s) * Math.sin(angle)];
  };

  function project([x, y, z]) {
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
    const rx = x * cosY + z * sinY, rz = -x * sinY + z * cosY;
    const cosP = Math.cos(PITCH), sinP = Math.sin(PITCH);
    const py = y * cosP - rz * sinP, pz = y * sinP + rz * cosP;
    const cosT = Math.cos(TILT), sinT = Math.sin(TILT);
    const tx = rx * cosT - py * sinT, ty = rx * sinT + py * cosT;
    const fit = Math.min(width / 1.75, height / 1.72);
    const scale = fit * CAMERA / (CAMERA + pz);
    return { x: width * 0.5 + tx * scale, y: height * 0.5 - ty * scale, z: pz };
  }

  function segments() {
    const out = [];
    const { progress } = data;
    const count = progress.length;
    if (!count) return out;
    const stateAt = (i) => progress[Math.min(i, count - 1)].state;
    for (let i = 0; i < count; i += 1) {
      const state = stateAt(i);
      for (let j = 0; j < STEPS_PER_KP; j += 1) {
        const a = (i + j / STEPS_PER_KP) / count, b = (i + (j + 1) / STEPS_PER_KP) / count;
        out.push({ a: helix(a, 0), b: helix(b, 0), kind: state });
        out.push({ a: helix(a, Math.PI), b: helix(b, Math.PI), kind: state === "done" ? "done-soft" : "untouched" });
      }
    }
    // A rung at each topic, across the helix; spokes on the same floors tie it to the spine.
    let kp = 0;
    window.COURSE.forEach((topic) => {
      const s = kp / count;
      const state = stateAt(kp);
      out.push({ a: helix(s, 0), b: helix(s, Math.PI), kind: state === "done" ? "done-soft" : "rung" });
      kp += topic.kps;
    });
    // The spine and four raking struts from the base to the top.
    const spine = (s) => [0, s * 1.5 - 0.72, 0];
    for (let i = 0; i < 12; i += 1) out.push({ a: spine(i / 12), b: spine((i + 1) / 12), kind: "spine" });
    for (let k = 0; k < 4; k += 1) {
      const phase = (k * Math.PI) / 2 + Math.PI / 4;
      for (let i = 0; i < 16; i += 1) {
        const at = (s) => [radius(s) * 1.04 * Math.cos(phase), s * 1.5 - 0.72, radius(s) * 1.04 * Math.sin(phase)];
        out.push({ a: at(i / 16), b: at((i + 1) / 16), kind: "strut" });
      }
    }
    return out;
  }

  const STYLE = {
    untouched: [0.75, "232,242,250", 0.32],
    rung: [0.6, "232,242,250", 0.2],
    spine: [0.9, "232,242,250", 0.3],
    strut: [0.6, "232,242,250", 0.18],
    "done-soft": [1, "232,242,250", 0.6],
    tried: [1.5, "255,255,255", 0.8],
    done: [2, "255,255,255", 1],
    current: [2.6, "255,255,255", 1],
  };

  function draw() {
    ctx.clearRect(0, 0, width, height);
    const lines = segments().map((line) => {
      const a = project(line.a), b = project(line.b);
      return { a, b, z: (a.z + b.z) / 2, kind: line.kind };
    }).sort((p, q) => q.z - p.z);
    ctx.lineCap = "round";
    for (const { a, b, z, kind } of lines) {
      const [lineWidth, rgb, alpha] = STYLE[kind];
      const depth = 0.55 + 0.45 * Math.min(1, Math.max(0, 0.5 - z));
      ctx.strokeStyle = `rgba(${rgb},${alpha * depth})`;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    // The KP being learned now.
    const index = data.progress.findIndex((entry) => entry.state === "current");
    if (index >= 0) {
      const p = project(helix((index + 0.5) / data.progress.length, 0));
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.5)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /** It turns slowly while reading, and stands still while the learner answers. */
  function tick() {
    const still = dragging || calm.matches || data.stage === "practice";
    if (!still) { yaw += 0.0016; draw(); }
    frame = requestAnimationFrame(tick);
  }

  function resize() {
    const box = canvas.getBoundingClientRect();
    width = box.width;
    height = box.height;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw();
  }

  const onDown = (event) => { dragging = true; lastX = event.clientX; canvas.setPointerCapture(event.pointerId); };
  const onMove = (event) => {
    if (!dragging) return;
    yaw += (event.clientX - lastX) * 0.008;
    lastX = event.clientX;
    draw();
  };
  const onUp = () => { dragging = false; };

  return {
    mount(figure) {
      canvas = document.createElement("canvas");
      figure.replaceChildren(canvas);
      ctx = canvas.getContext("2d");
      canvas.addEventListener("pointerdown", onDown);
      canvas.addEventListener("pointermove", onMove);
      canvas.addEventListener("pointerup", onUp);
      observer = new ResizeObserver(resize);
      observer.observe(canvas);
      frame = requestAnimationFrame(tick);
    },
    unmount(figure) {
      cancelAnimationFrame(frame);
      observer.disconnect();
      figure.replaceChildren();
      canvas = undefined;
    },
    update(_figure, next) {
      data = next;
      if (canvas && width) draw();
    },
  };
})();
