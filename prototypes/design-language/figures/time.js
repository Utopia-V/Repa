// Figures of time: the student model's own curve. Repetition you can see. These histories are simulated until a query exists.
(() => {
  const { alpha } = window.FigureKit;
  const RATE = 1.3; // KPs a day, for the simulation only

  /** When each topic was first passed and later repeated, with intervals that widen after each repetition. */
  function histories(entries) {
    const topics = [];
    entries.forEach((entry, index) => {
      const last = topics[topics.length - 1];
      if (last && last.topic.id === entry.topic.id) { if (entry.state === "done") last.done = index; return; }
      topics.push({ topic: entry.topic, first: index, done: entry.state === "done" ? index : -1 });
    });
    const learned = entries.filter((entry) => entry.state === "done").length;
    const today = learned / RATE + 1;
    return { today, topics: topics.map((t) => {
      if (t.done < 0) return { topic: t.topic, reviews: [] };
      const start = t.done / RATE, reviews = [start];
      let gap = 2;
      while (reviews[reviews.length - 1] + gap < today) { reviews.push(reviews[reviews.length - 1] + gap); gap *= 2.1; }
      return { topic: t.topic, reviews };
    }) };
  }
  /** Retention at day d: resets at each repetition, decays more slowly each time. */
  function retention(reviews, d) {
    let last = -1, count = 0;
    for (const r of reviews) { if (r <= d) { last = r; count += 1; } }
    if (last < 0) return 0;
    return Math.exp(-(d - last) / (1.5 * Math.pow(2.1, count - 1)));
  }

  window.staticFigure("ridgeline", { name: "遗忘山脊", group: "时间" }, (ctx, w, h, entries, colors) => {
    const { topics, today } = histories(entries);
    const rows = topics.length, STEP = (h - 40) / rows, RISE = STEP * 4.2, left = 8, right = w - 8;
    const span = Math.max(today, 14);
    ctx.lineJoin = "round";
    topics.forEach((topic, row) => {
      const base = 34 + row * STEP + STEP;
      ctx.beginPath();
      ctx.moveTo(left, base);
      for (let x = left; x <= right; x += 1.5) {
        const value = retention(topic.reviews, ((x - left) / (right - left)) * span);
        ctx.lineTo(x, base - value * RISE);
      }
      ctx.lineTo(right, base);
      ctx.fillStyle = colors.paper;
      ctx.fill();
      ctx.strokeStyle = topic.reviews.length ? colors.ink : colors.hair;
      ctx.lineWidth = topic.reviews.length ? 1.1 : 0.75;
      ctx.stroke();
    });
  });

  window.staticFigure("score", { name: "重复的节奏", group: "时间" }, (ctx, w, h, entries, colors) => {
    const { topics, today } = histories(entries);
    const rows = topics.length, top = 8, ROW = (h - top * 2) / rows, left = 8, right = w - 8;
    const span = Math.max(today, 14), X = (d) => left + (d / span) * (right - left);
    topics.forEach((topic, row) => {
      const y = top + row * ROW + ROW / 2;
      ctx.strokeStyle = colors.hair;
      ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
      topic.reviews.forEach((day, i) => {
        const size = Math.max(2, ROW * 0.72);
        ctx.fillStyle = i === 0 ? colors.ink : colors.blue;
        ctx.fillRect(X(day) - (i === 0 ? size : size / 2), y - size / 2, i === 0 ? size * 2 : size, size);
      });
    });
    ctx.strokeStyle = colors.ink;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(X(today), top); ctx.lineTo(X(today), h - top); ctx.stroke();
  });
})();
