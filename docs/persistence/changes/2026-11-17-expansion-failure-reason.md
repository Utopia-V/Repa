learning-building 7aa45564f0db14c7
不升版本：`last.failure` 新增可选字段 `failure`，后台展开的模型请求失败时记下底座给的分类（`ModelFailureSchema` 的六个值），学习页据此说明原因。没有这个字段的旧记录照常读出，学习页只给出原文、不说原因。带新字段的 `building.json`，旧版本会以 schema 错误拒绝加载，而不是读错。
