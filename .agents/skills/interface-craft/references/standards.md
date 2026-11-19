# Standards

Read from primary sources on 2026-11-04 unless marked. **[assumed]** means no source was found and the value is a working choice. **[summary]** means it came from a search summary rather than the page.

Sources differ in force. WCAG A and AA are requirements in many settings; AAA is an aspiration, and some of it asks for a way to reach a value rather than that value by default. Apple, Material and Carbon define their own platforms. Vercel, Rauno, Emil, Comeau and Butterick are the practice of named people and teams: strong evidence, not law.

The two closest things to a full checklist, worth rereading whole: [Vercel Web Interface Guidelines](https://vercel.com/design/guidelines) and [Rauno Freiberg's](https://interfaces.rauno.me).

## What survives a change of style

These hold whether the look is a constructivist tower or plain minimalism. Style can live in letterforms, motion and colour. Structure has to keep position, hierarchy, state cues and response. Persona 5 stays usable at full volume because it is still a list with a clear cursor and short paths [summary, fan analysis]. Cyberpunk 2077's failures are structural: tabs that shift, names that do not match contents, no batch actions ([critique](https://interfaceingame.com/articles/cyberpunk-2077-ux-ui-critique/)).

- **Clickable things look clickable, and nothing else does.** Something that looks like a tab or button and is not is a bug ([NN/g](https://www.nngroup.com/articles/flat-design/) 2015, [brutalist-web.design](https://brutalist-web.design)).
- **Hierarchy survives a blur and survives greyscale.** At most about 2 prominent elements and 3 contrast treatments per view; related things sit closer than unrelated ones ([NN/g](https://www.nngroup.com/articles/visual-hierarchy-ux-definition/) 2021).
- **Decoration never borrows a signal.** Not its colour, not its position.
- **One thing, one place.** Navigation does not move; a primary action lands on the same spot through a flow; new content appears below what the eye is on and does not push it down.
- **Names match contents; where am I and how do I leave are always answerable** ([heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/) 3, 4, 6).
- **Daily actions have fast paths** (heuristic 7).
- **Every state is drawn**, including the ones hard to reach in development. **Feel is uniform**: same-level buttons match in size and response, and growing content does not shift layout ([Linear](https://linear.app/now/quality-wednesdays) 2025).
- **The loudest layer carries display text only.** Body stays on a neutral face ([NN/g](https://www.nngroup.com/articles/neobrutalism/) 2025).
- **Numbers agree.** Two estimates that contradict each other are worse than none ([Hecker](https://frankhecker.com/2025/02/17/math-academy-part-10/) 2025).
- **A figure needs a job.** If removing it loses no knowledge and no action, it is decoration [assumed].
- **Beauty does not excuse.** The aesthetic-usability effect forgives minor problems and can hide them in review ([NN/g](https://www.nngroup.com/articles/aesthetic-usability-effect/) 2024). Its popular form is weaker than claimed: search results report that replications shrink it [summary]. Laws of UX are prompts, not proof: Miller's 7±2 is about memory, not menu length [summary].

## Reference views: tree, search, preview, graph

Give each the job it is good at.

- **Inline preview** answers "what was this again" without leaving. Open on hover after 500-750 ms (Wikipedia's test 500, production about 650, [Gwern](https://gwern.net/style-guide) 750 [summary]); shorter leaves a trail of popups. Open at once on click or tap. Keep it open while the pointer travels to it, close on Esc, open on focus (WCAG 1.4.13). Everything in it must also be reachable by following the link, since touch has no hover. In [Wikipedia's A/B test](https://www.mediawiki.org/wiki/Page_Previews/2017-18_A/B_Tests) distinct pages interacted with rose 21% and back-button use fell 9%; comprehension and retention were not measured.
- **Search** reaches a known item; **navigation** teaches the structure. They complement each other ([NN/g](https://www.nngroup.com/articles/search-not-enough/) [summary]); "search first beats browse" has no study behind it in what was found.
- **Tree keyboard** ([APG](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/)): Up and Down move without opening; Right opens, then enters; Left closes, then goes to the parent; Home, End; Enter activates; type-ahead. Focus and selection look different. Allow several branches open; auto-collapse hinders finding ([NN/g](https://www.nngroup.com/articles/accordions-on-desktop/) [summary]). Show indent guides, with indent at least 16 px [summary]. Reveal the current item on open and on demand, without jumping under the user.
- **Reference content must stand alone.** A card read weeks later that says "table M" needs table M beside it. Otherwise the product gives its memory burden back to the reader, which is the thing it exists to remove [assumed; found in review].
- **Global graphs** are mostly admired, not used: consistent forum testimony across Obsidian, Roam and Logseq, with no usage data ([example](https://forum.obsidian.md/t/whats-the-point-of-the-graph-view-how-are-you-using-it/71316?page=2)). Reported real uses are local: depth 1 or 2 ([XDA](https://www.xda-developers.com/ignored-obsidian-graph-view-for-years-but-i-was-looking-at-the-wrong-graph/) 2026), status colouring, orphans. Keep a whole-graph view secondary, colour by state, and emphasise only the focused item's edges.

## Learning products, from the learner's seat

Mostly self-selected adult learners on forums, so treat as leads.

- Say why a task was chosen and say when nothing is due; returning learners who saw no reviews doubted the system ([HN](https://news.ycombinator.com/item?id=41534847) 2024).
- A large due count is a reason to close the app; do not lead with a backlog ([summary, weak](https://my-senpai.com/insights/why-people-quit-anki.html)). Per-task time promises hurt when wrong [summary].
- Penalties that are hard to recover from feel like punishment: XP loss, ejection from a lesson, hearts (HN 2024, 2025).
- A tutor that must be summoned tends to go unused ([Hechinger](https://hechingerreport.org/proof-points-khanmigo-math-ai-tutor/) 2026, one draft study). Attaching it to the problem and offering it after a wrong answer is plausible but unevaluated.
- Leaving must cost nothing: keep unsubmitted answers, reading position and half-written questions. Keeping only the question number is not keeping the place [assumed; found in review].
- Show the verdict where the learner just pressed and keep the explanation in view: on a long question both can fall off screen, and the button to move on is what remains [assumed; found in review].
- Completion should register without becoming a loot box: finishing a whole course as a non-event disappointed one learner (Hecker), and Duolingo's completers just wanted more to practise [summary].

## Type: Latin and numbers

- **Tracking depends on size.** Tightest around 17-20 px, positive when small. Inter's formula: tracking(em) = -0.0223 + 0.185·e^(-0.1745·size); 12→0, 14→-0.006, 16→-0.011, 20→-0.017, 24→-0.019, 40+→-0.022 (applies to Inter, not CJK) ([rsms](https://d.rsms.me/inter-website/v3/dynmetrics/)). SF at 1/1000 em, probably iOS: 11→+6, 13→-6, 15→-16, 17→-26, 20→-23, 24→+3, 34→+12 ([Apple](https://developer.apple.com/design/human-interface-guidelines/typography)).
- **All caps and small caps** get 5-12% extra spacing; lowercase gets none. Kerning always on. Bold or italic, never both, as little as possible ([Butterick](https://practicaltypography.com/summary-of-key-rules.html)).
- **Body**: 15-25 px on the web, line spacing 120-145%, line length 45-90 characters (Butterick). Apple's minimums: iOS 11 pt, macOS 10 pt.
- **Numerals**: proportional in running text, tabular for columns and timers (`font-variant-numeric: tabular-nums`) ([Butterick](https://practicaltypography.com/alternate-figures.html), Vercel, Rauno). Non-breaking space between value and unit.
- **Weight**: none under 400. Medium headings 500-600. Weight must not change on hover or selection, or the layout shifts (Rauno).
- **Rendering**: `-webkit-font-smoothing: antialiased`, `text-rendering: optimizeLegibility`, `-webkit-text-size-adjust: 100%` (Rauno). Subset fonts, preload the critical ones (Vercel).
- **Punctuation**: `…` not `...`, curly quotes, an ellipsis on menu items that open something and on loading states (Vercel).
- **Sizes per screen**: 3-5 in Ant's system ([Ant](https://ant.design/docs/spec/font)); opinion, not normative. Size steps should be real: near-identical sizes blur the hierarchy instead of building it [assumed].

## Type: Chinese

- **Line length**: most books 17-40 characters, at most 48 ([clreq](https://www.w3.org/TR/clreq/)). WCAG 1.4.8 (AAA) asks that a mechanism can reach at most 40 for CJK; it does not bind your default, though it is a sensible one.
- **Line height**: no normative number. WCAG 1.4.8 (AAA) asks that a mechanism can reach 1.5, so it is a useful reference rather than a required default. Bob Tung, a clreq editor, gives 1.5-2.0 [summary]. Blogs suggest body 1.6-1.8, headings 1.2-1.4 [summary, weak]. Material says a Chinese "medium" language height runs about 7% taller than Latin.
- **Han-Latin gap**: at most 1/4 em, none at line ends, compressing to 1/8 and stretching to 1/2 in justified lines (clreq). `text-autospace: normal` gives 1/8 and is Baseline since November 2025 ([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/text-autospace)). Do not also type spaces by hand once it is on.
- **Punctuation**: `text-spacing-trim` compresses adjacent full-width punctuation. It needs `halt` or `chws` in the font and is not Baseline ([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/text-spacing-trim)). Source Han ships `halt` but apparently not `chws`, and Google Fonts' subsetting strips them ([issue](https://github.com/google/fonts/issues/7532)) [summary]. So check your actual font with fonttools. clreq's order is compress first, then push to the next line. Hanging is allowed, not common.
- **`line-break: strict`** for line-start and line-end prohibitions. `text-wrap: pretty` for lone last characters.
- **Headings break between words, never inside one.** CSS has no Chinese phrase breaking (`word-break: auto-phrase` is Japanese only). Use `Intl.Segmenter('zh', {granularity: 'word'})`, a `<wbr>` after each word and `word-break: keep-all`. Otherwise `text-wrap: balance` happily splits 变成 across two lines.
- **Latin inside Chinese**: pair a real Latin face through `unicode-range`, not the CJK font's Latin. Sizes that are equal on paper look different across faces, so set the same text in both and match by eye (`size-adjust`, `font-size-adjust`, Baseline 2024). No source gives a numeric ratio.
- **Song and Hei**: no sourced weight or tracking rules were found. Display tracking about 0.02 em comes from weak sources [summary]. Read The Type, 字谈字畅 or justfont when one is reachable.
- **Loading**: Noto Sans SC served as about 100 `unicode-range` slices totalling about 9 MB, a few per page, against 15.7 MB for the whole OTF [summary]. Prefer system CJK for body and slice only the display face.

## Colour

- **Define a scale up front**; no lightening or darkening on the fly. 8-10 greys, 5-10 shades per colour. True black looks unnatural ([Refactoring UI](https://refactoringui.com/previews/building-your-color-palette)).
- **Give each step a job.** Radix's 12: 1 page, 2 subtle, 3/4/5 component normal/hover/active, 6 subtle border, 7 interactive border and focus, 8 hover border, 9 solid (highest chroma), 10 solid hover, 11 low-contrast text, 12 high-contrast text ([Radix](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale)).
- **Work in OKLCH.** L there is perceived lightness; in HSL the same l looks different at each hue, so scales come out uneven ([Evil Martians](https://evilmartians.com/chronicles/oklch-in-css-why-quit-rgb-hsl), [Ottosson](https://bottosson.github.io/posts/oklab/)).
- **Contrast**: WCAG 2 is the normative one: 4.5:1 for text, 3:1 for large text and for boundaries of controls. APCA models perception better and Vercel prefers it, but it is a draft and WCAG 3 is still a Working Draft. [APCA levels](https://git.apcacontrast.com/documentation/APCA_in_a_Nutshell.html): Lc 90 preferred for body and the minimum at 14 px/400; Lc 75 the body minimum at 18 px/400 or 16 px/500; Lc 60 for non-body content at 24 px/400 or 16 px/700; Lc 45 headlines; Lc 30 placeholders; Lc 15 dividers. WCAG 2 overstates contrast for dark colours, so check both in dark mode.
- **Dark mode**: not black (#121212 in Material 2); higher means lighter; desaturate primaries to keep 4.5:1 at every elevation; few accents ([Material 2](https://m2.material.io/design/color/dark-theme.html)). `color-scheme: dark` on `<html>` and a matching `theme-color` (Vercel).
- **Interaction increases contrast**: hover, active and focus always stronger than rest (Vercel).
- **Hue consistency**: on non-neutral backgrounds, tint borders, shadows and text toward that hue (Vercel). Linear generates themes in LCH from base, accent and contrast ([Linear](https://linear.app/now/how-we-redesigned-the-linear-ui)). Colour-blind-safe palettes for charts.
- **Selection and caret** follow the palette; `::selection` is a one-line detail most sites miss (Rauno).

## Proportion and alignment

- **Everything aligns with something on purpose**: grid, baseline, edge or optical centre. Adjust ±1 px where perception beats geometry (Vercel).
- **Lockups**: beside medium-weight text, a thin icon may need a bolder stroke. Adjust weight, size, spacing or colour so they do not clash (Vercel).
- **Space**: a defined scale; proximity shows grouping, so space inside a group is clearly less than between groups [assumed, from common practice].
- **Control height**: no primary source gives a ratio to text. Apple's mini is 28 pt and regular 44; a desktop 40 px control with 14 px text works [assumed].
- **No dead zones** between list items: use padding, not gaps. Prefix and suffix icons sit inside the input and focus it (Vercel, Rauno).

## Shape and elevation

- **Nested radii**: child ≤ parent, concentric (Vercel). Inner = outer − padding − border, clamped at 0 ([Shed](https://shedsgns.me/radius)) [summary]; that author adds 1-3 px by eye.
- **Shadows**: at least two layers, ambient and direct (Vercel). One light source, so every shadow keeps the same x:y ratio. Higher means larger offset, larger blur and lower opacity. Tint to the background hue, not plain black. Do not animate a layered shadow. Use elevation tokens with a `--shadow-color` ([Comeau](https://www.joshwcomeau.com/css/designing-shadows/)).
- **Borders**: combine with shadows; semi-transparent borders improve edge clarity (Vercel). Hairlines: 0.5 px at 2 dppx through `min-resolution`, with feature detection [summary].

## Icons

- **Lucide's grid**: 24×24 canvas, at least 1 px safe zone, 2 px stroke, no mixed widths, 90° corners radius 2 for shapes ≥ 8 px and 1 below ([Lucide](https://lucide.dev/contribute/icons/design-principles)). Lucide uses round joins; pick one treatment and hold to it.
- **Material Symbols** [summary]: match optical size to rendered size; only 20 and 24 are pixel-aligned; negative grade for light on dark.
- **Every icon-only control has a name.** Decorative ones are hidden from assistive technology (Vercel).

## Motion

- **Ask whether it should move at all.** Only to clarify cause and effect or for deliberate delight (Vercel). Nothing seen tens or hundreds of times a day, and nothing keyboard-initiated ([Emil](https://emilkowal.ski/ui/you-dont-need-animations)).
- **Duration**: interactions at most 200 ms (Rauno), interface motion under 300 ms; 180 feels better than 400 (Emil). Larger values only for rare, deliberate changes of place [assumed]. Carbon's tokens: 70, 110, 150, 240, 400, 700 ms; micro-interactions 90-120.
- **Curves**: entering and exiting elements use ease-out; browser defaults are too weak, so use custom curves ([Emil](https://emilkowal.ski/ui/7-practical-animation-tips)). [Carbon](https://carbondesignsystem.com/elements/motion/overview): standard (0.2,0,0.38,0.9), entrance (0,0,0.38,0.9), exit (0.2,0,1,0.9).
- **Values**: press scales to 0.97 (Emil), never to 0.8. Never start from `scale(0)`; start at 0.9 or above. Set `transform-origin` to the trigger.
- **Implementation**: `transform` and `opacity` only; never `transition: all`; interruptible; CSS before script (Vercel). A blur of 2 px on a crossfade can mask a poor one (Emil).
- **Tooltips**: delay the first, none for the next in the group (Vercel, Emil).
- **Respect `prefers-reduced-motion`**, and pause loops off screen. Autoplay over 5 s needs a pause control (Vercel, WCAG). Switching theme must not trigger transitions (Rauno).
- **Loading**: show after 150-300 ms, stay at least 300-500 ms, to avoid flicker (Vercel).

## Focus and keyboard

- **Every focusable element has a visible, unobscured ring** via `:focus-visible` (Vercel). At least 2 CSS px thick with 3:1 contrast between focused and unfocused pixels ([WCAG 2.4.13](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html), AAA).
- **Sticky headers never cover the focused element**. Move and return focus according to [WAI-ARIA patterns](https://www.w3.org/WAI/ARIA/apg/patterns/). Skip link and hierarchical headings (Vercel).
- **Arrow keys through sequential lists** (Rauno). Every gesture has a click and keyboard alternative (Vercel).
- **Announce async updates** with a polite live region. Status never relies on colour alone (Vercel).

## Forms

- **Label everything**, and clicking the label focuses the control. Placeholders are not labels (see `ui-text`).
- **Enter submits** a single input or the last control; in a textarea ⌘/Ctrl+Enter submits and Enter is a newline (Vercel).
- **Do not pre-disable submit.** Let incomplete forms submit to surface validation, show errors beside the field, focus the first error. Disable only while in flight, with a spinner and the original label kept (Vercel).
- **Do not block typing or paste.** Allow any input and explain. Trim trailing whitespace from input methods. Right `type` and `inputmode`; `autocomplete` and sensible `name`; spellcheck off for codes (Vercel).
- **Autofocus** on desktop with a single primary input; rarely on touch, where the keyboard shifts the layout (Vercel).
- **Warn before losing unsaved work** (Vercel).

## Touch and small details

- **Targets**: 24 CSS px minimum ([WCAG 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)), 44 on mobile (Vercel, [Apple](https://developer.apple.com/design/human-interface-guidelines/buttons)), 48 dp in [Material](https://m3.material.io/foundations/designing/structure). Expand the hit area if the visual is smaller.
- **Input font ≥ 16 px on mobile**, or iOS zooms on focus. Never disable zoom (Vercel, Rauno).
- **Hover only where it exists**: `@media (hover: hover)`. Set `-webkit-tap-highlight-color` and replace it with something. `touch-action: manipulation` (Vercel, Rauno).
- **Overscroll**: `contain` in modals and drawers; `none` on `<html>` inside `@media (pointer: fine)`. Safe-area insets with `env()` (Vercel).
- **Interactive text** disables `user-select`; decorative elements disable `pointer-events` (Rauno).
- **Scrollbars**: only useful ones; test with "always show" on (Vercel).

## Content and states

- **Empty, sparse, dense and error states** are all designed. Skeletons mirror the final layout. Layouts survive short and very long content. Every screen has a next step (Vercel).
- **Keep feedback beside its trigger**: an inline checkmark, not a toast (Rauno). Inline help before tooltips (Vercel).
- **State lives in the URL** so it can be shared and survives Back: tabs, filters, open panels (Vercel). Accurate `<title>`. `translate="no"` on code and product names.

## Not found

Control-height ratios, disabled opacity, scrollbar and selection values, border alpha values, Material 3's type scale and icon keylines (pages did not render), Google Fonts Knowledge on pairing, Apple's dark mode text, Chinese display tracking and Song or Hei weight rules from a serious type source. Look again before inventing them, and mark any choice as an assumption.
