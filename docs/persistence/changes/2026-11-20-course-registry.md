learning-course-choice 7a91e58b9ae74d56
升版本：与同一天的“不读旧数据”同属 `learning-format` 5，一并发布。`course.json` 改为课的登记 `{ courses: [{ key, location?, bundled?, copy? }] }`：自制课的位置是 `courses/<名>`，随包的课记包内标识，`copy` 是换用过的副本的摘要。此前的 `{ active }` 不再读取。做课的记录随之从 `building.json` 改为按课存的 `building/<键>.json`（记录本身的形状不变）。
