plugin-manifest 0fa04cc9abb82bfc
不升版本：baseVersion 由必填改为可选。写了照旧检查底座版本是否满足；没写就不检查，不兼容时插件带着实际的错误失败。旧清单都写了这个字段，新版本照旧读取；不写 baseVersion 的新清单在旧版本上被拒绝加载，不会被读错。
