# 通用 UI 组件

这些源码属于 Web 的通用组件层。业务组件通过 props 表达意图，不重新实现焦点管理、表单控件或颜色规则。主题和 token 由 `../../globals.css` 持有，语义见[设计系统规范](../../../../../docs/design-system.md)。

## 来源与版本

Button、Badge、Card、Input、Select、Checkbox、RadioGroup、Switch、Progress、Dialog 取自 [shadcn 官方 registry](https://ui.shadcn.com/r/styles/new-york-v4/button.json) 的 `new-york-v4` 源码，获取日期为 2026-09-16，MIT 许可原文保存在 [LICENSE.shadcn.md](LICENSE.shadcn.md)。其他组件的 registry URL 使用同目录下对应的 kebab-case 名称。导入后的源码由本仓库持有，不能无审查覆盖升级。Textarea 于 2026-10-12 从同一 registry 的 [textarea.json](https://ui.shadcn.com/r/styles/new-york-v4/textarea.json) 引入，供对话输入框使用；同日引入 [input-group.json](https://ui.shadcn.com/r/styles/new-york-v4/input-group.json) 中的 InputGroup、InputGroupAddon 和 InputGroupTextarea，没有调用方的 InputGroupInput、InputGroupButton、InputGroupText 未引入。

运行依赖按锁文件固定：Radix UI 1.6.7、Tailwind CSS 与 Vite 插件 4.3.3、class-variance-authority 0.7.1、clsx 2.1.1、tailwind-merge 3.7.0、lucide-react 1.46.0。`components.json` 指定别名和唯一主题文件，遵循 [shadcn CSS variables 主题方式](https://ui.shadcn.com/docs/theming)。

相对上游的适配：统一项目字号/行高、圆角和留白；Button 默认不提交，Outline 与 Ghost 悬停时只换浅色 `accent` 背景、文字用 `foreground`，按钮上不出现深色 `accent-foreground`；Badge 增加完成语义；Select 使用主题弹层、选中勾选与无描边的悬浮/键盘背景高亮，支持方向键、Enter 和 Escape；Dialog 使用主题遮罩及中文关闭标签并支持移动端底部展示；Progress 将数值同时传给 Radix 根组件和视觉指示器；Textarea 与 Input 一致，去掉常驻阴影，焦点改用 2px `ring`，错误边框使用 `border-error`；`styles.css` 让 textarea 与其他表单控件一样继承字体和文字颜色，不使用浏览器默认的纯黑；Button 以 `asChild` 渲染成链接时去掉浏览器默认的链接颜色和下划线。InputGroup 使用 `card` 背景、`input` 边框和 `radius-lg`，去掉阴影；文本框聚焦时外框不加 2px ring，边框粗细不变、颜色加深为 `input-focus` 并加四周均匀的淡阴影（无偏移，12px 模糊，10% 黑）（规范中的例外），Addon 内按钮保留 ring；Addon 内距改为 spacing scale，点击 Addon 空白处聚焦文本框；按钮直接使用项目 Button。焦点 ring 使用不透明语义色，保证辨识度。Tailwind 只引入 theme/utilities，不在已有主应用加载 preflight；`globals.css` 为带 `data-slot` 的组件提供最小基础样式。

## 本地扩展

- `SelectableCard`：持有持续选择和独立键盘焦点的行为；与普通 Card 区分是否可交互。
- `StatusNotice`：接受 `complete` / `error`，统一主题映射、图标及 live region；调用方不选颜色。
- `MessageBubble`：通过 CVA 管理气泡视觉；发送者语义由 `../domain/ConversationMessage` 映射。`emphasized` 使用 `accent` 轻量强调背景、`foreground` 正文字色：用户消息不是操作，不用 `primary`，避免和发送按钮争夺视觉重心；它是正文而不是品牌强调，所以不用 `accent-foreground`。
- `SelectionButton`：复用 Button 的尺寸和焦点，通过 CVA 统一持续选择及可见标记，图标形态的选中边框也由本组件持有。
- `SearchInput`：组合 Input 与 Button，持有可见 label、搜索图标、清空入口和输入框外观。
- `Markdown`：渲染模型写的 Markdown 与公式，元素样式映射到 token。依赖按锁文件固定：react-markdown 10.1.0、remark-gfm 4.0.1、remark-cjk-friendly 2.3.2、remark-cjk-friendly-gfm-strikethrough 2.3.1、remark-math-extended 6.1.1、rehype-katex 7.0.1、KaTeX 0.16.47（与 rehype-katex 依赖的版本一致，样式表从这里引入）、remend 1.4.0、Shiki 4.4.3（`shiki`、`@shikijs/langs`、`@shikijs/themes`、`@shikijs/rehype`）。代码高亮按 Shiki 文档的细粒度方式引入：`shiki/core`、JavaScript 正则引擎，只带 Python、JavaScript、TypeScript、Bash、JSON 五种语法，用 `createHighlighterCoreSync` 同步创建，渲染时不需要等待；语法颜色用 Shiki 内置的 Catppuccin Mocha 主题，代码块因此统一是深色底（`code-background`），底色、正文和语言标签走 Code token，取值与主题的 base、text、subtext0 一致；Shiki 给 `pre` 的内联背景不使用，没高亮的代码块也是同样的深色。没有用 `shiki-codegen`：它生成的是按需异步加载语言的版本，并要求指定内置主题。没有用 highlight.js：它更小（五种语言约 15KB gzip），但语法规则不如 Shiki 准确。Shiki 使这一组件约增加 100KB gzip。没有采用 Streamdown：它的组件自带 Tailwind 样式和原始颜色，默认渲染原始 HTML；本组件只取它同样使用的 remend。也没有采用 rehype-harden：它拦截后输出带英文和灰色 class 的占位，改用组件内的链接与图片映射。`remark-math-extended` 是 remark-math 的分叉，换回上游时需要另外处理 `\(…\)`、`\[…\]`。

只有明确需求超出现有组件契约时才扩展。新增源码后检查尺寸 token、状态独立性、可访问名称与对比度；不要因为上游提供了某个组件或 token 就全部引入。代码中的 `dark:` 上游类不代表已提供暗色主题，本次只验证当前亮色主题。

## 验证

在仓库根目录运行：

```sh
npm run check --workspace=@repa/web
npm run test --workspace=@repa/web
npm run build --workspace=@repa/web
```

通过主应用验证交互。主题颜色配对和组件行为的测试在 `apps/web/test/design-system.test.tsx`。

## 边框与阴影

状态边框仅使用 `border-selected`、`border-error`、`border-complete`，主题映射位于 `globals.css`。普通 Card、Input 和其他非浮层控件取消常驻阴影，浮层保留。焦点统一使用独立 2px `ring`（InputGroup 文本框例外，见上）；Select 选项使用背景高亮和明确选择标记，不绘制内部 ring。

通用 CSS 规则由本目录 `styles.css` 持有，只消费 `globals.css` 的 token。业务组合统一位于 `../domain/`，页面不得通过后代选择器覆盖基础控件外观。

Card 根节点统一持有标准内距，Header、Content、Footer 不重复添加水平 padding。`styles.css` 统一响应减少动态效果偏好，覆盖通过 Portal 呈现的浮层。


## Sidebar 接入

Sidebar、Sheet 与 useIsMobile 于 2026-09-16 从 shadcn 官方 `new-york-v4` registry 引入，沿用本目录的 MIT 许可：

- [Sidebar 原始源码](https://ui.shadcn.com/r/styles/new-york-v4/sidebar.json)
- [Sheet 原始源码](https://ui.shadcn.com/r/styles/new-york-v4/sheet.json)
- [useIsMobile 原始源码](https://ui.shadcn.com/r/styles/new-york-v4/use-mobile.json)

按实际使用保留 Provider、布局、菜单、子菜单和 Rail 组合，未引入无调用方的附件组件。使用现有 radix-ui、lucide-react、CVA 和 Button，不新增包依赖。

本地适配：sidebar 色彩映射到既有 token；菜单标签至少 14px、单行截断，触控尺寸使用现有 token；链接使用 `aria-current`，当前项通过背景和加粗呈现。桌面收起改用官方 `collapsible="icon"` 图标栏，宽度由 `--button-md-height + --space-16` 派生，折叠时菜单按钮收敛为 40px 图标盒并水平居中，并预留 1px 边框（默认透明、当前项为 `border-selected`）作为非颜色选中线索；菜单按钮 `overflow-hidden`、内距与容器宽度按同一时长过渡，子菜单在图标栏中隐藏，与上游一致。文字用 `sr-only` 保留名称、`title` 补鼠标标签，未引入 Tooltip。移动端保留官方 Sheet 结构，移动宽度最多 320px 并保留关闭遮罩区域。没有引入上游的 cookie；Provider 增加受控的 `width`/`onWidthChange`，与 `open`/`onOpenChange` 一样可由外部保存，受控宽度超出 200–480 px 时按允许范围显示。快捷键不拦截输入控件；`inert` 只用于 offcanvas，折叠栏图标仍可键盘到达；补充移动导航关闭时的触发器焦点恢复与跨断点状态清理。菜单按钮默认不提交表单。Rail 保留上游的点击切换与悬停竖线，改用中性 `border` 色、`md:flex` 和中文标签，支持拖动改宽、点击切换与双击重置；方向键调整宽度，Home 恢复默认值。
