learning-topic 771812e7ea16bdbe
不升版本：`verified` 段记录的 `scope` 新增取值 `question-lesson-v1`，标明这条记录是看着所属知识点的讲解、对全部由程序判分的作答位独立再解的证明，哈希绑定题面、判分定义、数据和讲解，由应用里的 `course_confirm` 写入。已有的 `question-runtime-v1` 与无 `scope` 的记录照旧读取，含义不变。带新取值的 topic 文件，旧版本会以 schema 错误拒绝加载，而不是读错。
