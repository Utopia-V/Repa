# 持续学习与实际反馈

`@repa/learning` 提供 `guide-learning` 与 `learn-with-feedback` 两个 Pi Skill。你可以从一个问题开始，Agent 用 `learn-with-feedback` 按当前需要讲解与反馈。当你给出较长期的目标时，`guide-learning` 再维护整体路线，把局部教学和后续安排接起来。

方法通过普通文档保存路线、活动材料与实际记录，再把下一次需要的重点和入口维护到学习语境中。时间检查和可选的 FSRS 估计使用已有能力。因此，包本身只需要提供方法及按需读取的参考文件，长期内容仍由空间持有。

官方默认以 `repa-teaching` 加载本包。关闭这一项会移除两个方法，保留已有学习内容。方法正文见 [guide-learning](skills/guide-learning/SKILL.md) 和 [learn-with-feedback](skills/learn-with-feedback/SKILL.md)，默认启用、替换方式和验证范围见[官方学习组合](../../docs/development/official-learning.md)。
