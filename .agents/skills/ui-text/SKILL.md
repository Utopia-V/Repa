---
name: ui-text
description: Decide whether a piece of interface text should exist and what it may say, before writing, reviewing or keeping any label, button, placeholder, tooltip, dialog, error, empty state or helper sentence. Use whenever building or reviewing a UI, a mockup or a design system, even if nobody mentions copy, and especially when a screen has explanatory sentences. For Repa, it also carries the rule that a model does not write human-facing UI text.
---

# UI text

Interface text is what remains after structure has done all it can. An agent's reflex is to explain, and users pay for each sentence by reading it: most people scan, and sentences that restate the obvious are, in NN/g's words, "information pollution". A screen that needs a paragraph usually has a design problem the paragraph is hiding.

## Should this sentence exist?

Work down this list, and stop at the first step that works.

1. **Can the structure say it?** Grouping, order, a default, a state that visibly changes, a label that names the result. Prefer these to any sentence.
2. **Can the choice go away?** Pick the right default, or remove the option. Settling it is better than explaining it.
3. **Can it be undone instead of warned about?** Apple and NN/g agree: no alert for common, undoable actions, even destructive ones. Offer undo.
4. **Is it needed only rarely?** Put it one level behind a control. NN/g treats more than two levels as a reason to simplify the design.
5. **Then write the fewest words that change what the user does next.**

The test for a surviving sentence: delete it, and ask whether the user would now do the wrong thing. If not, it goes. Sentences that describe how the system works inside almost never pass, because the user cannot act on them.

## What each element carries

| Element | Carries | Never |
| --- | --- | --- |
| Button | A verb naming the result, one or two words (`删除`, `提交`). A destructive action names its consequence | `确定`/`是` where a verb fits; an explanation of the button |
| Field label | Always visible, above or beside the field | Living only in the placeholder: it vanishes on typing, and users can no longer check their work |
| Placeholder | Nothing by default. NN/g tolerates a hint beside a real label, GOV.UK forbids it; take the stricter side | Label, requirement or instruction |
| Tooltip | Extra explanation of something unfamiliar | A repeat of the label; anything required to act, which must stay on screen. No helpful content means no tooltip |
| Confirmation | Only for serious or irreversible actions. Restate the specifics (file name, count). Buttons name both results (`删除文件`/`保留文件`), with no default yes | "你确定吗"; a confirmation for routine actions |
| Error | Beside its source: what happened, what to do, keeping the user's input. Atlassian's limit: title 3–4 words, body 1–2 sentences | Codes, jokes, "错误"/"非法"; a guessed cause ("If you don't know the reason, don't make one up"); appearing before the user has had a chance to answer |
| Empty state | Why it is empty and the action that leaves it, when neither is self-evident | Restating what the empty control already shows |
| Status | The state and its next action | How the state came about, unless the user acts on that |

## Chinese interfaces

Ant Design's 文案 guidance is the serious source I could verify:

- "省略无用词汇，不重复用户已知事实；在绝大多数交互场景下，都无需界面描述出全部的细节。"
- Write from the user's side: what they can do, not what "we" did for them. `我们` is fine for appeals.
- Key information first. The same thing keeps the same word, and an action's name equals the title of the page it opens.
- `无法完成` rather than `失败`, and give the next step.
- Omit unneeded punctuation. Avoid exclamation marks.

Also apply the project's rules on written Chinese, such as `repa-docs-style`.

## What not to claim

- There is no general numeric ceiling on UI text. Atlassian's limits are the only numbers found.
- NN/g's scanning figures (79% scan, half the words raises usability 58%) come from a 1997 study of web content, not app UI. They are direction, not measurement.
- Sources differ on whether an error leads with the cause or the fix. Lead with whichever the user needs in order to act.

## Repa: a model does not write this text

The maintainer's rule (Issue #101): human-facing UI text must not be AI-generated. Rewriting a bad sentence with a model breaks the rule just as writing it did, however good the result looks.

An agent may list the strings, mark what to delete and why, and implement words a person wrote. In prototypes, keep words to existing labels and real course content, and report them as placeholders. Model output that is the feature itself, such as tutor replies, is outside this.

Where the text lives (decided 2026-11-06, see the note `2026-11-06-ui-strings-and-components.md` in `.agents/notes/proposed/architecture/`): interface text sits in a strings file in `apps/web`, and components reference keys. An agent adding a UI element adds the key with a placeholder for a person to fill, never a value; the check reports placeholders, and a build with placeholders does not go to learners.

Repa sentences that failed the test, with the treatment:

| Sentence | Why it fails | Treatment |
| --- | --- | --- |
| 已经交的作答照样算数；还没判出结果的不等结果，直接结束。 | Explains the backend; the user would choose the same | Delete; the dialog's buttons name the results |
| 对所有学习空间生效。改动后 Agent 的下一条命令就按新设置处理，正在运行的对话也一样。 | Mechanism; nothing to act on | Delete |
| 这是一个新会话。说说你想学什么，或者直接提问。 | Restates the empty input | Delete |
| 辅导知道你正在做的题。 | The behaviour will show this | Delete |
| 这份作答没能判出结果，不算错。可以再判一次，也可以先做下一题，条件具备时会自动补判。 | The buttons already offer both paths; the last clause is mechanism | Keep the state and the two buttons; a person decides whether `不算错` earns its place |

Sources: Apple HIG [Writing](https://developer.apple.com/design/human-interface-guidelines/writing), [Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts) and [Undo](https://developer.apple.com/design/human-interface-guidelines/undo-and-redo); NN/g on [reading](https://www.nngroup.com/articles/how-users-read-on-the-web/), [tooltips](https://www.nngroup.com/articles/tooltip-guidelines/), [progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/), [placeholders](https://www.nngroup.com/articles/form-design-placeholders/), [errors](https://www.nngroup.com/articles/error-message-guidelines/) and [confirmation](https://www.nngroup.com/articles/confirmation-dialog/); [Atlassian on errors](https://atlassian.design/foundations/content/designing-messages/error-messages); [Ant Design 文案](https://ant.design/docs/spec/copywriting-cn) and [空状态](https://ant.design/docs/spec/research-empty-cn).
