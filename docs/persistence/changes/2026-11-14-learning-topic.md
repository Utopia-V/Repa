learning-topic ff63be80e82ebcfa
不升版本：topic 文件第一次登记为持久格式，与 learning-course 同一原因。与此前随包课程用的格式相比只放宽了一处：题目的 `kind` 由六个固定取值改为课程自定的标签（小写字母、数字和连字符），它不进题目版本，也不参与出题和判分。此前写下的 topic 仍然合格；用了新标签的 topic，旧版本会以 schema 错误拒绝加载，而不是读错。
