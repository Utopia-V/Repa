# Desktop 通用 UI 组件

Desktop 主应用和侧栏使用 Web 已适配的 Button、Card、StatusNotice、Sheet、Sidebar 及其主题。组件源码在本目录由 Desktop 持有；上游来源、许可和具体适配记录见 [Web 通用组件说明](../../../../../../web/src/components/ui/README.md) 与本目录的 [shadcn 许可](LICENSE.shadcn.md)。复制时以 Web 当前实现为基准，Desktop 的差异只涉及宿主连接、Memory Router 和窗口外壳。

主题值在 `../../globals.css`，通用 CSS 在 `styles.css`。业务组件通过 props 表达状态，布局层不覆盖基础组件的颜色、尺寸或交互状态。两端后续修改共同视觉规则时，应核对对应组件；出现稳定的共同调用契约后再评估提取共享包。
