#!/usr/bin/env python3
"""
Audits rendered pages against interface-craft standards that a browser can measure. Works on any site.

  python craft_audit.py URL [URL...] [--width 1440] [--height 900] [--touch] [--strict]

Needs Playwright. Headless only.
Findings are advice with a stated cost and a source; the author decides. --strict exits 1 if any remain.
"""
import json, sys
from playwright.sync_api import sync_playwright

PROBE = r"""
() => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // Any CSS colour, including oklch() and color-mix(), to [r, g, b, a].
  const rgba = (c) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (top, under) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1); };
  const bgOf = (el) => {
    const stack = [];
    for (let n = el; n; n = n.parentElement) { const c = rgba(getComputedStyle(n).backgroundColor); if (c[3] > 0) stack.push(c); if (c[3] === 1) break; }
    let base = [255, 255, 255, 1];
    for (const c of stack.reverse()) base = over(c, base);
    return base;
  };
  const lin = (v) => Math.pow(v / 255, 2.4);
  const Y = (c) => { let y = .2126729 * lin(c[0]) + .7151522 * lin(c[1]) + .072175 * lin(c[2]); return y < .022 ? y + Math.pow(.022 - y, 1.414) : y; };
  const apca = (t, b) => { const yt = Y(t), yb = Y(b); if (Math.abs(yb - yt) < .0005) return 0; if (yb > yt) { const s = (Math.pow(yb, .56) - Math.pow(yt, .57)) * 1.14; return s < .1 ? 0 : (s - .027) * 100; } const s = (Math.pow(yb, .65) - Math.pow(yt, .62)) * 1.14; return s > -.1 ? 0 : (s + .027) * 100; };
  const wl = (v) => { const c = v / 255; return c <= .03928 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4); };
  const L = (c) => .2126 * wl(c[0]) + .7152 * wl(c[1]) + .0722 * wl(c[2]);
  const wcag = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; for (let n = el; n; n = n.parentElement) { const s = getComputedStyle(n); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false; } return true; };
  const label = (el) => (el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : '') + ' "' + (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 18) + '"');

  const out = { texts: [], sizes: {}, weights: {}, radii: {}, findings: [] };
  const add = (rule, detail) => out.findings.push([rule, detail]);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (walker.nextNode()) {
    const text = walker.currentNode.textContent.trim();
    const el = walker.currentNode.parentElement;
    if (!text || !el || seen.has(el) || el.closest('script,style,noscript') || !visible(el)) continue;
    seen.add(el);
    const s = getComputedStyle(el), size = parseFloat(s.fontSize), weight = +s.fontWeight;
    out.sizes[size] = (out.sizes[size] || 0) + 1;
    out.weights[weight] = (out.weights[weight] || 0) + 1;
    if (size < 12) add('small-text', `${size}px ${label(el)}`);
    if (weight < 400) add('thin-weight', `${weight} ${label(el)}`);
    const color = over(rgba(s.color), bgOf(el)), bg = bgOf(el);
    const ratio = wcag(color, bg), lc = Math.abs(apca(color, bg));
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    if (ratio < (large ? 3 : 4.5)) add('contrast-wcag', `${ratio.toFixed(2)}:1 ${label(el)}`);
    const need = size >= 24 || (size >= 18 && weight >= 600) ? 60 : 75;
    if (Math.round(lc) < need) add('contrast-apca', `Lc ${lc.toFixed(0)} under ${need} at ${size}px/${weight} ${label(el)}`);
    if (/\.\.\./.test(text)) add('ellipsis-char', label(el));
    if (/["']/.test(text) && !el.closest('code,pre,kbd,samp,[translate="no"]') && !/^[\x00-\x7f]*$/.test(text)) add('curly-quotes', label(el));
    if (/\d+\s*[:/]\s*\d+/.test(text) && s.fontVariantNumeric.indexOf('tabular') < 0 && !/mono|code/i.test(s.fontFamily)) add('tabular-nums', label(el));
    // Line length and the lone last character, measured from the laid-out lines.
    if (s.display === 'block' || s.display === 'list-item' || el.tagName === 'P') {
      const range = document.createRange(); range.selectNodeContents(el);
      const lines = new Map();
      for (const r of range.getClientRects()) { const k = Math.round(r.top / 4); const v = lines.get(k) || [Infinity, -Infinity]; lines.set(k, [Math.min(v[0], r.left), Math.max(v[1], r.right)]); }
      const widths = [...lines.values()].map((v) => v[1] - v[0]);
      const han = (text.match(/[一-鿿]/g) || []).length / text.length > .4;
      const widest = Math.max(...widths);
      if (widths.length > 1) {
        const lh = parseFloat(s.lineHeight);
        if (han && widest / size > 40) add('measure', `${Math.round(widest / size)} Han chars a line ${label(el)}`);
        if (!han && widest / (size * .5) > 90) add('measure', `about ${Math.round(widest / (size * .5))} chars a line ${label(el)}`);
        if (han && size < 24 && lh / size < 1.5) add('leading', `${(lh / size).toFixed(2)} on Han text ${label(el)}`);
        if (widths[widths.length - 1] <= size * 2.2) add('widow', label(el));
      }
    }
  }
  const controls = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[tabindex]:not([tabindex="-1"])')].filter(visible);
  const coarse = matchMedia('(pointer: coarse)').matches, floor = coarse ? 44 : 24;
  for (const el of controls) {
    let box = el.getBoundingClientRect();
    if (el.matches('input[type=radio],input[type=checkbox]') && el.closest('label')) box = el.closest('label').getBoundingClientRect();
    if (box.bottom < 0 || box.right < 0) continue; // off screen until focused, like a skip link
    const inText = el.tagName === 'A' && el.closest('p,li,td');
    if (!inText && (box.width < floor || box.height < floor)) add('target-size', `${Math.round(box.width)}×${Math.round(box.height)} ${label(el)}`);
    const named = (el.textContent || '').trim() || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || (el.labels && el.labels.length) || el.getAttribute('alt') || el.closest('label');
    if (!named) add('unnamed-control', label(el));
    if (el.matches('input,textarea') && !coarse) continue;
    if (el.matches('input,textarea') && parseFloat(getComputedStyle(el).fontSize) < 16) add('input-zoom', label(el));
  }
  const all = [...document.querySelectorAll('body *')].filter(visible);
  const shadows = {};
  for (const el of all) {
    const s = getComputedStyle(el);
    const ms = s.transitionDuration.split(',').map((d) => parseFloat(d) * (d.includes('ms') ? 1 : 1000));
    if (s.transitionProperty.split(',').some((p) => p.trim() === 'all') && Math.max(...ms) > 0) add('transition-all', label(el));
    if (Math.max(...ms) > 450) add('long-transition', `${Math.max(...ms)}ms ${label(el)}`);
    const r = parseFloat(s.borderTopLeftRadius);
    if (r && r < 9000 && !s.borderTopLeftRadius.includes('%')) out.radii[r] = (out.radii[r] || 0) + 1;
    if (r && el.parentElement) { const pr = parseFloat(getComputedStyle(el.parentElement).borderTopLeftRadius); if (pr && r > pr && !getComputedStyle(el.parentElement).borderTopLeftRadius.includes('%')) add('nested-radius', `${r} inside ${pr} ${label(el)}`); }
    if (s.boxShadow !== 'none') { shadows[s.boxShadow] = 1; const layers = s.boxShadow.split(/,(?![^(]*\))/).filter((l) => !/\b0px 0px 0px\b/.test(l) && !/inset/.test(l)); if (layers.length === 1 && /rgba?\(0, 0, 0/.test(layers[0]) && /(\d+)px (\d+)px (\d+)px/.test(layers[0]) && parseFloat(layers[0].match(/(\d+)px (\d+)px (\d+)px/)[3]) > 4) add('flat-shadow', label(el)); }
    if (rgba(s.color).slice(0, 3).join() === '0,0,0' && el.children.length === 0 && (el.textContent || '').trim() && !window.__pure) { window.__pure = 1; add('true-black', label(el)); }
  }
  const root = getComputedStyle(document.documentElement), body = getComputedStyle(document.body);
  const vp = document.querySelector('meta[name=viewport]');
  if (vp && /maximum-scale|user-scalable=no/.test(vp.content)) add('zoom-blocked', vp.content);
  if (!document.title.trim()) add('page-title', '');
  if (!document.documentElement.lang) add('lang', '');
  if (!document.querySelector('meta[name=theme-color]')) add('theme-color', '');
  if (root.colorScheme === 'normal') add('color-scheme', '');
  if (document.documentElement.scrollWidth - innerWidth > 1) add('h-overflow', `${document.documentElement.scrollWidth - innerWidth}px`);
  if (!document.querySelector('h1') && document.body.innerText.length > 200) add('no-h1', '');
  let selection = false, hoverBare = 0, reduced = false;
  const scan = (rules, inHover) => { for (const r of rules) { if (r.conditionText !== undefined) { if (/prefers-reduced-motion/.test(r.conditionText)) reduced = true; scan(r.cssRules, inHover || /hover:\s*hover/.test(r.conditionText)); continue; } if (r.selectorText) { if (r.selectorText.includes('::selection')) selection = true; if (r.selectorText.includes(':hover') && !inHover) hoverBare += 1; } } };
  for (const sheet of document.styleSheets) { try { scan(sheet.cssRules, false); } catch { /* cross-origin */ } }
  if (!selection) add('selection-style', '');
  if (hoverBare) add('hover-unguarded', `${hoverBare} rules`);
  if (!reduced && document.getAnimations) add('reduced-motion', '');
  if (!document.querySelector('a[href^="#"]') && document.body.innerText.length > 400) add('skip-link', '');
  return out;
}
"""

# rule: (level, what it costs, where it comes from)
RULES = {
    "contrast-wcag": ("strong", "Below WCAG 2 AA some readers cannot read this.", "w3.org/TR/WCAG22 1.4.3"),
    "small-text": ("strong", "Under 12px Han characters lose detail. A heuristic: no standard sets 12.", "Apple HIG minimums, 10-11pt"),
    "zoom-blocked": ("strong", "People who need larger text cannot get it.", "Vercel: Respect zoom"),
    "unnamed-control": ("strong", "A screen reader announces nothing useful here.", "Vercel: Icon-only buttons are named"),
    "target-size": ("strong", "Hard to hit: WCAG asks 24px, Apple 44pt on touch.", "WCAG 2.5.8; Apple HIG buttons"),
    "h-overflow": ("strong", "The page scrolls sideways at this width.", "Vercel: Responsive coverage"),
    "input-zoom": ("recommended", "iOS zooms the page when a smaller input is focused.", "Vercel, Rauno: mobile input size"),
    "contrast-apca": ("recommended", "Passes or nears WCAG but reads weak; APCA models perception better. APCA is still a draft.", "apcacontrast.com"),
    "thin-weight": ("recommended", "Weights under 400 go faint on many screens.", "Rauno: Typography"),
    "measure": ("recommended", "Long lines lose the eye's return. clreq's ceiling is 48 Han characters; WCAG 1.4.8 (AAA) has a mechanism reach 40.", "w3.org/TR/clreq; WCAG 1.4.8"),
    "leading": ("recommended", "Han text needs room between lines; 1.5 is a common reference.", "WCAG 1.4.8 (AAA); Bob Tung"),
    "widow": ("recommended", "A lone character on the last line looks accidental. Try text-wrap: pretty.", "Vercel: Avoid widows"),
    "ellipsis-char": ("recommended", "Use … rather than three periods.", "Vercel"),
    "curly-quotes": ("recommended", "Straight quotes in prose read as typewriter text.", "Vercel; Practical Typography"),
    "tabular-nums": ("recommended", "Digits shift width as values change. font-variant-numeric: tabular-nums.", "Vercel, Rauno"),
    "transition-all": ("recommended", "transition: all animates layout you did not mean to move.", "Vercel"),
    "long-transition": ("recommended", "Interface motion should stay near or under 300ms unless the change is rare and deliberate.", "Emil Kowalski; Rauno"),
    "nested-radius": ("recommended", "A child rounder than its parent breaks the curve.", "Vercel: Nested radii"),
    "flat-shadow": ("recommended", "One black layer reads flat. Layer two, tinted to the surface.", "Comeau; Vercel"),
    "true-black": ("recommended", "True black is harsher than a very dark tinted neutral.", "Refactoring UI"),
    "hover-unguarded": ("recommended", "Hover sticks after a tap on touch screens. Wrap in @media (hover: hover).", "Rauno"),
    "selection-style": ("recommended", "The browser's selection colour ignores your palette.", "Rauno"),
    "color-scheme": ("recommended", "Scrollbars and form controls will not follow the theme.", "Vercel"),
    "theme-color": ("recommended", "The browser's own chrome will not match the page.", "Vercel"),
    "page-title": ("recommended", "Tabs and history cannot tell pages apart.", "Vercel"),
    "lang": ("recommended", "Without lang, screen readers and CJK font selection guess.", "clreq; WCAG 3.1.1"),
    "no-h1": ("recommended", "No top heading for assistive technology to land on.", "Vercel"),
    "skip-link": ("recommended", "Keyboard users have no way past the navigation.", "Vercel"),
    "reduced-motion": ("recommended", "No reduced-motion handling found in these stylesheets.", "Vercel; Carbon"),
}

def main():
    args = sys.argv[1:]
    strict = "--strict" in args
    width = int(args[args.index("--width") + 1]) if "--width" in args else 1440
    height = int(args[args.index("--height") + 1]) if "--height" in args else 900
    touch = "--touch" in args
    urls = [a for a in args if a.startswith("http") or a.startswith("file:")]
    remaining = 0
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        for url in urls:
            ctx = b.new_context(viewport={"width": width, "height": height}, locale="zh-CN", has_touch=touch, is_mobile=touch, reduced_motion="reduce")
            pg = ctx.new_page()
            pg.goto(url)
            pg.wait_for_timeout(900)
            res = pg.evaluate(PROBE)
            print(f"\n{url}")
            sizes = sorted(float(k) for k in res["sizes"]); radii = sorted(float(k) for k in res["radii"])
            print(f"  sizes {sizes}  weights {sorted(int(k) for k in res['weights'])}  radii {radii}")
            if len(sizes) > 6: res["findings"].append(["size-count", f"{len(sizes)} sizes on one screen"])
            grouped = {}
            for rule, detail in res["findings"]:
                grouped.setdefault(rule, []).append(detail)
            order = sorted(grouped, key=lambda r: RULES.get(r, ("recommended",))[0] != "strong")
            for rule in order:
                level, cost, source = RULES.get(rule, ("recommended", "Too many sizes blur the hierarchy; Ant suggests 3 to 5.", "ant.design/docs/spec/font"))
                items = [d for d in grouped[rule] if d]
                print(f"  [{level}] {rule}: {cost} ({source})")
                for d in items[:4]:
                    print(f"      {d}")
                if len(items) > 4:
                    print(f"      and {len(items) - 4} more")
                remaining += 1
            ctx.close()
        b.close()
    print(f"\n{remaining} kinds of finding.")
    sys.exit(1 if strict and remaining else 0)

if __name__ == "__main__":
    main()
