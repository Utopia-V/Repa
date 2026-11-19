// The model stands in for the learning backend. It decides what is true and what is released, so a frame cannot leak what it never receives.
// Grading, timing and rewards here are a demonstration of the contract's shapes, not evidence about the real plugin.
window.createApp = (options = {}) => {
  const I = window.ITEMS;
  const listeners = new Set();
  // packages/learning/src/parameters.ts
  const MIN_PASS_XP = 1, REVIEW_XP = 5, QUIZ_XP = 15, LESSON_MINUTES = 20;
  const REVIEW_QS = [I.lessonQuestions[0], I.lessonQuestions[1]];
  const QUIZ_QS = [I.lessonQuestions[0], I.lessonQuestions[1], I.lessonQuestions[2]];
  const s = {
    kind: options.kind ?? "lesson",
    stage: options.stage ?? "explanation",
    later: Boolean(options.later),
    q: options.q ?? 0,
    verdict: options.verdict ?? null,
    outcome: options.outcome ?? "passed",
    reward: options.reward ?? null,
    response: options.response,
    submissions: options.submissions ?? [],
    tutorMessages: options.chat ? window.SAMPLE_CHAT : [],
    offline: Boolean(options.offline),
    xpToday: options.later ? 12 : 0,
  };
  const questions = () => (s.kind === "lesson" ? I.lessonQuestions : s.kind === "review" ? REVIEW_QS : QUIZ_QS);
  const current = () => questions()[s.q];
  const restricted = () => s.kind !== "lesson";

  /** The tutor is shut while an answer is outstanding in a lesson, and for the whole of a review or quiz. */
  const tutorAllowed = () => {
    if (s.stage === "completed" || s.stage === "idle") return true;
    if (restricted()) return false;
    return ["explanation", "example", "feedback"].includes(s.stage);
  };

  /** What a question may carry before its feedback is released: enough to answer it, nothing that answers it. */
  function withheld(q) {
    return {
      id: q.id, body: q.body,
      slots: q.slots.map((slot) => {
        const base = { id: slot.id, type: slot.type, prompt: slot.prompt };
        if (slot.type === "text") return { ...base, format: slot.format };
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
  const freeze = (value) => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };

  const judge = (question, response) => question.slots.every((slot) => {
    const value = response?.[slot.id];
    if (slot.type === "text") return String(value ?? "").trim() === String(slot.key);
    if (slot.type === "choice") return slot.multiple ? JSON.stringify([...(value ?? [])].sort()) === JSON.stringify([...(slot.key ?? [])].sort()) : value === slot.key;
    if (slot.type === "order") return JSON.stringify(value) === JSON.stringify(slot.key);
    if (slot.type === "table") return slot.rows.every((r) => slot.columns.filter((c) => c.input).every((c) => String(value?.[r.id]?.[c.id] ?? "") === String(r.cells[c.id])));
    if (slot.type === "code") return [slot.solution, ...(slot.accepts ?? [])].map((x) => x.trim()).includes(String(value ?? "").trim());
    return false;
  });

  /** Empty or malformed is not an answer. The contract calls this not_accepted: nothing is recorded. */
  const problemsIn = (question, response) => {
    const found = [];
    for (const slot of question.slots) {
      const value = response?.[slot.id];
      const text = String(value ?? "").trim();
      if (slot.type === "text" && !text) found.push({ slotId: slot.id, message: "还没填" });
      else if (slot.type === "text" && slot.format === "integer" && !/^-?\d+$/.test(text)) found.push({ slotId: slot.id, message: "填一个整数" });
      else if (slot.type === "choice" && !slot.multiple && !value) found.push({ slotId: slot.id, message: "还没选" });
    }
    return found;
  };

  /** docs/development/learning-quiz-xp.md, repa-xp-v1. */
  function settle() {
    const total = questions().length;
    const right = s.submissions.filter((x) => x.correct).length;
    const ratio = right / total;
    const passed = s.kind === "quiz" ? ratio >= 0.6 : (s.kind === "review" ? right === total : right >= total - 1);
    const reward = s.kind === "quiz"
      ? Math.floor(QUIZ_XP * ratio)
      : passed ? Math.max(MIN_PASS_XP, Math.floor((s.kind === "review" ? REVIEW_XP : LESSON_MINUTES) * ratio)) : 0;
    s.outcome = passed ? "passed" : "failed";
    s.reward = reward;
    s.xpToday += reward;
    s.stage = "completed";
  }

  const emit = () => listeners.forEach((listener) => listener(view()));
  const nextQuestion = () => { s.q += 1; s.stage = "answering"; s.verdict = null; s.response = undefined; };

  // Every action checks that it is allowed now. A frame can call anything; only what the contract permits happens.
  const actions = Object.freeze({
    start(kind = "lesson") {
      if (s.stage !== "idle" && s.stage !== "completed") return;
      Object.assign(s, { kind, q: 0, submissions: [], verdict: null, response: undefined, reward: null, stage: kind === "lesson" ? "explanation" : "answering" });
      emit();
    },
    home() { s.stage = "idle"; emit(); },
    advance() {
      if (s.stage === "explanation") s.stage = "example";
      else if (s.stage === "example") { s.stage = "answering"; s.response = undefined; }
      else if (s.stage === "feedback" || s.stage === "recovery") { if (s.q + 1 < questions().length) nextQuestion(); else settle(); }
      else return;
      emit();
    },
    /** Returns the problems if not accepted; nothing changes then. */
    submit(response) {
      if (s.stage !== "answering") return [];
      const question = current();
      const problems = problemsIn(question, response);
      if (problems.length) return problems;
      const correct = judge(question, response);
      s.submissions.push({ question, response, correct });
      s.response = response;
      if (restricted()) { if (s.q + 1 < questions().length) nextQuestion(); else settle(); }
      else { s.stage = "feedback"; s.verdict = correct ? "right" : "wrong"; }
      emit();
      return [];
    },
    dontKnow() {
      if (s.stage !== "answering" || s.kind === "quiz") return;
      s.submissions.push({ question: current(), response: undefined, correct: false, skipped: true });
      s.response = undefined;
      if (restricted()) { if (s.q + 1 < questions().length) nextQuestion(); else settle(); }
      else { s.stage = "feedback"; s.verdict = "wrong"; }
      emit();
    },
    retry() { if (s.stage === "recovery") { s.stage = "judging"; emit(); } },
    ask(text) { if (tutorAllowed()) { s.tutorMessages = [...s.tutorMessages, { me: text }]; emit(); } },
  });

  const STEP_OF = { explanation: 0, example: 1, answering: 2, judging: 2, recovery: 2, feedback: 2, completed: 3 };

  function kps() {
    if (restricted() && s.stage !== "completed") return [];
    if (s.later) {
      return [
        { title: I.kps[0].title, attempts: 4, consecutive: 3, passed: true, marks: ["right", "wrong", "right", "right"] },
        { title: I.kps[1].title, attempts: 3, consecutive: 2, passed: false, marks: ["wrong", "right", "right"] },
      ];
    }
    const done = s.submissions.filter((x) => x.question.id.startsWith("py01.k1"));
    let streak = 0;
    for (const x of done) streak = x.correct ? streak + 1 : 0;
    const marks = done.map((x) => (x.correct ? "right" : "wrong"));
    if (options.verdict && !marks.length) marks.push(options.verdict);
    return [
      { title: I.kps[0].title, attempts: marks.length, consecutive: streak, passed: false, marks },
      { title: I.kps[1].title, attempts: 0, consecutive: 0, passed: false, marks: [] },
    ];
  }

  /**
   * The course as state, without its content. While a review or quiz is answering not even the names go out,
   * since recognising which knowledge applies is the thing being tested.
   */
  function courseState(attempts, missed, shut) {
    const topics = new Map();
    return window.simulateProgress({ later: s.later, attempts, missed }).map(({ topic, kp, state, passed, current, memory, retention, attempts: tried, missed: miss }) => {
      if (!topics.has(topic.id)) topics.set(topic.id, shut ? { id: topic.id, title: "" } : { id: topic.id, title: topic.title });
      return {
        state, passed, current, memory, retention, attempts: tried, missed: miss,
        topic: topics.get(topic.id),
        kp: shut ? { id: kp.id } : { id: kp.id, title: kp.title, card: { name: kp.card?.name ?? kp.title } },
      };
    });
  }
  /** What has been learned, for frames that keep it on the page. Empty while an answer is outstanding. */
  function learned(answering) {
    if (answering) return [];
    const out = new Map();
    for (const { topic, kp, passed } of window.simulateProgress({ later: s.later })) {
      if (!passed) continue;
      if (!out.has(topic.id)) out.set(topic.id, { id: topic.id, title: topic.title, names: [] });
      out.get(topic.id).names.push(kp.card?.name ?? kp.title);
    }
    return [...out.values()];
  }

  /** The only thing a frame ever sees. Unreleased fields are not hidden here; they are absent. */
  function view() {
    const here = kps();
    const answering = s.stage === "answering" || (restricted() && !["completed", "idle"].includes(s.stage));
    const released = s.stage === "feedback" || s.stage === "completed";
    const question = current();
    return freeze({
      kind: s.kind, kindName: { lesson: "新课", review: "复习", quiz: "测验" }[s.kind],
      stage: s.stage, verdict: s.stage === "feedback" ? s.verdict : null, outcome: s.stage === "completed" ? s.outcome : null,
      reward: s.stage === "completed" ? s.reward : null,
      offline: s.offline, later: s.later, answering, restricted: restricted(),
      tutorAllowed: tutorAllowed(), showKps: here.length > 0,
      course: { title: "Python：读懂代码，说清需求" }, topic: I.topic,
      stepIndex: STEP_OF[s.stage] ?? 0,
      steps: [["explanation", "讲解"], ["example", "例题"], ["practice", "练习"]],
      kps: here,
      xp: { today: s.xpToday, goal: 20 },
      clock: s.kind === "quiz" && s.stage !== "completed" ? "12:04" : null,
      q: s.q, total: questions().length,
      question: question ? JSON.parse(JSON.stringify(released ? question : withheld(question))) : null,
      response: s.response,
      answeredCount: s.submissions.length,
      // Results of a task exist only once it has ended.
      submissions: s.stage === "completed" ? JSON.parse(JSON.stringify(s.submissions)) : [],
      tutorMessages: s.tutorMessages,
      lesson: s.stage === "explanation" ? I.lesson : null,
      example: s.stage === "example" ? I.example : null,
      progress: courseState(here[0]?.attempts ?? 0, s.stage === "feedback" && s.verdict === "wrong", restricted() && answering),
      learned: learned(answering),
      menu: s.later
        ? [{ kind: "review", kindName: "复习", title: window.COURSE[11].title }, { kind: "lesson", kindName: "新课", title: window.COURSE[29].title }, { kind: "quiz", kindName: "测验", title: "第 3 单元" }]
        : [{ kind: "lesson", kindName: "新课", title: I.topic }, { kind: "lesson", kindName: "新课", title: window.COURSE[12]?.title ?? "" }],
    });
  }

  return Object.freeze({ actions, view, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, emit });
};
