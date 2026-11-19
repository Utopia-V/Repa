// The review bar for the pages outside the lesson: later/dark state in the URL, links between pages.
window.shell = (() => {
  const params = new URLSearchParams(location.search);
  const state = { later: params.get("later") === "1", dark: params.get("dark") === "1" };
  document.documentElement.classList.toggle("dark", state.dark);

  const query = (overrides = {}) => {
    const next = { ...state, ...overrides };
    return `?later=${next.later ? 1 : 0}&dark=${next.dark ? 1 : 0}`;
  };
  const here = location.pathname.split("/").pop() || "home.html";

  document.querySelectorAll('a[href="home.html"], a[href="repa.html?later=1#/k/"]').forEach((a) => {
    a.href = a.getAttribute("href") + query();
  });
  document.querySelectorAll('a[href^="app.html"]').forEach((a) => { a.href = a.getAttribute("href").replace(/later=\d/, `later=${state.later ? 1 : 0}`); });

  const bar = document.querySelector(".review");
  if (params.get("chrome") === "0") {
    bar.hidden = true;
  } else {
    const link = (href, label, on) => {
      const a = document.createElement("a");
      a.href = href;
      a.textContent = label;
      a.className = "review-link";
      if (on) a.style.color = "#fff";
      return a;
    };
    const hash = location.hash;
    bar.append(
      link(`app.html${query()}&frame=zoom&stage=idle`, "今天", false),
      link(`app.html${query()}&frame=zoom`, "上课", false),
      link("repa.html?later=1#/k/", "知识库", false),
      link("matrix.html", "矩阵", false),
      link("explore.html", "探索墙", false),
      link(`${here}${query({ later: !state.later })}${hash}`, state.later ? "回到第一天" : "后期（模拟）", false),
      link(`${here}${query({ dark: !state.dark })}${hash}`, state.dark ? "浅色" : "深色", false),
    );
  }
  return { state, params };
})();
