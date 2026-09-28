# 通用 UI 组件

这些源码属于 Web 的通用组件层。业务组件通过 props 表达意图，不重新实现焦点管理、表单控件或颜色规则。主题和 token 由 `../../globals.css` 持有，语义见[设计系统规范](../../../../../docs/design-system.md)。

## 来源与版本

Button、Badge、Card、Input、Select、Checkbox、RadioGroup、Switch、Progress、Dialog 取自 [shadcn 官方 registry](https://ui.shadcn.com/r/styles/new-york-v4/button.json) 的 `new-york-v4` 源码，获取日期为 2026-09-16，MIT 许可原文保存在 [LICENSE.shadcn.md](LICENSE.shadcn.md)。其他组件的 registry URL 使用同目录下对应的 kebab-case 名称。导入后的源码由本仓库持有，不能无审查覆盖升级。

运行依赖按锁文件固定：Radix UI 1.6.7、Tailwind CSS 与 Vite 插件 4.3.3、class-variance-authority 0.7.1、clsx 2.1.1、tailwind-merge 3.7.0、lucide-react 1.46.0。`components.json` 指定别名和唯一主题文件，遵循 [shadcn CSS variables 主题方式](https://ui.shadcn.com/docs/theming)。

相对上游的适配：统一项目字号/行高、圆角和留白；Button 默认不提交；Badge 增加完成语义；Select 使用主题弹层、选中勾选与无描边的悬浮/键盘背景高亮，支持方向键、Enter 和 Escape；Dialog 使用主题遮罩及中文关闭标签并支持移动端底部展示；Progress 将数值同时传给 Radix 根组件和视觉指示器。焦点 ring 使用不透明语义色，保证辨识度。Tailwind 只引入 theme/utilities，不在已有主应用加载 preflight；`globals.css` 为带 `data-slot` 的组件提供最小基础样式。

## 本地扩展

- `SelectableCard`：持有持续选择和独立键盘焦点的行为；与普通 Card 区分是否可交互。
- `StatusNotice`：接受 `complete` / `error`，统一主题映射、图标及 live region；调用方不选颜色。
- `MessageBubble`：通过 CVA 管理气泡视觉；发送者语义由 `../domain/ConversationMessage` 映射。
- `SelectionButton`：复用 Button 的尺寸和焦点，通过 CVA 统一持续选择及可见标记，图标形态的选中边框也由本组件持有。
- `SearchInput`：组合 Input 与 Button，持有可见 label、搜索图标、清空入口和输入框外观。

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

状态边框仅使用 `border-selected`、`border-error`、`border-complete`，主题映射位于 `globals.css`。普通 Card、Input 和其他非浮层控件取消常驻阴影，浮层保留。焦点统一使用独立 2px `ring`；Select 选项使用背景高亮和明确选择标记，不绘制内部 ring。

通用 CSS 规则由本目录 `styles.css` 持有，只消费 `globals.css` 的 token。业务组合统一位于 `../domain/`，页面不得通过后代选择器覆盖基础控件外观。

Card 根节点统一持有标准内距，Header、Content、Footer 不重复添加水平 padding。`styles.css` 统一响应减少动态效果偏好，覆盖通过 Portal 呈现的浮层。


## Sidebar 接入

Sidebar、Sheet 与 useIsMobile 于 2026-09-16 从 shadcn 官方 `new-york-v4` registry 引入，沿用本目录的 MIT 许可：

- [Sidebar 原始源码](https://ui.shadcn.com/r/styles/new-york-v4/sidebar.json)
- [Sheet 原始源码](https://ui.shadcn.com/r/styles/new-york-v4/sheet.json)
- [useIsMobile 原始源码](https://ui.shadcn.com/r/styles/new-york-v4/use-mobile.json)

按实际使用保留 Provider、布局、菜单、子菜单和 Rail 组合，未引入无调用方的附件组件。使用现有 radix-ui、lucide-react、CVA 和 Button，不新增包依赖。

本地适配：sidebar 色彩映射到既有 token；菜单标签至少 14px、单行截断，触控尺寸使用现有 token；链接使用 `aria-current`，当前项通过背景和加粗呈现。桌面收起改用官方 `collapsible="icon"` 图标栏，宽度由 `--button-md-height + --space-16` 派生，折叠时菜单按钮收敛为 40px 图标盒并水平居中，并预留 1px 边框（默认透明、当前项为 `border-selected`）作为非颜色选中线索；菜单按钮 `overflow-hidden`、内距与容器宽度按同一时长过渡，会话子菜单用 `grid-template-rows` 高度过渡收起并加 `inert`，避免展开时标签换行或子菜单瞬时出现把列表项挤乱。文字用 `sr-only` 保留名称、`title` 补鼠标标签，未引入 Tooltip。移动端保留官方 Sheet 结构，移动宽度最多 320px 并保留关闭遮罩区域。没有引入仅写入而没有消费方的上游 cookie；展开状态只存于内存。快捷键不拦截输入控件；`inert` 只用于 offcanvas，折叠栏图标仍可键盘到达；补充移动导航关闭时的触发器焦点恢复与跨断点状态清理。菜单按钮默认不提交表单。Rail 保留上游的点击切换与悬停竖线，改用中性 `border` 色、`md:flex` 和中文标签，支持拖动改宽、点击切换与双击重置；方向键调整宽度，Home 恢复默认值。
