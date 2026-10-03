# 教学与实际反馈

`@repa/learning` 提供 `learn-with-feedback` Pi Skill。Agent 根据当前目标和材料选择讲解、示范、完整帮助或独立练习，再根据用户实际作答与反馈调整后续帮助。

包只提供方法。内容、学习语境和复习记录使用 Repa 的已有工具保存，生成题目本身不算用户完成练习。官方默认以 `repa-teaching` 加载本包，关闭这一项会移除方法，保留已有学习内容。

方法正文见 [learn-with-feedback](skills/learn-with-feedback/SKILL.md)，默认启用、替换方式和当前验证范围见[官方学习组合](../../docs/development/official-learning.md)。
