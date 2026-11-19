// The part of Markdown the course uses. Concept links become recall anchors.
window.MD = (() => {
  const esc = (t) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(repa:concept\/([a-z0-9.]+)\)/g, '<a class="concept" href="#$2" data-kp="$2">$1</a>');
  const code = (text, start = 1) => {
    const lines = text.replace(/\n$/, "").split("\n");
    return `<pre class="code" translate="no" style="counter-reset:line ${start - 1}"><code>${lines.map((l) => `<span class="ln">${highlight(l)}</span>`).join("")}</code></pre>`;
  };
  const highlight = (line) => esc(line)
    .replace(/\b(\d+)\b/g, '<span class="v">$1</span>')
    .replace(/\b(print|len|int|str|sum)\(/g, '<span class="f">$1</span>(');
  function block(text) {
    return text.split(/```[a-z]*[^\n]*\n([\s\S]*?)```/).map((part, i) => {
      if (i % 2 === 1) return code(part);
      return part.trim().split(/\n{2,}/).filter(Boolean).map((b) => {
        if (/^\d+\.\s/.test(b)) return `<ol>${b.split(/\n(?=\d+\.\s)/).map((li) => `<li>${inline(li.replace(/^\d+\.\s*/, ""))}</li>`).join("")}</ol>`;
        if (/^>\s?/.test(b)) return `<blockquote>${b.split("\n").map((l) => `<p>${inline(l.replace(/^>\s?/, ""))}</p>`).join("")}</blockquote>`;
        if (/^-\s/.test(b)) return `<ul>${b.split(/\n(?=-\s)/).map((li) => `<li>${inline(li.replace(/^-\s*/, ""))}</li>`).join("")}</ul>`;
        if (/^\|/.test(b)) {
          const rows = b.split("\n").filter((r) => !/^\|[\s:|-]+\|$/.test(r)).map((r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
          return `<table class="md-table"><thead><tr>${rows[0].map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.slice(1).map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
        }
        return `<p>${inline(b).replace(/\n/g, "")}</p>`;
      }).join("");
    }).join("");
  }
  return { block, inline, code, esc };
})();
