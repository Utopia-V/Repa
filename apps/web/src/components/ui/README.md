# 通用 UI 组件

这些源码属于 Web 的通用组件层。业务组件通过 props 表达意图，不重新实现焦点管理、表单控件或颜色规则。主题和 token 由 `../../globals.css` 持有，语义见[设计系统规范](../../../../../docs/design-system.md)。

## 来源与版本

Button、Dialog、Checkbox、Select、Switch、ScrollArea 取自 [Fluid Functionalism](https://github.com/mickadesign/fluid-functionalism) 的 Base UI 版（2026-11-06 的 main，提交 7e6ae29），Input、Textarea、Badge、Banner、FluidHoverHighlight 取自同一仓库的单一来源组件，`../../lib` 和 `../../hooks` 里的 `springs`、`font-weight`、`omit`、`popup`、`shape-context`、`size-context`、`type-scale`、`icon-context`、`surface-context`、`surface-classes`、`elevated`、`fluid-provider`、`utils`、`use-fluid-hover`、`use-touch-primary`、`use-keyboard-nav-gate` 也是。MIT 许可原文在 [LICENSE.fluid-functionalism.md](LICENSE.fluid-functionalism.md)。这些文件开头注明了来源，由本仓库持有，不能无审查覆盖升级。

运行依赖按锁文件固定：Base UI 1.9.0、motion 14.10.0、Tailwind CSS 与 Vite 插件 4.3.3、class-variance-authority 0.7.1、clsx 2.1.1、tailwind-merge 3.7.0、lucide-react 1.46.0。

Sidebar、Card 和 Sheet 的接口来自 shadcn `new-york-v4`（MIT，原文在 [LICENSE.shadcn.md](LICENSE.shadcn.md)），底层换成了 Base UI，样式用组件库的 token。RadioGroup、Progress、InputGroup、SelectionButton 也保留了原来的接口。

## 相对上游的改动

升级上游文件时逐条核对：

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `dialog`、`select`、`switch`、`banner`、`use-fluid-hover`、`fluid-provider`、`icon-context` | 补 `undefined`、加类型断言 | `apps/web` 开了 `exactOptionalPropertyTypes` 和 `noUncheckedIndexedAccess` |
| `dialog`、`select`、`input`、`banner` | 英文文字换成字符串键 | 界面文字集中管理 |
| `button` | 根节点加 `data-variant` | 测试按它区分按钮层级 |
| `dialog` | 默认 `size="lg"`；内容区 `grid gap-4`，Header、Footer 不带外边距；限高滚动；Esc 只关最上层 | 保持原来的宽度和间距，长内容不超出窗口，互不嵌套的弹层也能逐层退出 |
| `input`、`textarea`、`select`、`checkbox` | 边框用 `input`，聚焦用 `input-focus` | 控件边界对比度至少 3:1 |
| `input`、`textarea` | `onKeyDown` 经过 `lib/composition-guard.ts` | 输入法选字时回车和方向键不交给外部处理 |
| `banner` | `BannerDescription` 用 `div` | 描述里可能有段落和按钮 |
| `fluid-provider` | 按系统偏好设置 `MotionGlobalConfig.skipAnimations` | 减少动态效果时连淡入淡出也停止 |

## 不用组件库的部分

- `RadioGroup`：组件库的 `RadioItem` 只收字符串标签，放不下题目里的 Markdown 选项。接口不变，圆圈和圆点照组件库，底层用 Base UI。
- `Card`：组件库的 Card 默认无边框、无内距，还依赖 `next/link`。这里保留简单的表面组件。
- `Sheet`：组件库的抽屉只能从底部出现。这里用 Base UI Dialog 和 CSS 过渡。
- `InputGroup`：组件库的同名组件是一组带标签的输入框。消息输入框的对应形态是 `input-message`，它会带入 `pdfjs-dist`。
- `MessageBubble`：组件库的 `chat-message` 同样依赖 `file-thumbnail`。
- `RowButton`：Button 固定高度、内容居中、文字不换行，占满一行或放多个元素的按钮用它。`SelectionButton` 在它之上加持续选择和勾选标记。
- `Progress`：组件库没有，直接用 Base UI。

## 本地组件

- `StatusNotice`：接受 `complete` / `error`，内部用 Banner；调用方不选颜色。
- `MessageBubble`：通过 CVA 管理气泡视觉；发送者语义由 `../domain/ConversationMessage` 映射。
- `SearchInput`：组合 Input 与 Button，持有可见 label、搜索图标和清空入口。
- `Markdown`：渲染模型写的 Markdown 与公式，排版用 `typography.css` 的 `.typeset`，代码块用 `not-typeset` 单独画。依赖按锁文件固定：react-markdown 10.1.0、remark-gfm 4.0.1、remark-cjk-friendly 2.3.2、remark-cjk-friendly-gfm-strikethrough 2.3.1、remark-math-extended 6.1.1、rehype-katex 7.0.1、KaTeX 0.16.47（与 rehype-katex 依赖的版本一致，样式表从这里引入）、remend 1.4.0、Shiki 4.4.3（`shiki`、`@shikijs/langs`、`@shikijs/themes`、`@shikijs/rehype`）。代码高亮按 Shiki 文档的细粒度方式引入：`shiki/core`、JavaScript 正则引擎，只带 Python、JavaScript、TypeScript、Bash、JSON 五种语法，用 `createHighlighterCoreSync` 同步创建，渲染时不需要等待；语法颜色用 Shiki 内置的 Catppuccin Mocha 主题，代码块因此统一是深色底（`code-background`），底色、正文和语言标签走 Code token，取值与主题的 base、text、subtext0 一致；Shiki 给 `pre` 的内联背景不使用，没高亮的代码块也是同样的深色。没有用 `shiki-codegen`：它生成的是按需异步加载语言的版本，并要求指定内置主题。没有用 highlight.js：它更小（五种语言约 15KB gzip），但语法规则不如 Shiki 准确。Shiki 使这一组件约增加 100KB gzip。没有采用 Streamdown：它的组件自带 Tailwind 样式和原始颜色，默认渲染原始 HTML；本组件只取它同样使用的 remend。也没有采用 rehype-harden：它拦截后输出带英文和灰色 class 的占位，改用组件内的链接与图片映射。`remark-math-extended` 是 remark-math 的分叉，换回上游时需要另外处理 `\(…\)`、`\[…\]`。调用方可以传 `renderLink` 处理非外部地址的链接，学习页用它把课程里的 `repa:concept/…` 渲染成打开概念卡的按钮；传了 `renderLink` 时 `repa:` 地址不经 react-markdown 的默认地址清理，其他地址照旧清理，外部链接仍只认 http、https 和 mailto。

只有明确需求超出现有组件契约时才扩展。新增源码后检查尺寸 token、状态独立性、可访问名称与对比度；不要因为上游提供了某个组件或 token 就全部引入。

## 界面文字

界面上给人看的文字放在 `../../strings/zh-CN.ts`，组件用 `t("键")` 引用，要改一句话只改这个文件。

- 键名是 `区域.对象.用途`，比如 `settings.commandPolicy.title`；含义相同的跨页面文字放 `common`。`{name}` 由调用处传入，键和参数都由类型检查。
- 文字由人书写。Agent 新增元素时加键，值写 `〔待写〕`，不写内容。
- `npm run lint` 报出组件里的字面量（开发用标记在上一行写 `// ui-text: ignore 原因`），并列出所有占位。打桌面包前用 `--no-placeholders` 运行，有占位就失败。
- 学习内容、辅导回答和后端返回的说明不放在这里。

## 验证

在仓库根目录运行：

```sh
npm run check --workspace=@repa/web
npm run test --workspace=@repa/web
npm run build --workspace=@repa/web
```

通过主应用验证交互。主题颜色配对和组件行为的测试在 `apps/web/test/design-system.test.tsx`，五种跨页面行为在 `apps/web/test/base-behaviors.test.tsx`。

## Sidebar 接入

Sidebar、Sheet 与 useIsMobile 于 2026-09-16 从 shadcn 官方 `new-york-v4` registry 引入，沿用本目录的 MIT 许可：

- [Sidebar 原始源码](https://ui.shadcn.com/r/styles/new-york-v4/sidebar.json)
- [Sheet 原始源码](https://ui.shadcn.com/r/styles/new-york-v4/sheet.json)
- [useIsMobile 原始源码](https://ui.shadcn.com/r/styles/new-york-v4/use-mobile.json)

按实际使用保留 Provider、布局、菜单、子菜单和 Rail 组合，未引入无调用方的附件组件。底层用 Base UI 的 `useRender`，Sheet 用 Base UI Dialog。

本地适配：sidebar 色彩映射到既有 token；菜单标签单行截断，触控尺寸使用现有 token；链接使用 `aria-current`，当前项通过背景和加粗呈现。桌面收起改用官方 `collapsible="icon"` 图标栏，宽度由 `--button-md-height + --space-16` 派生，折叠时菜单按钮收敛为 40px 图标盒并水平居中，并预留 1px 边框（默认透明、当前项为 `border-selected`）作为非颜色选中线索；菜单按钮 `overflow-hidden`、内距与容器宽度按同一时长过渡，子菜单在图标栏中隐藏，与上游一致。文字用 `sr-only` 保留名称、`title` 补鼠标标签，未引入 Tooltip。移动端保留官方 Sheet 结构，移动宽度最多 320px 并保留关闭遮罩区域。没有引入上游的 cookie；Provider 增加受控的 `width`/`onWidthChange`，与 `open`/`onOpenChange` 一样可由外部保存，受控宽度超出 200–480 px 时按允许范围显示。快捷键不拦截输入控件；`inert` 只用于 offcanvas，折叠栏图标仍可键盘到达；补充移动导航关闭时的触发器焦点恢复与跨断点状态清理。菜单按钮默认不提交表单。Rail 保留上游的点击切换与悬停竖线，改用中性 `border` 色、`md:flex` 和中文标签，支持拖动改宽、点击切换与双击重置；方向键调整宽度，Home 恢复默认值。
