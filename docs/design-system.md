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
| Brand / Interaction | `primary` / `primary-foreground` | 仅主要行动、品牌强调与其内容；不得表达完成或错误 |
| Brand / Interaction | `accent` / `accent-foreground` | 用于 hover、active navigation（当前导航项）和轻量强调背景；持续选择背景由基础组件定义 |
| Surface | `background` | 页面画布 |
| Surface | `card` | 独立内容容器 |
| Surface | `muted` | 降低视觉优先级的区域 |
| Surface | `surface-inset` | 父容器中的内嵌内容 |
| Text | `foreground` / `card-foreground` | 正常文字，后者明确卡片内容的配对关系 |
| Text | `muted-foreground` | 辅助说明与 metadata；仍须满足对比度 |
| Border | `border` / `border-selected` / `border-error` / `border-complete` | 分别仅用于普通容器、持续选择、错误、完成边界 |
| Border | `input` | 输入控件的可辨识边界 |
| Border | `ring` | 仅键盘焦点；不得表达选中、hover 或业务状态 |
| Status | `status-complete` / `status-complete-foreground` | 完成提示及实心状态背景上的内容 |
| Status | `destructive` / `destructive-foreground` | 仅危险操作或错误；必须辅以明确文字或图标 |
| Overlay | `overlay` | 模态内容之外的遮罩，配合透明度使用 |

语义职责不同的 token 不因当前颜色相同而互换。主题可将 `status-complete` 映射到 `primary`，但完成状态的调用方必须使用 `status-complete`。所有背景与前景配对必须通过对比度验证。

`secondary` / `secondary-foreground` 仅供基础组件实现 Secondary variant 使用。业务组件不得将其作为额外颜色语义直接消费。Secondary Button 是正式 variant，不是通用业务颜色。

`accent` / `accent-foreground` 是否用于持续选择背景由基础组件定义，业务层不得自行组合 selected + accent。active navigation 表示当前导航位置，不等于鼠标按下的 Active 状态。

`popover` / `popover-foreground` 仅作为浮层组件适配别名；业务代码不得将其视为额外的颜色选择。主题私有变量不得用于组件样式。

## 排版

字号与行高通过成对的 token 使用。标题和导航使用 Plus Jakarta Sans，正文使用 Manrope，代码使用 JetBrains Mono；中文及字体未加载时使用系统字体回退。

| Token | 字号 / 行高 | 用途 |
| --- | --- | --- |
| Display | 48 / 56px | Hero、展示型标题；移动端 36 / 44px |
| H1 | 32 / 40px | 页面主标题 |
| H2 | 24 / 32px | 一级区块标题 |
| H3 | 20 / 28px | 二级区块标题 |
| H4 | 16 / 24px | 小标题、卡片标题 |
| Body Large | 16 / 26px | 主要正文 |
| Body | 14 / 22px | 常规正文、界面文字 |
| Caption | 12 / 18px | 辅助信息、metadata |
| Code | 13 / 20px | 行内代码、代码块 |

字号和行高成对使用，例如 `--type-body-size` 与 `--type-body-line`。Display 仅用于展示区域，不作为普通页面标题。常规正文与控件标签至少 14px（代码使用独立的 Code token）；12px 仅用于辅助信息，不用于正文或控件标签。移动端通过换行和布局适配，不缩小常规正文或标签字号。

## 间距与圆角

### 间距

统一使用 `4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48 / 64px`，分别对应 `--space-4` 至 `--space-64`。Standard Card 默认内距为 `--space-20`。页面和组件留白必须从该尺度选择，不使用任意间距值。

间距 token 用于 margin、padding 和 gap，不替代边框厚度、图标尺寸或拓扑坐标。侧栏宽度造成的内容位移属于布局尺寸，不是留白。窄屏将内容折为单列，内容弹窗转为底部抽屉；导航侧栏使用侧边 Sheet，保留遮罩、关闭入口和焦点管理。

### 圆角

| Token | 值 | 用途 |
| --- | --- | --- |
| `radius-sm` | 4px | 微型元素 |
| `radius-md` | 8px | Button、Input、Card |
| `radius-lg` | 16px | Dialog、大型容器 |
| `radius-full` | 9999px | Badge、Pill、Avatar |

业务组件不得自行定义新的圆角值。底部抽屉可仅在顶部两角使用 `radius-lg`，贴边角为零。

## 组件

| 组件 | 用途与调用约束 |
| --- | --- |
| Primary (`default`) | 当前操作区的主要行动 |
| Secondary (`secondary`) | 辅助行动，视觉优先级低于主按钮 |
| Outline (`outline`) | 需要可见操作边界的普通操作，不用于传递状态 |
| Ghost (`ghost`) | 工具栏或内容内的轻量操作，不显示常驻背景或边框，不用于传递状态 |
| Destructive (`destructive`) | 删除等危险操作；文案明确结果，不只依赖颜色 |
| Card | 独立内容容器；本身不假装可点击 |
| SelectableCard | 可持续选择的内容，使用原生 button 和 `aria-pressed`；内部不得再嵌套交互元素 |
| Input / Select | 文本输入或统一主题的选项选择；使用可见 label；选项弹层使用统一主题 |
| Checkbox / RadioGroup / Switch | 分别处理独立多选、互斥选择、即时启停 |
| Badge | 简短分类或状态；完成状态使用 `complete` variant |
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

Standard Card 默认内距为 `--space-20`。紧凑型 Card 必须由基础组件提供明确的 size / variant；业务层不得通过 `className` 自行修改 Card 内距，也不得通过页面 CSS 间接覆盖。此规则不要求新增紧凑型 Card。

禁止 `<Button className="rounded-xl bg-indigo-700" />`。视觉变化应修改 Button variant、token 或基础组件实现。

### 边框规格

| 组件 | 边框 |
| --- | --- |
| 普通 Card | 1px `border` |
| 选中 Card | 1px `border-selected` |
| Input / Select 触发器 | 1px `input` |
| Dropdown / Dialog / Popover 容器 | 1px `border` |
| 对话回复 | 1px `border` |
| Outline Button | 1px `border` |
| Checkbox / Radio 未选中 | 1px `input` |
| 主按钮、次按钮 | 无常驻可见边框 |

### 尺寸

- 控件规格与 spacing 的留白职责独立。`--control-size` 为桌面默认 36px，窄屏或粗指针环境为 44px；实现为最小高度，内容或字号增大时允许增长。
- `--control-size` 仅用于 Input、Select 等表单控件的默认高度。Button 使用独立的 Button size scale，不继承 `--control-size`。图标为 16px，按钮宽度随内容增长，输入与选择框跟随表单宽度，Select 菜单默认与触发器同宽。
- Button 默认 `size="md"`，另有图标按钮形态；确有密集工具栏需求后再引入紧凑档位。
- `--hit-size` 为桌面至少 24px、移动端至少 44px。Checkbox、Radio、Switch 保留较小视觉尺寸，通过扩展命中区域和可点击标签支持操作；布局须为命中区域留出空间，避免与邻近控件重叠。
- 移动端 Input 使用 16/26px，不限制浏览器缩放。
- 卡片高度随内容变化。Dialog 最大宽度为 `--dialog-max-width`，高度受动态视口约束，长内容内部滚动；移动底部面板考虑安全区。

#### Button Size: `md`

所有 variant（Primary / Secondary / Outline / Ghost / Destructive）共享同一 size 的高度、圆角、字号、字重、左右内距和图标间距。Disabled 是状态，不是独立 variant，不改变尺寸。

| Token | 默认值 |
| --- | --- |
| `--button-md-height` | 40px |
| `--button-md-padding-inline` | 16px（引用 spacing） |
| `--button-md-radius` | 8px（引用 radius） |
| `--button-md-icon-gap` | 8px（引用 spacing） |

字号/行高使用 Body 14/22px，字重统一 600。所有 variant 都预留 1px 边框空间：主按钮、次按钮为透明边框，Outline 只切换为 `border` 色，不造成内容偏移或宽度变化。移动端或粗指针环境最小高度仍为 44px。常规单行按钮为 40px，文字放大或换行时允许增高，不裁切内容。

## 交互状态

边框负责界定范围，背景负责交互反馈，标记负责选择，焦点环负责键盘位置。

业务与通用组件只使用边框语义，不直接将 `primary`、`destructive`、`status-complete` 或色值作为边框颜色。提示容器可从对应语义派生透明度，不创建组件专用边框色。

- Hover 不新增边框、不改变边框厚度；需要反馈时改变背景。Input 不增加 hover 高亮。
- Active 不通过边框厚度表达按下。
- Selected：有选中边框的组件保持 1px，仅将边框颜色切换为 `border-selected`；无选中边框的组件使用明确的选择标记，不为选中状态新增边框。两类组件均须满足下述视觉提示和可访问状态要求。
- Focus 使用独立 2px `ring`；通过 outline / box-shadow 实现，不参与布局。Selected 与 Focus 可同时存在。
- 下拉选项无常驻边框和内部描边。悬浮或键盘焦点使用背景高亮，不显示独立 ring；选中通过 check、icon、文字或其他明确标记表达，不能只依赖背景，也不强制所有选项采用勾选。

普通 Card、Input 及其他非浮层控件通过 surface + border 建立层级，不使用常驻阴影。Dropdown、Dialog、Popover 等真正浮层使用 border + shadow。焦点 ring 即使通过 box-shadow 实现，也属于焦点提示而非层级阴影。

## 可访问性

- 正文及辅助文字与背景至少满足 WCAG AA 的 4.5:1 对比度；输入边界和焦点等重要非文字提示至少 3:1。
- 重要状态必须有非颜色视觉提示，例如文字、图标或形状；不得以 `aria-*` 属性代替视觉反馈。
- 交互状态必须提供对应的 ARIA 状态；原生控件已提供的状态语义不重复覆盖。自定义控件按角色使用 `aria-pressed`、`aria-selected`、`aria-expanded` 等属性，不混用不同角色的状态。
- placeholder 只提供示例，不承担 label 功能；错误使用 `aria-invalid` 并通过 `aria-describedby` 关联说明。
- 可交互元素的键盘焦点不得被移除。替换浏览器默认 outline 时必须提供可见焦点提示；普通控件使用 ring，下拉选项使用背景高亮并以明确的可见标记独立表示选择。
- 模态交互约束焦点在弹层内，支持 Escape 关闭，关闭后恢复到触发入口。
- 减少动态效果的系统偏好应生效；移动端换行，不缩小正文来塞入布局。

## 应当与禁止

| 应当 | 禁止 |
| --- | --- |
| 使用规定的 Button 名称及对应 variant | 为相同 variant 增加另一套名称 |
| 用边框语义界定范围 | 直接用品牌色、状态基础色或色值绘制边框 |
| 用背景表达交互反馈、用标记表达选择 | 以单侧加粗彩色边框装饰组件 |
| 保持 hover、active、selected 的边框厚度稳定 | 通过改变边框厚度造成尺寸变化 |
| 让独立焦点提示与选择标记同时存在 | 用选择状态代替键盘焦点 |
| 使用现有字号、圆角和间距尺度 | 为单个业务组件自定义视觉值或专用边框色 |
| 用浮层阴影表达覆盖关系 | 给普通 Card、Input 增加常驻层级阴影 |

本文长期保留稳定约束：移动端触控目标至少 44px、控件允许随内容增长、Dialog 不得溢出 viewport。后续新增的具体 CSS、变量接线和实现方式记录到实现文档，不继续扩写本文；现有尺寸与触控规则保留。

设计系统的架构取舍见 [ADR 0006](adr/0006-govern-frontend-visuals-through-a-semantic-design-system.md)；实现位置、接入范围和验证入口见[设计系统实现说明](design-system-implementation.md)。
