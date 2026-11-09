# Repa UI 设计规范

## 设计原则

- 规范定义语义，主题映射视觉值，通用组件实现规则，业务组件组合使用。
- 基础组件统一实现视觉与交互，业务组件映射业务状态，页面负责布局、响应式和组合。页面不得覆盖基础组件的颜色、圆角、字号或交互状态；通用变化必须回到基础组件。
- 业务组件不得直接使用色值或主题私有变量；字号、行高、圆角和留白必须引用 token。
- 相同语义使用相同 token；不同语义不得因当前视觉值相同而互换。
- 规范收敛期间不扩充 token；新增需求先用现有语义和组件表达。确有无法表达的需求时，先明确使用范围并修订规范，再新增 token。
- 组件尺寸由 size 决定，层级由 variant 决定，状态不改变几何尺寸；文字放大或换行时允许组件增长。

## 色彩与 Token

| 层 | 语义 token | 允许使用范围 |
| --- | --- | --- |
| Brand / Interaction | `primary` / `primary-foreground` | 仅主要行动与其内容；不得表达完成或错误。当前主题映射到前景色实底 |
| Brand / Interaction | `accent` / `accent-foreground` | 用于当前导航项和轻量强调背景；持续选择背景由基础组件定义 |
| Brand / Interaction | `fluid-accent` | 键盘焦点和文字选区的强调色，当前为 Sky |
| Interaction | `hover` / `active` / `selected` | 组件的悬浮、按下和选中填充 |
| Surface | `background` | 页面画布 |
| Surface | `card` | 独立内容容器 |
| Surface | `surface-1` 至 `surface-8` | 逐层抬高的表面，与同级阴影配对，由基础组件选择 |
| Surface | `muted` | 降低视觉优先级的区域 |
| Surface | `surface-inset` | 父容器中的内嵌内容 |
| Text | `foreground` / `card-foreground` | 正常文字，后者明确卡片内容的配对关系 |
| Text | `muted-foreground` | 辅助说明与 metadata；仍须满足对比度 |
| Border | `border` / `border-selected` / `border-error` | 分别仅用于普通容器、持续选择、错误边界 |
| Border | `input` | 输入控件的可辨识边界，对卡片至少 3:1。组件库原样是 12% 的发丝线（约 1.3:1），这里按对比度要求加深，组件结构不变 |
| Border | `input-focus` | 输入框聚焦时加深的边界 |
| Border | `ring` / `focus-ring` | 仅键盘焦点；不得表达选中、hover 或业务状态 |
| Status | `status-complete` | 完成提示 |
| Status | `destructive` | 仅危险操作或错误；必须辅以明确文字或图标 |
| Code | `code-background` / `code-foreground` / `code-caption` | 仅代码块：深色底、代码正文和语言标签。语法颜色例外地由 Catppuccin Mocha 主题提供，不另设 token；主题颜色在 `code-background` 上均满足正文对比度 |

语义职责不同的 token 不因当前颜色相同而互换。主题可将 `status-complete` 映射到 `primary`，但完成状态的调用方必须使用 `status-complete`。所有背景与前景配对必须通过对比度验证。

`accent` / `accent-foreground` 是否用于持续选择背景由基础组件定义，业务层不得自行组合 selected + accent。active navigation 表示当前导航位置，不等于鼠标按下的 Active 状态。

主题私有变量不得用于组件样式。

## 排版

字号与行高成对使用，共六个角色。界面用 Inter，中文用 Noto Sans SC，代码用 JetBrains Mono，都随应用打包。

| 角色 | 字号 / 行高 | 用途 |
| --- | --- | --- |
| `display` | 28 px / 34 px | 页面标题 |
| `title` | 16 px / 22 px | 区块标题、对话框标题 |
| `subtitle` | 14 px / 20 px | 卡片标题、强调行 |
| `body` | 13 px / 20 px | 控件标签、界面文字 |
| `caption` | 12 px / 16 px | 说明、metadata、错误 |
| `micro` | 11 px / 14 px | 键帽、计数，只用于单行 |
| Code | 13 px / 20 px | 代码框和代码块 |

字重三档：`weight-normal` 正文，`weight-semibold` 标题和选中项，`weight-bold` 只用于 display。不用字距和全大写。文字颜色只用前景色和辅助色，不用它们的透明度。Markdown 放在 `.typeset` 里排版，正文 15 px / 27 px。

## 间距与圆角

### 间距

留白使用 4 px 为单位的 Tailwind 间距尺度，不使用任意间距值。Card 默认内距 16 px。

间距用于 margin、padding 和 gap，不替代边框厚度、图标尺寸或拓扑坐标。侧栏宽度造成的内容位移属于布局尺寸，不是留白。窄屏将内容折为单列，内容弹窗转为底部抽屉；导航侧栏使用侧边 Sheet，保留遮罩、关闭入口和焦点管理。

### 圆角

| 形状 | 值 | 用途 |
| --- | --- | --- |
| 控件 | 8 px | Button、Input、列表行 |
| 容器 | 12 px | Card、Dialog、Banner |
| 对话输入框 | 16 px | 消息输入框的外框 |
| 圆形 | 9999 px | Radio、Switch 轨道 |

业务组件不得自行定义新的圆角值。

## 组件

| 组件 | 用途与调用约束 |
| --- | --- |
| Primary (`primary`) | 当前操作区的主要行动 |
| Secondary (`secondary`) | 辅助行动，视觉优先级低于主按钮 |
| Tertiary (`tertiary`) | 需要可见操作边界的普通操作，不用于传递状态 |
| Ghost (`ghost`) | 工具栏或内容内的轻量操作，不显示常驻背景或边框，不用于传递状态 |
| Destructive (`destructive`) | 删除等危险操作；文案明确结果，不只依赖颜色 |
| Card | 独立内容容器；本身不假装可点击 |
| RowButton / SelectionButton | 占满一行、可放多个元素的列表按钮；SelectionButton 表示持续选择，使用 `aria-pressed` 和勾选标记 |
| Input / Select | 文本输入或统一主题的选项选择；使用可见 label；选项弹层使用统一主题 |
| Checkbox / RadioGroup / Switch | 分别处理独立多选、互斥选择、即时启停 |
| Badge | 简短分类或状态，`solid` 和 `dot` 两种形态 |
| StatusNotice | 已完成或错误反馈，通过 `status` 表明业务语义，内置图标和 live region |
| Progress | 有确定进度的任务，同时向辅助技术提供数值 |
| Dialog | 需要暂时集中处理的短任务；要求标题、描述，支持 Escape、焦点约束和关闭后恢复焦点 |
| Sheet | 从视口边缘打开的面板；移动导航使用侧边形态，要求标题、关闭入口、Escape、焦点约束和关闭后恢复焦点 |
| ConversationMessage | 用户与助手消息，由 `sender` 选择呈现；发送者差异不是成功/失败状态 |

所有普通 Button 默认 `type="button"`；提交表单必须显式指定 `type="submit"`。组件不使用任何单侧加粗彩色装饰条。

同一操作区最多一个 Primary Button。操作区指共同完成一个任务的一组操作，例如一个表单的提交区或一个 Dialog 的底部操作区。Disabled 是状态，不是 variant。

### 基础组件调用边界

业务层（业务组件、页面和 feature）不得通过 `className` 覆盖基础组件的 variant、color、border / ring、radius、shadow、typography 或 interaction state。`className` 仅用于布局、定位、响应式和基础组件明确允许的 composition spacing；响应式前缀不豁免上述限制。

composition spacing 指组件之间的外部间距、组合容器的 gap，或基础组件契约明确开放的间距；不包括任意改写控件内部 padding。

Card 默认内距由基础组件持有。紧凑型 Card 必须由基础组件提供明确的 size / variant；业务层不得通过 `className` 自行修改 Card 内距，也不得通过页面 CSS 间接覆盖。此规则不要求新增紧凑型 Card。

禁止 `<Button className="rounded-xl bg-indigo-700" />`。视觉变化应修改 Button variant、token 或基础组件实现。

### 边框规格

| 组件 | 边框 |
| --- | --- |
| 普通 Card、Dialog 等表面 | 无描边，用同级 surface 阴影 |
| Input / Select 触发器 | 1 px `input` |
| 对话回复 | 1 px `border` |
| Tertiary Button | 1 px `border` |
| Checkbox / Radio 未选中 | 1.5 px `input` |
| 主按钮、次按钮 | 无常驻可见边框 |

### 尺寸

- 控件两档高度：默认 36 px，紧凑 28 px，由 `FluidProvider` 或组件的 `size` 决定。图标 16 px。
- Button size 为 `default`、`compact`、`icon`、`icon-compact`。文字不换行，按钮宽度随内容增长；需要换行或多个元素时用 RowButton。
- 移动端 Input 使用 16 px，不限制浏览器缩放。
- 卡片高度随内容变化。Dialog 宽度由 `size` 决定（默认 540 px），高度受视口约束，长内容内部滚动。

所有 Button variant 共享同一 size 的高度、圆角、字号和内距。Disabled 是状态，不改变尺寸。

## 交互状态

边框负责界定范围，背景负责交互反馈，标记负责选择，焦点环负责键盘位置。

业务与通用组件只使用边框语义，不直接将 `primary`、`destructive`、`status-complete` 或色值作为边框颜色。提示容器可从对应语义派生透明度，不创建组件专用边框色。

- Hover 不新增边框、不改变边框厚度；需要反馈时改变背景。
- Active 不通过边框厚度表达按下。
- Selected：有选中边框的组件保持 1 px，仅将边框颜色切换为 `border-selected`；无选中边框的组件使用明确的选择标记，不为选中状态新增边框。两类组件均须满足下述视觉提示和可访问状态要求。
- Focus 使用独立 1 px `focus-ring`；通过 outline / box-shadow 实现，不参与布局。输入框类控件聚焦时边框加深为 `input-focus`。Selected 与 Focus 可同时存在。
- 下拉选项无常驻边框和内部描边。悬浮或键盘焦点使用背景高亮，不显示独立 ring；选中通过 check、icon、文字或其他明确标记表达，不能只依赖背景，也不强制所有选项采用勾选。

Input 等控件用 border 界定范围，不使用常驻阴影。Card、Dialog、下拉等表面用同级 surface 和阴影建立层级，层级越高阴影越深。焦点 ring 即使通过 box-shadow 实现，也属于焦点提示而非层级阴影。

## 动效

动效用三档弹簧 `spring.fast`（0.08 s）、`spring.moderate`（0.16 s）、`spring.slow`（0.24 s），大的元素用慢的一档，退场用对应的 `exit`。不手写时长。只动 transform 和 opacity。

## 可访问性

- 正文及辅助文字与背景至少满足 WCAG AA 的 4.5:1 对比度；输入边界和焦点等重要非文字提示至少 3:1。
- 重要状态必须有非颜色视觉提示，例如文字、图标或形状；不得以 `aria-*` 属性代替视觉反馈。
- 交互状态必须提供对应的 ARIA 状态；原生控件已提供的状态语义不重复覆盖。自定义控件按角色使用 `aria-pressed`、`aria-selected`、`aria-expanded` 等属性，不混用不同角色的状态。
- placeholder 只提供示例，不承担 label 功能。对话页的消息输入框是例外：它固定在对话记录下方，用途自明，不显示标签，以 `aria-label` 提供名称；错误使用 `aria-invalid` 并通过 `aria-describedby` 关联说明。
- 可交互元素的键盘焦点不得被移除。替换浏览器默认 outline 时必须提供可见焦点提示；普通控件使用 `focus-ring`，下拉选项使用背景高亮并以明确的可见标记独立表示选择。对话输入框（InputGroup）聚焦时边框加深为 `input-focus` 并加阴影，这层阴影只在聚焦时出现，属于焦点提示；框内按钮仍使用 `focus-ring`。
- 模态交互约束焦点在弹层内，支持 Escape 关闭，关闭后恢复到触发入口。
- 系统要求减少动态效果时，CSS 和 Motion 的动画都停止；移动端换行，不缩小正文来塞入布局。

## 应当与禁止

| 应当 | 禁止 |
| --- | --- |
| 使用规定的 Button 名称及对应 variant | 为相同 variant 增加另一套名称 |
| 用边框语义界定范围 | 直接用品牌色、状态基础色或色值绘制边框 |
| 用背景表达交互反馈、用标记表达选择 | 以单侧加粗彩色边框装饰组件 |
| 保持 hover、active、selected 的边框厚度稳定 | 通过改变边框厚度造成尺寸变化 |
| 让独立焦点提示与选择标记同时存在 | 用选择状态代替键盘焦点 |
| 使用现有字号、圆角和间距尺度 | 为单个业务组件自定义视觉值或专用边框色 |
| 用 surface 阴影表达层级 | 给 Input 等控件增加常驻阴影 |

本文长期保留稳定约束：移动端触控目标至少 44 px、控件允许随内容增长、Dialog 不得溢出 viewport。后续新增的具体 CSS、变量接线和实现方式记录到实现文档，不继续扩写本文；现有尺寸与触控规则保留。

实现位置、接入范围和验证入口见[设计系统实现说明](design-system-implementation.md)。
