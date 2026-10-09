---
name: domain-modeling
description: Resolve domain language or relationships when ambiguity materially changes requirements or design, and maintain CONTEXT.md or ADRs when the user asks or a durable decision has actually settled. Skip ordinary terminology discussion.
---

# Domain Modeling

在领域词语、关系、边界或不变量的不同理解会改变产品行为或责任时，结合具体场景、现有工件与实现形成更准确的模型。现有命名是证据，用户拥有最终产品语义。

允许模型自由探索概念及其关系，不为每个近义词建立 canonical vocabulary。已接受且会改变未来解释的含义进入相应责任范围：通用概念可以进入根目录 `CONTEXT.md`，学习等领域内容由所属能力的现有说明持有；确有独立解释需要时，再建立该领域的 context。先更新已有内容，不为预计会有的领域预建文件。工作假设、普通编程概念和只服务当前讨论的例子留在当前上下文。需要创建或调整格式时读取 [CONTEXT-FORMAT.md](CONTEXT-FORMAT.md)。

难以逆转、缺少背景会令人意外且确有取舍的决定可以进入 `docs/adr/`，项目的命名、取舍说明与格式由 [Repa 文档规范](../repa-docs-style/SKILL.md#架构决策)持有。容易从代码、Git 或外部契约恢复的事实不需要另存一份。
