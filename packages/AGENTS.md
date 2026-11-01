# 包的约定

以下约定用于保持包的边界清晰，背景见[文档纪律记录](../.agents/notes/implemented/process/2026-10-29-docs-discipline.md#仓库结构的约定)。

- 每个包均包含 `package.json`、`README.md`、`src/` 和 `test/`。
- README 按[文档规则中的骨架](../docs/AGENTS.md#包-readme-骨架)编写，用法和约定由所属包持有。
- 仅在边界真实存在时拆包：定义、实现和使用方各自独立演化时方可拆分；同时具备 Node 和浏览器两个入口不构成拆包理由。
- 新包须有当前的使用方，不为假想用途预先拆包。
- 新增昂贵边界须同时设计数与上限，断言次数而非耗时，见[代价关卡](../.agents/notes/implemented/process/2026-10-30-cost-gates.md)。
