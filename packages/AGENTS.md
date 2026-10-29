# 包的约定

这些约定用于保持包边界清楚，背景见[文档纪律提案](../.agents/notes/proposed/process/2026-10-29-docs-discipline.md#仓库结构的约定)。

- 每个包都有 `package.json`、`README.md`、`src/` 和 `test/`。
- README 按[文档规则的骨架](../docs/AGENTS.md#包-readme-骨架)写，用法和约定由所属包持有。
- 只在边界真实存在时拆包：定义、实现和使用方各自独立演化时才拆；同时有 Node 和浏览器两个入口不构成拆包理由。
- 新包要有现在的使用方，不能为假想用途预先拆包。
