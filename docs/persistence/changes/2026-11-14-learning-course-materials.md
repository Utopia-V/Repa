learning-course afad8965c50dc09b
不升版本：清单的 `sources` 里一份来源可以写 `file`（空间 `materials/` 里的课件路径）代替 `url`，`url` 由必填改为可选，二者写一个由检查规则 `source_location` 保证。此前写下的清单仍然合格；写了 `file` 的新清单，旧版本会以 schema 错误拒绝加载，而不是读错。
