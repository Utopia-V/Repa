// One lesson as a small state machine. Themes and paints only read what this writes to the DOM and to state.
const THEMES = {
  e: { name: "E 复", css: "themes/e-fu.css", paint: "strip" },
  f: { name: "F 蓝印", css: "themes/f-indigo.css", figure: "huiwen" },
  g: { name: "G 1-bit", css: "themes/g-bit.css", figure: "dither" },
  h: { name: "H 套印", css: "themes/h-riso.css", figure: "halftone" },
  i: { name: "I 终端", css: "themes/i-terminal.css", figure: "tenprint" },
  j: { name: "J 版式", css: "themes/j-swiss.css", transition: true },
  k: { name: "K 色场", css: "themes/k-albers.css", figure: "albers" },
  l: { name: "L 立体", css: "themes/l-solid.css", figure: "polyhedron", transition: true },
  m: { name: "M 水墨", css: "themes/m-ink.css", figure: "ink" },
  a: { name: "A 书房", css: "themes/a-study.css" },
  b: { name: "B 构成", css: "themes/b-construct.css" },
  c: { name: "C 格律", css: "themes/c-lattice.css", paint: "lattice" },
  d: { name: "D 塔", css: "themes/d-tower.css", paint: "tower" },
};
const STAGES = { explanation: "讲解", example: "例题", practice: "作答", right: "答对", wrong: "答错" };
const STEP = { explanation: "explanation", example: "example", practice: "practice", right: "practice", wrong: "practice" };
const ACTIONS = {
  explanation: [["看例题", "primary", () => go("example")]],
  example: [["开始练习", "primary", () => go("practice")]],
  practice: [["不会", "secondary", () => go("wrong", "")], ["提交", "primary", submit]],
  quiz: [["提交", "primary", submit]],
  right: [["继续", "primary", () => go("practice", "")]],
  wrong: [["继续", "primary", () => go("practice", "")]],
};

const params = new URLSearchParams(location.search);
const state = {
  theme: THEMES[params.get("theme")] ? params.get("theme") : "e",
  stage: STAGES[params.get("stage")] ? params.get("stage") : "explanation",
  later: params.get("later") === "1",
  dark: params.get("dark") === "1",
  value: params.get("value") ?? "",
  tutor: false,
  kind: ["review", "quiz"].includes(params.get("kind")) ? params.get("kind") : "lesson",
  chat: params.get("chat") === "1",
  offline: params.get("offline") === "1",
};
if (state.stage === "right" && !state.value) state.value = "5";
if (state.stage === "wrong" && !params.has("value")) state.value = "13";

const $ = (selector) => document.querySelector(selector);
const input = $("#answer");
const actions = $(".actions");
document.querySelectorAll(".code code").forEach((code) => {
  code.innerHTML = code.innerHTML.split("\n").map((line) => `<span class="ln">${line}</span>`).join("");
});
const ticks = $(".xp-ticks");
for (let i = 0; i < 20; i += 1) ticks.append(document.createElement("i"));

/** The fields the learning contract gives per KP: attempts, consecutiveCorrect, completed. `later` is a simulated later state. */
function knowledgePoints() {
  if (state.later) {
    return [
      { attempts: 4, consecutiveCorrect: 3, completed: true, marks: ["right", "wrong", "right", "right"] },
      { attempts: 3, consecutiveCorrect: 2, completed: false, marks: ["wrong", "right", "right"] },
    ];
  }
  const marks = state.stage === "right" ? ["right"] : state.stage === "wrong" ? ["wrong"] : [];
  return [
    { attempts: marks.length, consecutiveCorrect: state.stage === "right" ? 1 : 0, completed: false, marks },
    { attempts: 0, consecutiveCorrect: 0, completed: false, marks: [] },
  ];
}

function courseProgress() {
  const here = knowledgePoints()[0];
  return window.simulateProgress({ later: state.later, attempts: here.attempts, missed: state.stage === "wrong" });
}

function go(stage, value) {
  const apply = () => {
    state.stage = stage;
    if (value !== undefined) state.value = value;
    state.tutor = false;
    render();
    if (stage === "practice") input.focus();
  };
  const turn = THEMES[state.theme].transition && document.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (turn) document.startViewTransition(apply); else apply();
}

function submit() {
  const value = input.value.trim();
  if (!value) { input.focus(); return; }
  go(value === "5" ? "right" : "wrong", value);
}

function render() {
  document.documentElement.classList.toggle("dark", state.dark);
  $("#theme").href = THEMES[state.theme].css;
  const { body } = document;
  body.dataset.theme = state.theme;
  body.dataset.stage = state.stage;
  body.dataset.step = STEP[state.stage];
  body.dataset.tutor = state.tutor ? "open" : "closed";
  body.dataset.later = state.later ? "1" : "0";
  body.dataset.kind = state.kind;
  if (params.get("recall") === "1") body.dataset.recallOpen = "1";
  body.dataset.offline = state.offline ? "1" : "0";
  const kindName = { lesson: "新课", review: "复习", quiz: "测验" }[state.kind];
  $(".abort").textContent = `中止${kindName}`;
  $(".kind-label").textContent = kindName;
  $(".slot-feedback").hidden = state.value !== "13";
  $(".tutor-log").replaceChildren();
  if (state.chat) $(".tutor-log").innerHTML = window.SAMPLE_CHAT ?? "";

  input.value = state.value;
  input.readOnly = state.stage === "right" || state.stage === "wrong";

  document.querySelectorAll(".steps li").forEach((li) => {
    const order = Object.keys({ explanation: 0, example: 1, practice: 2 });
    const at = order.indexOf(STEP[state.stage]);
    const mine = order.indexOf(li.dataset.step);
    if (mine === at) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
    li.dataset.passed = mine < at ? "1" : "0";
  });

  knowledgePoints().forEach((kp, index) => {
    const row = document.querySelector(`.kp[data-kp="${index}"]`);
    row.dataset.done = kp.completed ? "1" : "0";
    row.dataset.tried = kp.attempts > 0 ? "1" : "0";
    const marks = row.querySelector(".kp-marks");
    marks.replaceChildren(...kp.marks.map((mark) => {
      const i = document.createElement("i");
      i.dataset.mark = mark;
      return i;
    }));
    marks.setAttribute("role", "img");
    marks.setAttribute("aria-label", `作答 ${kp.attempts} 次，连续答对 ${kp.consecutiveCorrect} 次，${kp.completed ? "已掌握" : "还没掌握"}`);
  });

  actions.replaceChildren(...ACTIONS[state.kind === "quiz" && state.stage === "practice" ? "quiz" : state.stage].map(([label, kind, handler]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.className = kind;
    button.addEventListener("click", handler);
    return button;
  }));

  const closed = state.stage === "practice";
  $(".tutor").dataset.closed = closed ? "1" : "0";
  $(".tutor-input textarea").disabled = closed;
  $(".tutor-input button").disabled = closed;
  $(".tutor-toggle").disabled = closed;

  paint();
  renderReview();
}

let painted, mountedFigure, figureName;
function paint() {
  const name = THEMES[state.theme].paint;
  const figure = $(".figure");
  const wanted = THEMES[state.theme].figure;
  if (mountedFigure && figureName !== wanted) { mountedFigure.stop(); mountedFigure = undefined; figureName = undefined; figure.replaceChildren(); }
  if (painted && painted !== name) { window.paints[painted].unmount(figure); painted = undefined; }
  if (wanted) {
    // Colours and columns come from the theme's stylesheet, so give it a moment to apply on a switch.
    if (!mountedFigure) { mountedFigure = window.Figures[wanted].mount(figure); figureName = wanted; }
    window.FigureKit.frozen = state.stage === "practice";
    const update = mountedFigure.update;
    requestAnimationFrame(() => update(courseProgress()));
    return;
  }
  if (!name) return;
  if (painted !== name) { window.paints[name].mount(figure); painted = name; }
  window.paints[name].update(figure, { progress: courseProgress(), stage: state.stage });
}

function links() {
  const span = document.createElement("span");
  const query = `?later=${state.later ? 1 : 0}&dark=${state.dark ? 1 : 0}`;
  for (const [href, label] of [["home.html", "今天"], ["repa.html?later=1#/k/", "知识库"], ["forms.html", "题型"]]) {
    const a = document.createElement("a");
    a.href = href + query;
    a.textContent = label;
    a.className = "review-link";
    span.append(a);
  }
  return span;
}

function renderReview() {
  const bar = $(".review");
  if (params.get("chrome") === "0") { bar.hidden = true; return; }
  const group = (entries, isOn, onClick) => {
    const span = document.createElement("span");
    for (const [key, label] of entries) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.setAttribute("aria-pressed", String(isOn(key)));
      button.addEventListener("click", () => onClick(key));
      span.append(button);
    }
    return span;
  };
  bar.replaceChildren(
    group(Object.entries(THEMES).map(([key, theme]) => [key, theme.name]), (key) => key === state.theme, (key) => { state.theme = key; render(); }),
    group(Object.entries(STAGES), (key) => key === state.stage, (key) => {
      go(key, key === "right" ? "5" : key === "wrong" ? "13" : "");
    }),
    group([["lesson", "新课"], ["review", "复习"], ["quiz", "测验"]], (key) => key === state.kind, (key) => { state.kind = key; if (key !== "lesson") state.stage = "practice"; render(); }),
    group([["chat", "对话"]], () => state.chat, () => { state.chat = !state.chat; render(); }),
    group([["offline", "断线"]], () => state.offline, () => { state.offline = !state.offline; render(); }),
    group([["later", "后期（模拟）"]], () => state.later, () => { state.later = !state.later; render(); }),
    group([["dark", "深色"]], () => state.dark, () => { state.dark = !state.dark; render(); }),
    links(),
  );
}

$(".answer").addEventListener("submit", (event) => { event.preventDefault(); if (state.stage === "practice") submit(); });
$(".tutor-toggle").addEventListener("click", () => { state.tutor = !state.tutor; document.body.dataset.tutor = state.tutor ? "open" : "closed"; });
$(".tutor-input").addEventListener("submit", (event) => event.preventDefault());
input.addEventListener("input", () => { state.value = input.value; });

render();
