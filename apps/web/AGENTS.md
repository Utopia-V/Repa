# Web 界面

`apps/web` 是 Repa 的界面：后端 `packages/repa` 的一层薄视图，在浏览器的独立窗口里打开。它做什么、每一处的默认行为，见[自用骨架](../../.agents/notes/proposed/architecture/2026-11-26-self-use-skeleton.md#界面)的“界面”和“默认行为”两节。

## 外观照画稿

外观和每个部件由维护者逐张看过画稿以后定下，实现照画稿做，不另行设计。画稿在维护者本机的 `~/projects/repa/.scratch/design-language/selfuse/`，不入库：`all_r*.html` 是各轮的截图与说明，后一轮与前一轮不一致时以后一轮为准；`selfuse.css` 是样式，`glyphs.js` 是石头与草，`icons.js` 是用到的 Lucide 图标。

- `src/styles.css` 是样式的唯一来源，由画稿的 `selfuse.css` 合成而来，亮色与暗色两套变量都在开头。改外观时先改画稿、给维护者看，定下以后再搬过来。
- 画稿没画到的状态，照同一套变量和部件做最朴素的样子，放在 `styles.css` 文末一节，并在 PR 里逐条列出，供维护者看。
- 石头的形状、草和应用图标在 `src/glyph.tsx`，坐标照画稿原样，不凭印象重画。

## 结构

每个视图只接收路径和接口，不知道自己挂在哪里；布局只由“中间看什么”和“对话是否打开”决定，都在 `src/app.tsx`。换一种排法，或者以后给手机单独排，只改壳。

| 文件 | 内容 |
| --- | --- |
| `app.tsx`、`side.tsx`、`store.ts` | 壳、左栏，地址与开合状态 |
| `today.tsx`、`kb.tsx`、`card.tsx`、`marks.tsx`、`settings.tsx` | 今日、知识库与文件夹、卡片、勾画批注、设置 |
| `chat.tsx`、`items.tsx` | 对话面板；题目卡片、确认卡片、改动与差异 |
| `ui.tsx`、`glyph.tsx`、`markdown.tsx` | 基础部件、记号与图标、Markdown 渲染 |
| `api.ts`、`actions.tsx`、`strings.ts` | 接口的客户端、几处共用的动作、界面文字 |

部件只写这些画面用到的，不做一套组件库。对话事件的类型、`applyEvent` 和链接的解析直接用后端的 `src/protocol.ts` 与 `src/links.ts`（经 `@repa/protocol`、`@repa/links` 两个别名），界面里不出现 Pi 的类型。

## 界面文字

界面上的字都在 `src/strings.ts`，组件只引用键。用词以画稿和设计记录为准，只写标签，不写解释的句子；写之前读全局技能 `ui-text`。

## 基础行为

这几条全界面一致，新部件照用，不各自再写：输入法选字时的回车归输入法（`ui.tsx` 的 `AutoText` 与 `composing`）；菜单与弹出块的 Esc 逐层退出、焦点归还交给 Base UI（`Menu`、`Pop`）；发送失败时把文字和引文放回提问栏；动效在减弱动效的偏好下停掉。

## 开发与验证

```sh
npm run build --workspace=@repa/web   # 构建到 dist，repa 命令启动的后端直接提供
npm run dev --workspace=@repa/web     # 开发：vite 把 /api 转到 7723 端口的后端
npm run test --workspace=@repa/web
```

测试只检验纯逻辑和渲染结果，不能代替实际使用。改动界面或学习流程时，把后端和界面真的跑起来，用无头浏览器把改到的画面在亮色和暗色下各截一张，与画稿并排对一遍。不要打开可见窗口，也不要写入 `~/Repa`，用一个临时的知识库。
