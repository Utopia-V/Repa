---
name: interface-craft
description: The fine detail that separates an interface that works from one that can be called design, for any project. Concrete, sourced rules on type (including Chinese and mixed Chinese-Latin), colour, proportion, shape, elevation, icons, motion, focus, forms, states and touch, a method for exploring design directions, and a script that audits rendered pages. Use whenever designing, building, restyling or reviewing a UI, mockup, design system or theme, even for small visual fixes, and whenever a screen looks templated or unrefined and nobody can say why.
---

# Interface craft

An interface succeeds through hundreds of small decisions, and these are checkable. "Looks fine" in a thumbnail proves little: most of what makes a screen read as designed is invisible until it is wrong.

The rules with their values and sources are in [references/standards.md](references/standards.md). Read it before setting tokens or reviewing a screen. It also lists what could not be sourced, so a remembered number does not pass for a standard.

## How to work

**1. Explore structure before surface.** A set of options sharing one layout is one option in different clothes. Ask what the whole world on this screen could be, and vary that first: columns, one long scroll, one thing at a time, a spatial map, a conversation, a desk of windows. Explore more widely than feels necessary, including directions nobody named. Then converge.

**2. Use real content and real states.** Placeholder text hides whether a layout survives. Design the empty, sparse, dense, long-content, error and loading cases, not just the good one.

**3. Write the system down as values.** Vague words like "clean" or "minimal" move a model to another fixed look. A spec names tokens, a scale, and what each is for. Separate what can vary:

| Layer | Owns | Should not |
| --- | --- | --- |
| State and actions | What is true and what can be done | Know about layout |
| Parts | Semantic pieces | Decide placement or hold sentences |
| Frame | Where parts go, how they move | Name a colour or typeface, or invent an action |
| Skin | Token values, surface details | Set layout |

A theme that only swaps tokens is a recolour: on one measured prototype tokens were about 15% of the lines that made a language distinct. If you want real variety, the boundary has to include layout.

**4. Audit what a browser can measure.** With Playwright available in your Python:

```sh
python .agents/skills/interface-craft/scripts/craft_audit.py URL [URL...] [--width 390 --height 844 --touch] [--strict]
```

It covers what it measures, not the whole of the standards. It reports contrast (WCAG and APCA), type sizes and weights in use, measure, leading, widows, target sizes, unnamed controls, transitions, radii, shadows, hover guards and page-level details, each with what it costs and where the rule comes from. Run it on every state of every screen, at phone width too. Treat a finding as a question: some are content, or a deliberate exception.

**5. Look at it at full size.** Take 2× crops of real regions and critique them before anyone else has to. Look for what a checklist cannot see: optical alignment, rhythm, whether the hierarchy holds, whether anything is there for no reason. Name what is weak in your own screenshot. Look at every view, not the ones you just changed: a view that a script passes can be plainly broken.

**5a. Do the task from the user's seat.** Most roughness is not visual. Walk the real job start to finish and ask at each moment: what does this person want to know, what do they want to do, and does this screen answer that? Bold style is not the problem and is not a defence: a striking screen can still be rough. For each element, ask what would be lost without it. Research how people really use this kind of product, including their complaints, and write a checklist of your own before building. Rules that survive a change of style are in `references/standards.md`.

**6. If others build on your system, say how firm each rule is.** Decide per project what is required and what is advice, and state the cost of ignoring advice plainly and neutrally. One shape that has worked: required only for what protects users' data or correctness, strongly recommended for readability, recommended for the rest.

**7. Do not confuse a test with a boundary.** Checks find problems in the cases they try. If something must not be shown, do not hand it to the layer that draws. If something must not be done, refuse it where it is done, not by hiding the button. Hidden controls also have to be unreachable: `inert`, not just `opacity: 0`.

## Related

- `ui-text`: whether a sentence should exist at all, and what each element may say.
- `frontend-design`: choosing a distinctive direction, and the clichés of generated design.
- A project may have its own design skill on top of this one, and its rules win where they differ.

When a person corrects a design detail that would apply to other projects, add it to `references/standards.md` in the same turn, with its reason.
