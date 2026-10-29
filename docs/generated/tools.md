<!-- 由 scripts/docs/gen-tools.ts 生成，不要手改。 -->

# 模型看到的工具

## ask_user

来源：底座内置。

向用户提出 1–4 个问题，等用户在界面上作答，回答原样作为工具结果交回。用于需要用户决定、选择或澄清的地方。用户可以不按卡片作答而回一句话，也可以关掉询问。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| questions[] | object | 否 |  |
| questions[].allowOther | boolean | 是 | 有选项时允许用户自填，默认允许 |
| questions[].header | string | 是 | 很短的标签 |
| questions[].id | string | 是 | 可选的问题标识 |
| questions[].input | "text" &#124; "longText" &#124; "number" | 是 | 没有选项时的输入方式，默认 text |
| questions[].multiple | boolean | 是 | 有选项时允许多选 |
| questions[].options[] | object | 是 | 嵌套对象，字段见源码 |
| questions[].question | string | 否 | 问题，Markdown |

## bash

来源：底座内置。

Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| command | string | 否 | Shell command to execute |
| timeout | number | 是 | Timeout in seconds (optional, no default timeout) |

## edit

来源：底座内置。

Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| edits[] | object | 否 | One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead. |
| edits[].newText | string | 否 | Replacement text for this targeted edit. |
| edits[].oldText | string | 否 | Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call. |
| path | string | 否 | Path to the file to edit (relative or absolute) |

## find

来源：底座内置。

Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first).

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| limit | number | 是 | Maximum number of results (default: 1000) |
| path | string | 是 | Directory to search in (default: current directory) |
| pattern | string | 否 | Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts' |

## grep

来源：底座内置。

Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars.

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| context | number | 是 | Number of lines to show before and after each match (default: 0) |
| glob | string | 是 | Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts' |
| ignoreCase | boolean | 是 | Case-insensitive search (default: false) |
| limit | number | 是 | Maximum number of matches to return (default: 100) |
| literal | boolean | 是 | Treat pattern as literal string instead of regex (default: false) |
| path | string | 是 | Directory or file to search (default: current directory) |
| pattern | string | 否 | Search pattern (regex or literal string) |

## learning_read

来源：learning。

按版本引用批取讲解、例题、KP、概念卡或已开放题解。最多 8 个引用；offset/limit 指定内容块范围，实际返回可能受 16 KiB 预算缩短。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| limit | integer | 是 |  |
| offset | integer | 是 |  |
| refs[] | object | 否 |  |
| refs[].courseId | string | 否 |  |
| refs[].id | string | 否 |  |
| refs[].kind | "topic" &#124; "kp" &#124; "lesson" &#124; "example" &#124; "card" &#124; "explanation" | 否 |  |
| refs[].kpId | string | 是 |  |
| refs[].topicId | string | 否 |  |
| refs[].version | string | 否 |  |

## learning_search

来源：learning。

搜索当前任务与已学内容，返回可用于即时回顾的版本引用和原学习位置；默认 10 项，最多 20 项。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| limit | integer | 是 |  |
| offset | integer | 是 |  |
| query | string | 否 |  |

## learning_task

来源：learning。

读取当前任务画面、练习的公开题面、已接受原答及已释放反馈。text 是 JSON 的片段，offset/limit 按 Unicode 字符计数；默认 2000、最多 3000 字符，按 total 继续读取，version 变化后重新从 0 开始。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| limit | integer | 是 |  |
| offset | integer | 是 |  |

## ls

来源：底座内置。

List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| limit | number | 是 | Maximum number of entries to return (default: 500) |
| path | string | 是 | Directory to list (default: current directory) |

## read

来源：底座内置。

Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| limit | number | 是 | Maximum number of lines to read |
| offset | number | 是 | Line number to start reading from (1-indexed) |
| path | string | 否 | Path to the file to read (relative or absolute) |

## save_note

来源：notes。

把一段文字保存为命名笔记。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| name | string | 否 |  |
| text | string | 否 |  |

## subagent

来源：底座内置。

启动一个子 Agent 独立完成任务，返回它的最终回复。子 Agent 看不到当前对话，task 里要写清它需要的信息。一条回复里起的几个子 Agent 同时运行。可以启动的子 Agent：<br>- general：通用 Agent，工具与你相同，适合交给它独立完成的调研、修改和多步任务

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| agent | "general" | 否 |  |
| task | string | 否 | 交给子 Agent 的完整任务 |

## write

来源：底座内置。

Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| content | string | 否 | Content to write to the file |
| path | string | 否 | Path to the file to write (relative or absolute) |
