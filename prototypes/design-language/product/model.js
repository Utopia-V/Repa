// Stands in for the learning backend: what is true, what is released, what can be done.
// Course content is real, and the rules follow docs/development/learning-*.md. Dates, memory and the tutor's replies are demonstrations.
window.createRepa = (options = {}) => {
  const F = window.FULL;
  const TOPICS = F.topics;
  const topicById = new Map(TOPICS.map((t) => [t.id, t]));
  const FLAT = TOPICS.flatMap((topic) => topic.kps.map((kp) => ({ topic, kp })));
  FLAT.forEach((entry, index) => { entry.index = index; });
  const kpById = new Map(FLAT.map((entry) => [entry.kp.id, entry]));
  // packages/learning/src/parameters.ts
  const REVIEW_MAX = 5, REVIEW_PASS = 3, REVIEW_STREAK = 2, MENU_SIZE = 3, MIN_XP = 1, REVIEW_XP = 5, QUIZ_XP = 15, QUIZ_TOPICS = 5, QUIZ_MS = 15 * 60000;
  const KIND = { lesson: "新课", review: "复习", quiz: "测验" };
  const listeners = new Set();

  const noise = (id) => {
    let h = 2166136261;
    for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    h ^= h >>> 13;
    return ((Math.imul(h, 2654435761) >>> 8) & 255) / 255;
  };

  const facts = new Map(FLAT.map(({ kp }) => [kp.id, { passed: false, attempts: 0 }]));
  const topicFacts = new Map(TOPICS.map((t) => [t.id, { memory: null, days: null }]));
  const fact = (id) => facts.get(id);
  const learned = (t) => t.kps.every((kp) => fact(kp.id).passed);
  const startedSome = (t) => t.kps.some((kp) => fact(kp.id).passed);
  const eligible = (t) => !learned(t) && t.prereq.every((p) => learned(topicById.get(p)));

  if (options.later) {
    TOPICS.slice(0, options.upTo ?? 28).forEach((t, i, all) => {
      const age = all.length - i;
      topicFacts.set(t.id, { memory: Math.max(0.08, Math.min(1, 1.1 - age * 0.012 - noise(t.id) * 0.62)), days: Math.round(age * 1.2) });
      t.kps.forEach((kp) => { fact(kp.id).passed = true; fact(kp.id).attempts = 3 + Math.floor(noise(kp.id) * 3); });
    });
    // One lesson failed earlier: what passed stays passed, and the retry skips it.
    const tried = TOPICS.find(eligible);
    if (tried) { fact(tried.kps[0].id).passed = true; fact(tried.kps[0].id).attempts = 3; if (tried.kps[1]) fact(tried.kps[1].id).attempts = 2; }
  }

  const s = {
    task: null,
    xp: { today: options.later ? 12 : 0, goal: 20 },
    talk: [],
    just: [],
    empty: Boolean(options.empty),
    quizReady: Boolean(options.later),
  };
  const emit = () => listeners.forEach((listener) => listener(view()));

  // ---- the menu

  function menu() {
    if (s.empty) return [];
    const out = [];
    const due = TOPICS.filter((t) => learned(t) && topicFacts.get(t.id).memory < 0.55).sort((a, b) => topicFacts.get(a.id).memory - topicFacts.get(b.id).memory);
    if (due[0]) {
      const t = due[0];
      out.push({ id: `review-${t.id}`, kind: "review", kindName: KIND.review, title: t.title, topicIds: [t.id], xp: REVIEW_XP, why: `${topicFacts.get(t.id).days} 天前学的` });
    }
    for (const t of TOPICS.filter(eligible)) {
      const retry = startedSome(t);
      const before = t.prereq[t.prereq.length - 1];
      out.push({ id: `lesson-${t.id}`, kind: "lesson", kindName: KIND.lesson, title: t.title, topicIds: [t.id], xp: t.minutes, why: retry ? "再学一次，已通过的知识点不用重做" : before ? `接着：${topicById.get(before).title}` : "" });
    }
    const list = out.slice(0, s.quizReady ? MENU_SIZE - 1 : MENU_SIZE);
    if (s.quizReady) {
      const covered = TOPICS.filter(learned).slice(-QUIZ_TOPICS);
      list.push({ id: "quiz", kind: "quiz", kindName: KIND.quiz, title: `最近学的 ${covered.length} 个 topic`, topicIds: covered.map((t) => t.id), xp: QUIZ_XP, why: "限时 15 分钟" });
    }
    return list;
  }

  // ---- what a question may carry before its feedback is released

  function withheld(q) {
    return {
      id: q.id, body: q.body, datasets: q.datasets,
      slots: q.slots.map((slot) => {
        const base = { id: slot.id, type: slot.type, prompt: slot.prompt, suffix: slot.suffix, label: slot.label };
        if (slot.type === "text") return { ...base, format: slot.format, lines: slot.lines };
        if (slot.type === "choice") return { ...base, multiple: slot.multiple, options: slot.options.map(({ id, content }) => ({ id, content })) };
        if (slot.type === "order") return { ...base, indent: slot.indent, items: slot.items };
        if (slot.type === "table") {
          const open = new Set(slot.columns.filter((c) => !c.input).map((c) => c.id));
          return { ...base, columns: slot.columns, rows: slot.rows.map((r) => ({ id: r.id, cells: Object.fromEntries(Object.entries(r.cells).filter(([k]) => open.has(k))) })) };
        }
        return { ...base, language: slot.language, maxLines: slot.maxLines, starter: slot.starter };
      }),
    };
  }
  const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

  const norm = (value) => String(value ?? "").trim();
  const cellRight = (cell, value) => norm(cell).toLowerCase() === norm(value).toLowerCase();
  const judge = (q, response) => q.slots.every((slot) => {
    const value = response?.[slot.id];
    if (slot.type === "text") return norm(value) === norm(slot.key);
    if (slot.type === "choice") return slot.multiple ? JSON.stringify([...(value ?? [])].sort()) === JSON.stringify([...(slot.key ?? [])].sort()) : value === slot.key;
    if (slot.type === "order") return [slot.key, ...(slot.alternatives ?? [])].some((list) => JSON.stringify(value) === JSON.stringify(list));
    if (slot.type === "table") return slot.rows.every((r) => slot.columns.filter((c) => c.input).every((c) => cellRight(r.cells[c.id], value?.[r.id]?.[c.id])));
    if (slot.type === "code") return [slot.solution, ...(slot.accepts ?? [])].map(norm).includes(norm(value));
    return false;
  });
  const problemsIn = (q, response) => {
    const found = [];
    for (const slot of q.slots) {
      const text = norm(response?.[slot.id]);
      if (slot.type === "text" && !text) found.push({ slotId: slot.id, message: "还没填" });
      else if (slot.type === "text" && slot.format === "integer" && !/^-?\d+$/.test(text)) found.push({ slotId: slot.id, message: "填一个整数" });
      else if (slot.type === "choice" && !slot.multiple && !response?.[slot.id]) found.push({ slotId: slot.id, message: "还没选" });
    }
    return found;
  };

  // ---- a task

  const T = () => s.task;
  const restricted = (t = T()) => Boolean(t) && t.kind !== "lesson";
  const currentKp = (t = T()) => (t?.kind === "lesson" ? t.kps[t.k] : null);
  const questions = (t = T()) => (t.kind === "lesson" ? currentKp(t).practice : t.questions);
  const currentQuestion = () => questions()[T().qi];
  /** While this is true nothing but the question may be read, asked or searched. */
  const shut = () => Boolean(T()) && T().stage !== "completed" && (restricted() || ["answering", "judging", "recovery"].includes(T().stage));

  function complete(outcome) {
    const t = T();
    const answers = t.kind === "lesson" ? [...t.answers.values()].flat() : t.answers;
    const right = answers.filter((a) => a.correct).length;
    const ratio = answers.length ? right / answers.length : 0;
    const passed = outcome === "passed";
    t.reward = outcome === "unresolved" ? null : t.kind === "quiz" ? Math.floor(QUIZ_XP * ratio)
      : passed ? Math.max(MIN_XP, Math.floor((t.kind === "review" ? REVIEW_XP : t.topic.minutes) * ratio)) : 0;
    t.outcome = outcome;
    t.stage = "completed";
    t.back = null;
    s.xp.today += t.reward ?? 0;
    if (passed && t.kind !== "quiz") { topicFacts.set(t.topic.id, { memory: 1, days: 0 }); }
  }

  const reviewOutcome = (t) => {
    const right = t.answers.filter((a) => a.correct).length;
    const streak = t.answers.slice(-REVIEW_STREAK).every((a) => a.correct) && t.answers.length >= REVIEW_STREAK;
    if (right >= REVIEW_PASS && streak) return "passed";
    return t.answers.length >= t.questions.length ? "failed" : null;
  };

  const next = () => {
    const t = T();
    t.verdict = null; t.response = undefined; t.back = null;
  };

  /** Lesson: a KP passes when more than half of its required questions are right. It fails as soon as that cannot happen. */
  function afterLessonFeedback() {
    const t = T();
    const kp = currentKp(t);
    const answers = t.answers.get(kp.id);
    const right = answers.filter((a) => a.correct).length;
    const left = kp.practice.length - answers.length;
    if ((right + left) * 2 <= kp.practice.length) { complete("failed"); return; }
    if (left > 0) { t.qi += 1; t.stage = "answering"; next(); return; }
    fact(kp.id).passed = true;
    t.justPassed.push(kp.id);
    if (t.k + 1 < t.kps.length) { t.k += 1; t.qi = 0; t.stage = "explanation"; next(); return; }
    complete("passed");
  }

  function afterRestricted() {
    const t = T();
    const outcome = t.kind === "review" ? reviewOutcome(t) : (t.answers.length >= t.questions.length ? (t.answers.filter((a) => a.correct).length / t.questions.length >= 0.6 ? "passed" : "failed") : null);
    if (outcome) { complete(outcome); return; }
    t.qi += 1; t.stage = "answering"; next();
  }

  const record = (q, response, correct, skipped = false) => {
    const t = T();
    const entry = { qid: q.id, correct, skipped, response, question: q };
    if (t.kind === "lesson") { t.answers.get(currentKp(t).id).push(entry); fact(currentKp(t).id).attempts += 1; }
    else t.answers.push(entry);
  };

  // Every action checks that it is allowed now, as the real backend does.
  const actions = Object.freeze({
    start(id) {
      if (T()) return;
      const item = menu().find((m) => m.id === id);
      if (!item) return;
      s.just = [];
      s.last = null;
      if (item.kind === "lesson") {
        const topic = topicById.get(item.topicIds[0]);
        const kps = topic.kps.filter((kp) => !fact(kp.id).passed);
        s.task = { kind: "lesson", topic, kps, k: 0, qi: 0, stage: "explanation", answers: new Map(kps.map((kp) => [kp.id, []])), justPassed: [], retry: kps.length < topic.kps.length };
      } else if (item.kind === "review") {
        const topic = topicById.get(item.topicIds[0]);
        s.task = { kind: "review", topic, qi: 0, stage: "answering", questions: topic.kps.flatMap((kp) => kp.review).slice(0, REVIEW_MAX), answers: [], justPassed: [] };
      } else {
        const list = item.topicIds.map((id2) => topicById.get(id2));
        s.quizReady = false;
        s.task = { kind: "quiz", topic: null, title: item.title, qi: 0, stage: "answering", questions: list.map((t) => t.kps[t.kps.length - 1].quiz[0]).filter(Boolean), answers: [], deadline: Date.now() + QUIZ_MS, justPassed: [] };
      }
      emit();
    },
    advance() {
      const t = T();
      if (!t) return;
      if (t.stage === "explanation") t.stage = "example";
      else if (t.stage === "example") { t.stage = "answering"; t.qi = 0; next(); }
      else if (t.stage === "feedback") afterLessonFeedback();
      else return;
      emit();
    },
    submit(response) {
      const t = T();
      if (!t || t.stage !== "answering") return [];
      const q = currentQuestion();
      const problems = problemsIn(q, response);
      if (problems.length) return problems;
      const correct = judge(q, response);
      record(q, response, correct);
      t.response = response;
      if (restricted(t)) afterRestricted();
      else { t.stage = "feedback"; t.verdict = correct ? "right" : "wrong"; }
      emit();
      return [];
    },
    dontKnow() {
      const t = T();
      if (!t || t.stage !== "answering" || t.kind === "quiz") return;
      record(currentQuestion(), undefined, false, true);
      t.response = undefined;
      if (restricted(t)) afterRestricted();
      else { t.stage = "feedback"; t.verdict = "wrong"; }
      emit();
    },
    /** Looking back is free unless an answer is outstanding. */
    readBack(page, kpId) {
      const t = T();
      if (t?.kind !== "lesson" || shut()) return;
      const other = kpId ? t.topic.kps.find((kp) => kp.id === kpId) : null;
      if (other && !fact(other.id).passed && other !== currentKp(t)) return;
      t.back = page;
      t.backKp = other ?? null;
      emit();
    },
    closeBack() { if (T()) { T().back = null; T().backKp = null; emit(); } },
    timeUp() { if (T()?.kind === "quiz" && T().stage !== "completed") { complete(T().answers.some((a) => a.correct) ? "timeout" : "timeout"); emit(); } },
    /** Ends a task on purpose. Leaving the page does not: a task stays where it is until it is finished. */
    abort() { if (T() && T().stage !== "completed") { s.task = null; emit(); } },
    finish() {
      const t = T();
      if (t?.stage !== "completed") return;
      s.just = t.justPassed;
      s.last = { ...taskView(), canAsk: false };
      s.task = null;
      emit();
    },
    settled() { s.just = []; },
    ask(text) {
      if (shut() || !text.trim()) return;
      const t = T();
      const kp = currentKp();
      const entry = { me: text.trim(), page: pageKey(), where: t ? (t.topic?.title ?? t.title) : null, reply: null };
      s.talk = [...s.talk, entry];
      emit();
      setTimeout(() => {
        const link = kp?.links?.map((id) => kpById.get(id)).find(Boolean);
        entry.reply = kp
          ? `${kp.card.definition.trim()}${link ? `\n\n这里用到前面学过的[${link.kp.card.name}](repa:concept/${link.kp.id})。` : ""}`
          : "（原型里没有接模型，这里是占位回复。）";
        s.talk = [...s.talk];
        emit();
      }, options.instant ? 0 : 500);
    },
    /** Demonstration only: the states a real grader and connection can put the task in. */
    __state(name) {
      const t = T();
      if (name === "offline") { s.offline = !s.offline; emit(); return; }
      if (!t) return;
      if (name === "judging" || name === "recovery") { t.stage = name; t.response = {}; emit(); }
      if (name === "unresolved") { t.outcome = "unresolved"; t.reward = null; emit(); }
    },
    retry() { const t = T(); if (t?.stage === "recovery") { t.stage = "judging"; emit(); } },
    skipGrading() { const t = T(); if (t?.stage === "recovery") { if (t.qi + 1 < questions(t).length) { t.qi += 1; t.stage = "answering"; next(); } else complete("unresolved"); emit(); } },
    setGoal(value) { s.xp.goal = Math.max(5, Math.min(120, value)); emit(); },
    /** Demonstration only: answers the current question right or wrong. */
    __answer(right) {
      const t = T();
      if (!t || t.stage !== "answering") return;
      const q = currentQuestion();
      const answer = {};
      for (const slot of q.slots) {
        if (slot.type === "text") answer[slot.id] = right ? String(slot.key) : (slot.format === "integer" || typeof slot.key === "number" ? String(Number(slot.key) + 3) : "x");
        else if (slot.type === "choice") answer[slot.id] = right ? slot.key : (slot.multiple ? [] : slot.options.find((o) => o.id !== slot.key)?.id);
        else if (slot.type === "order") answer[slot.id] = right ? slot.key : [...slot.key].reverse();
        else if (slot.type === "code") answer[slot.id] = right ? slot.solution : slot.starter;
        else answer[slot.id] = Object.fromEntries(slot.rows.map((r) => [r.id, Object.fromEntries(slot.columns.filter((c) => c.input).map((c) => [c.id, right ? String(r.cells[c.id]) : "?"]))]));
      }
      actions.submit(answer);
    },
  });

  const pageKey = () => {
    const t = T();
    if (!t) return "today";
    return `${t.kind}:${t.topic?.id ?? "quiz"}:${t.k ?? ""}:${t.stage}:${t.qi}`;
  };

  // ---- what the interface sees

  function pathOf(t) {
    if (t.kind !== "lesson") {
      return [t.questions.map((q, i) => {
        if (t.stage === "completed") return { kind: "q", state: t.answers[i] ? (t.answers[i].correct ? "right" : "wrong") : "none" };
        return { kind: "q", state: i < t.qi ? "done" : i === t.qi ? "here" : "none" };
      })];
    }
    const groups = [];
    for (const kp of t.topic.kps) {
      const before = !t.kps.includes(kp);
      const k = t.kps.indexOf(kp);
      const atKp = k === t.k && t.stage !== "completed";
      const pastKp = before || k < t.k || t.stage === "completed";
      const reading = (name) => ({ kind: "read", state: pastKp ? "done" : !atKp ? "none" : t.stage === name ? "here" : (name === "explanation" && t.stage !== "explanation") ? "done" : (name === "example" && !["explanation", "example"].includes(t.stage)) ? "done" : "none" });
      const answers = t.answers.get(kp.id) ?? [];
      const qs = kp.practice.map((q, i) => {
        if (before) return { kind: "q", state: "done" };
        const a = answers[i];
        if (a) return { kind: "q", state: a.correct ? "right" : "wrong" };
        return { kind: "q", state: atKp && t.stage === "answering" && i === t.qi ? "here" : "none" };
      });
      groups.push([reading("explanation"), reading("example"), ...qs]);
    }
    return groups;
  }

  const stateWords = (id) => {
    const f = fact(id);
    const { topic } = kpById.get(id);
    const tf = topicFacts.get(topic.id);
    if (f.passed) return tf.memory !== null && tf.memory < 0.45 ? "已通过，记忆较弱" : "已通过";
    if (T()?.topic?.id === topic.id) return "正在学";
    if (f.attempts) return "作答过，未通过";
    return "还没学";
  };

  function progress() {
    const t = T();
    // One frame in a task: it is the tile that became the page.
    const here = t?.kind === "lesson" ? new Set([currentKp(t)?.id].filter(Boolean)) : t?.topic ? new Set([t.topic.kps[0].id]) : new Set();
    const first = !t ? menu()[0] : null;
    if (first && first.kind !== "quiz") for (const id of first.topicIds) for (const kp of topicById.get(id).kps) if (first.kind !== "lesson" || !fact(kp.id).passed) here.add(kp.id);
    const hide = shut() && restricted(t);
    return FLAT.map(({ topic, kp }, index) => {
      const f = fact(kp.id);
      const tf = topicFacts.get(topic.id);
      return { index, kp: { id: kp.id, name: hide ? "" : kp.card.name }, topic: { id: topic.id, title: hide ? "" : topic.title }, passed: f.passed, attempts: f.attempts, memory: tf.memory ?? 1, current: here.has(kp.id), missed: false, just: s.just.includes(kp.id), words: stateWords(kp.id), readable: canReadKp(kp.id) };
    });
  }

  function taskView() {
    const t = T();
    if (!t) return null;
    const kp = currentKp(t);
    const closed = shut();
    const stage = t.stage;
    const q = ["answering", "feedback", "judging", "recovery"].includes(stage) ? currentQuestion() : null;
    const released = stage === "feedback";
    const total = questions(t).length;
    const pageText = (page, which = kp) => (page === "explanation"
      ? { page, kpId: which.id, kpTitle: which.title, body: `${which === t.kps[0] && t.k === 0 && !t.retry ? `${t.topic.intro.trim()}\n\n` : ""}${which.lesson}` }
      : { page, kpId: which.id, kpTitle: which.title, question: clone(which.example) });
    return {
      kind: t.kind, kindName: KIND[t.kind], restricted: restricted(t), stage, closed,
      // In a review or quiz, naming the knowledge would tell the learner which knowledge to use.
      title: closed && restricted(t) ? KIND[t.kind] : (t.topic?.title ?? t.title),
      kp: kp ? { title: kp.title, n: t.topic.kps.indexOf(kp) + 1, of: t.topic.kps.length } : null,
      path: pathOf(t),
      qi: t.qi, total, answered: t.kind === "lesson" ? (t.answers.get(kp?.id)?.length ?? 0) : t.answers.length,
      reading: stage === "explanation" || stage === "example" ? pageText(stage) : null,
      back: t.back && !closed ? pageText(t.back, t.backKp ?? kp) : null,
      kpList: t.kind === "lesson" && !closed ? t.topic.kps.map((one) => ({ id: one.id, title: one.title, passed: fact(one.id).passed, here: one === kp })) : [],
      canBack: t.kind === "lesson" && !closed && stage !== "completed",
      question: q ? clone(released ? q : withheld(q)) : null,
      response: released || stage === "judging" || stage === "recovery" ? clone(t.response) : undefined,
      verdict: released ? t.verdict : null,
      deadline: t.deadline ?? null,
      outcome: t.outcome ?? null, reward: t.reward ?? null,
      wrapup: stage === "completed" && t.kind === "lesson" && t.outcome === "passed" ? t.topic.wrapup : null,
      submissions: stage === "completed" ? clone((t.kind === "lesson" ? [...t.answers.values()].flat() : t.answers).map((a) => {
        const found = kpById.get(a.qid.split(".").slice(0, 2).join("."));
        return { correct: a.correct, skipped: a.skipped, response: a.response, question: a.question, kpId: found?.kp.id ?? null, kpName: found?.kp.card.name ?? null };
      })) : [],
      canAsk: !closed,
      focusKp: kp?.id ?? t.topic?.kps[0].id ?? null,
    };
  }

  function view() {
    return {
      course: { title: F.title, passed: TOPICS.filter(learned).length, total: TOPICS.length },
      xp: { ...s.xp },
      offline: Boolean(s.offline),
      menu: T() ? [] : menu(),
      task: taskView(),
      progress: progress(),
      talk: s.talk,
      last: s.last ?? null,
      pageKey: pageKey(),
      shut: shut(),
    };
  }

  // ---- the knowledge base: what has been learned, and the topic in hand

  const inTask = (topic) => T()?.topic?.id === topic.id;
  function canReadKp(id) { const e = kpById.get(id); return Boolean(e) && !shut() && (fact(id).passed || inTask(e.topic)); }
  const canReadTopic = (t) => Boolean(t) && !shut() && (startedSome(t) || inTask(t));

  const lib = Object.freeze({
    topics: () => TOPICS.map((t) => ({
      id: t.id, title: t.title, readable: canReadTopic(t), learned: learned(t), inTask: inTask(t), memory: topicFacts.get(t.id).memory ?? 1, tried: t.kps.some((kp) => fact(kp.id).attempts > 0),
      firstKp: t.kps[0].id,
      kps: t.kps.map((kp) => ({ id: kp.id, name: kp.card.name, readable: canReadKp(kp.id), passed: fact(kp.id).passed, attempts: fact(kp.id).attempts, words: stateWords(kp.id) })),
    })),
    prereq: (id) => topicById.get(id)?.prereq.filter((p) => topicById.has(p)) ?? [],
    successors: (id) => TOPICS.filter((t) => t.prereq.includes(id)).map((t) => t.id),
    topicOf: (kpId) => kpById.get(kpId)?.topic.id ?? null,
    /** A topic's page. Only what may be read. */
    page(id) {
      const t = topicById.get(id);
      if (!canReadTopic(t)) return null;
      const tf = topicFacts.get(id);
      return {
        id, title: t.title, summary: t.summary, days: tf.days, memory: tf.memory, wrapup: learned(t) ? t.wrapup : null,
        kps: t.kps.filter((kp) => canReadKp(kp.id)).map((kp) => ({
          id: kp.id, title: kp.title, card: clone(kp.card), lesson: kp.lesson,
          links: kp.links.filter(canReadKp),
          usedBy: FLAT.filter((e) => e.kp.links.includes(kp.id) && canReadKp(e.kp.id)).map((e) => e.kp.id),
        })),
        hidden: t.kps.filter((kp) => !canReadKp(kp.id)).length,
      };
    },
    card(id) {
      if (!canReadKp(id)) return null;
      const { kp, topic } = kpById.get(id);
      const tf = topicFacts.get(topic.id);
      return { id, name: kp.card.name, aliases: kp.card.aliases ?? [], definition: kp.card.definition, example: kp.card.example, topicId: topic.id, topicTitle: topic.title, days: tf.days, words: stateWords(id), index: kpById.get(id).index, passed: fact(id).passed, memory: tf.memory ?? 1 };
    },
    topicCard(id) {
      const t = topicById.get(id);
      if (!t || shut()) return null;
      return { id, title: t.title, readable: canReadTopic(t), summary: canReadTopic(t) ? t.summary : null, kps: canReadTopic(t) ? t.kps.filter((kp) => canReadKp(kp.id)).map((kp) => kp.card.name) : [] };
    },
    entry: (id) => { const e = kpById.get(id); if (!e) return null; const f = fact(id); return { index: e.index, id, passed: f.passed, attempts: f.attempts, memory: topicFacts.get(e.topic.id).memory ?? 1 }; },
    topicEntry(id) {
      const t = topicById.get(id);
      const f = fact(t.kps[0].id);
      return { id: t.kps[0].id, passed: learned(t), attempts: t.kps.some((kp) => fact(kp.id).attempts) ? 1 : 0, memory: topicFacts.get(id).memory ?? 1, current: inTask(t) };
    },
    /** Name and aliases first, then the card's text. Topics not yet learned match by title only, and open nothing. */
    search(query) {
      if (shut()) return [];
      const q = query.trim().toLowerCase();
      if (!q) return [];
      const out = [];
      for (const { topic, kp } of FLAT) {
        if (!canReadKp(kp.id)) continue;
        const name = kp.card.name.toLowerCase();
        const aliases = (kp.card.aliases ?? []).map((a) => a.toLowerCase());
        const text = [kp.title, kp.card.definition, ...(kp.card.conditions ?? []), kp.card.example ?? ""].join("\n");
        let score = 0;
        if (name === q || aliases.includes(q)) score = 100;
        else if (name.startsWith(q)) score = 80;
        else if (name.includes(q) || aliases.some((a) => a.includes(q))) score = 60;
        else if (text.toLowerCase().includes(q)) score = 30;
        if (score) out.push({ type: "kp", id: kp.id, name: kp.card.name, score, topicTitle: topic.title, snippet: snippet(score === 30 ? text : kp.card.definition, q), alias: aliases.find((a) => a.includes(q)) ? kp.card.aliases.find((a) => a.toLowerCase().includes(q)) : null });
      }
      for (const t of TOPICS) {
        if (!t.title.toLowerCase().includes(q)) continue;
        out.push({ type: "topic", id: t.id, name: t.title, score: canReadTopic(t) ? 70 : 5, readable: canReadTopic(t), snippet: canReadTopic(t) ? t.summary : null });
      }
      return out.sort((a, b) => b.score - a.score).slice(0, 12);
    },
    /** What was learned most recently: the likeliest thing to be half remembered. */
    recent() {
      if (shut()) return [];
      return TOPICS.filter((t) => canReadTopic(t)).map((t) => ({ t, days: topicFacts.get(t.id).days ?? 0 })).sort((a, b) => a.days - b.days).slice(0, 5)
        .map(({ t, days }) => ({ type: "topic", id: t.id, name: t.title, readable: true, score: 0, snippet: `${days} 天前学的` }));
    },
  });

  const snippet = (text, q) => {
    const flat = text.replace(/```[a-z]*[^\n]*\n/g, "").replace(/```/g, "").replace(/[*`]/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
    const at = flat.toLowerCase().indexOf(q);
    if (at < 0) return flat.slice(0, 60);
    const start = Math.max(0, at - 16);
    return `${start ? "…" : ""}${flat.slice(start, start + 60)}`;
  };

  return Object.freeze({ actions, view, lib, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } });
};
