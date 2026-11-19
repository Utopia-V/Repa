learning-records 264a3223ba686f40
升版本：`learning-format` 由 4 升到 5。去掉旧日志基线 `baseline` 这种事实与任务上的 `rules`；`task` 的 `structure` 改为必有，引用此前的一条 `structure` 事实。测试版没有真实用户，新版本不读、不升级、不迁移此前的数据：格式标记早于 5（测试版的 3、此前开发版的 4）时，学习插件以 `unknown_data_format` 停用并提示删除 `.repa/plugins/learning/` 后重新打开空间，数据一个字节也不动。新建的数据目录直接写 5。在有真实用户之前，改格式都这样做：升版本，旧数据明说不读，不写迁移。
