mcp-config 6294e5153540bdf8
不升版本：新格式。`<应用配置目录>/mcp.json` 记下使用者配置的 MCP 服务器，写法是各家 MCP 客户端通行的 `mcpServers`，另有 Repa 的 `disabled` 与 `askBeforeCall` 两个可选字段；别的客户端写的字段原样保留、读取时忽略。没有这个文件时按没有配置服务器处理。
