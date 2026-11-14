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

## course_check

来源：learning。

检查空间里 course/ 的课：逐处列出哪个文件、哪一行、错在哪里、怎样改，错误多时分页。只检查，不改变学习者在学的课。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| offset | integer | 是 | 从第几处问题开始列，默认 0；上一页的末尾会写明下一页的 offset |

## course_use

来源：learning。

检查空间里 course/ 的课，通过以后让学习者改学这一版；没通过就不换，学习者学的仍是上一次换用的那一版。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |

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

按 learning_search 给出的内容编号读取全文，一次最多 8 个。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| ids[] | string | 否 | learning_search 结果里的内容编号 |

## learning_search

来源：learning。

在当前任务和学过的内容里搜索讲解、例题、知识点、概念卡和已开放的题解。每条结果给出内容编号、名称和一段摘录，用 learning_read 按编号读取全文。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| limit | integer | 是 | 最多返回几条，默认 10 |
| offset | integer | 是 | 从第几条结果开始，默认 0 |
| query | string | 否 | 要找的词：概念名、代码片段或知识点编号；空字符串列出全部可读的内容 |

## learning_task

来源：learning。

读取学习者当前的任务：正在读的讲解或例题，或者正在做的题，连同学习者的作答、判分结果和题解。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |

## ls

来源：底座内置。

List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| limit | number | 是 | Maximum number of entries to return (default: 500) |
| path | string | 是 | Directory to list (default: current directory) |

## materials_list

来源：materials。

列出空间 materials/ 下的文件：每个文件的格式和页数（PDF）、张数（幻灯片）或段数（Word 文档），读不出文字的写明原因。第一次列出时要逐个解析文件，之后用缓存。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |

## materials_read

来源：materials。

把一个课件读成文字：PDF 按页、幻灯片（PPTX、PPT）按张、Word 文档（DOCX、DOC）按段，每一块前标出页码、张号或段号，引用出处时照着写。一次最多交回约 40 KB，读不完时结果末尾写明从哪里接着读。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| from | integer | 是 | 从第几页（PDF）、第几张（幻灯片）或第几段（Word 文档）读起，默认 1 |
| path | string | 否 | 相对空间根目录的路径，照 materials_list 列出的写，例如 materials/第一章.pdf |
| to | integer | 是 | 读到第几页、张或段为止（含），默认读到本次能交回的上限 |

## plugin

来源：后端装配，通用 Agent。

管理这个空间的自写插件：list 列出插件及状态，load 加载，unload 卸载。<br>插件文件夹在 .agents/plugins/&lt;id&gt;/，文件夹名就是插件 id。写或改插件之前先读 Skill plugin-authoring，那里有文件夹的写法、模板和常见报错。<br>load 把文件夹当前的内容复制一份，通常要使用者批准，然后导入并打开；这次调用就是结果：成功时插件已生效，列出它的工具和说明，下一次回复就能调用这些工具；失败时给出原因，改好以后再 load。<br>插件已在运行时，load 用新内容替换它。from 为 previous 时让上一次选定的版本重新生效，为 recorded 时让启用记录里的版本重新生效。<br>unload 卸载插件，它的工具从下一次回复起不再出现；文件夹和数据都保留。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| action | "list" &#124; "load" &#124; "unload" | 否 |  |
| from | "folder" &#124; "recorded" &#124; "previous" | 是 | load 取哪个版本，省略时为文件夹当前的内容；unload 不看它 |
| id | string | 是 | 插件 id，load 与 unload 必填 |

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
