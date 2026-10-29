<!-- 由 scripts/docs/gen-persistence.ts 生成，不要手改。 -->

# 持久格式

## session-parent

文件：<空间>/.repa/sessions/<会话 id>.parent.json。

负责的包：@repa/base。

版本标记：<空间>/.repa/format.json。

schema：packages/base/src/schema.ts#SessionParentSchema；SHA-256 前 16 位：3d399c4db9c7ad1a。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| callId | string | 否 |  |
| runId | string | 否 |  |
| sessionId | string | 否 |  |

## history-source

文件：<空间>/.repa/history.git（Git 提交消息）。

负责的包：@repa/space-history。

版本标记：<空间>/.repa/format.json。

schema：packages/space-history/src/schema.ts#SourceSchema；SHA-256 前 16 位：4fd83ee1e6b7ba61。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object &#124; object &#124; object &#124; object &#124; object | 否 |  |
| $（变体 1） | object &#124; object &#124; object | 否 |  |
| $（变体 1）（变体 1） | object &#124; object | 否 |  |
| $（变体 1）（变体 1）（变体 1） | object | 否 |  |
| $（变体 1）（变体 1）（变体 1）.ancestorRunIds | Array&lt;string&gt; | 是 |  |
| $（变体 1）（变体 1）（变体 1）.ancestorRunIds[] | string | 否 |  |
| $（变体 1）（变体 1）（变体 1）.kind | "agent" | 否 |  |
| $（变体 1）（变体 1）（变体 1）.runId | string | 否 |  |
| $（变体 1）（变体 1）（变体 2） | object | 否 |  |
| $（变体 1）（变体 1）（变体 2）.kind | "plugin" | 否 |  |
| $（变体 1）（变体 1）（变体 2）.pluginId | string | 否 |  |
| $（变体 1）（变体 2） | object | 否 |  |
| $（变体 1）（变体 2）.kind | "external" | 否 |  |
| $（变体 2） | object | 否 |  |
| $（变体 2）.kind | "undo" | 否 |  |
| $（变体 2）.revision | string | 否 |  |
| $（变体 3） | object | 否 |  |
| $（变体 3）.kind | "undo" | 否 |  |
| $（变体 3）.runId | string | 否 |  |

## app-settings

文件：<应用配置目录>/settings.json。

负责的包：@repa/base。

版本标记：无独立版本标记。

schema：packages/base/src/schema.ts#SettingsSchema；SHA-256 前 16 位：c3263cf294fcf89f。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| commandPolicy | "ask" &#124; "fullAccess" | 否 |  |
| commandPolicy（变体 1） | "ask" | 否 |  |
| commandPolicy（变体 2） | "fullAccess" | 否 |  |
| prompts | object | 否 |  |
| prompts[^.*$] | object | 是 |  |
| prompts[^.*$].enabled | boolean | 是 |  |
| prompts[^.*$].text | string | 是 |  |
| recentSpaces | Array&lt;string&gt; | 否 |  |
| recentSpaces[] | string | 否 |  |

## learning-records

文件：<空间>/.repa/plugins/learning/records.jsonl。

负责的包：@repa/learning。

版本标记：<空间>/.repa/plugins/learning/format.json。

schema：packages/learning/src/records-schema.ts#RecordSchema；SHA-256 前 16 位：59e4f9eda6457388。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object &#124; object &#124; object &#124; object &#124; object &#124; object &#124; object | 否 |  |
| $（变体 1） | object | 否 |  |
| $（变体 1）.at | integer | 否 |  |
| $（变体 1）.digest | string | 否 |  |
| $（变体 1）.seq | integer | 否 |  |
| $（变体 1）.snapshot | object | 否 |  |
| $（变体 1）.snapshot.course | object | 否 |  |
| $（变体 1）.snapshot.course.id | string | 否 | 名字以字母开头，只用字母、数字、下划线和连字符 |
| $（变体 1）.snapshot.course.language | string | 否 |  |
| $（变体 1）.snapshot.course.license | string | 否 |  |
| $（变体 1）.snapshot.course.retiredIds | Array&lt;string &#124; string &#124; string&gt; | 是 |  |
| $（变体 1）.snapshot.course.retiredIds[] | string &#124; string &#124; string | 否 |  |
| $（变体 1）.snapshot.course.retiredIds[]（变体 1） | string | 否 | topic id 只用小写字母和数字，以字母开头，例如 py17 |
| $（变体 1）.snapshot.course.retiredIds[]（变体 2） | string | 否 | 知识点 id 写成 &lt;topic id&gt;.k&lt;数字&gt;，例如 py17.k1 |
| $（变体 1）.snapshot.course.retiredIds[]（变体 3） | string | 否 | 题目 id 写成 &lt;知识点 id&gt;.&lt;小写字母&gt;&lt;数字&gt;，例如 py17.k1.q1 |
| $（变体 1）.snapshot.course.runtime | object | 否 |  |
| $（变体 1）.snapshot.course.runtime.packages | object | 否 |  |
| $（变体 1）.snapshot.course.runtime.packages[^[a-z][a-z0-9_-]*$] | string | 是 |  |
| $（变体 1）.snapshot.course.runtime.prelude | string | 是 |  |
| $（变体 1）.snapshot.course.runtime.pyodide | string | 否 |  |
| $（变体 1）.snapshot.course.runtime.python | string | 否 |  |
| $（变体 1）.snapshot.course.sources | object | 否 |  |
| $（变体 1）.snapshot.course.sources[^[A-Za-z][A-Za-z0-9_-]*$] | object | 是 |  |
| $（变体 1）.snapshot.course.sources[^[A-Za-z][A-Za-z0-9_-]*$].author | string | 是 |  |
| $（变体 1）.snapshot.course.sources[^[A-Za-z][A-Za-z0-9_-]*$].license | string | 否 |  |
| $（变体 1）.snapshot.course.sources[^[A-Za-z][A-Za-z0-9_-]*$].note | string | 是 |  |
| $（变体 1）.snapshot.course.sources[^[A-Za-z][A-Za-z0-9_-]*$].permits | Array&lt;"reference" &#124; "adapt" &#124; "code" &#124; "quote"&gt; | 否 |  |
| $（变体 1）.snapshot.course.sources[^[A-Za-z][A-Za-z0-9_-]*$].permits[] | "reference" &#124; "adapt" &#124; "code" &#124; "quote" | 否 |  |
| $（变体 1）.snapshot.course.sources[^[A-Za-z][A-Za-z0-9_-]*$].title | string | 否 |  |
| $（变体 1）.snapshot.course.sources[^[A-Za-z][A-Za-z0-9_-]*$].url | string | 否 | 链接需要以 https:// 开头 |
| $（变体 1）.snapshot.course.sources[^[A-Za-z][A-Za-z0-9_-]*$].version | string | 否 |  |
| $（变体 1）.snapshot.course.summary | string | 是 |  |
| $（变体 1）.snapshot.course.title | string | 否 |  |
| $（变体 1）.snapshot.course.topics | Array&lt;string&gt; | 否 |  |
| $（变体 1）.snapshot.course.topics[] | string | 否 | topic id 只用小写字母和数字，以字母开头，例如 py17 |
| $（变体 1）.snapshot.course.version | string | 否 | 课程版本写成 x.y.z |
| $（变体 1）.snapshot.expected | object | 是 |  |
| $（变体 1）.snapshot.expected.binding | string | 否 |  |
| $（变体 1）.snapshot.expected.values | object | 否 |  |
| $（变体 1）.snapshot.expected.values[^.*$] | Array&lt;object&gt; | 是 |  |
| $（变体 1）.snapshot.expected.values[^.*$][] | object | 否 |  |
| $（变体 1）.snapshot.expected.values[^.*$][][^.*$] | unknown | 是 |  |
| $（变体 1）.snapshot.graph | object | 否 |  |
| $（变体 1）.snapshot.graph.encompassings | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.graph.encompassings[] | object | 否 |  |
| $（变体 1）.snapshot.graph.encompassings[].advanced | string | 否 |  |
| $（变体 1）.snapshot.graph.encompassings[].simple | string | 否 |  |
| $（变体 1）.snapshot.graph.encompassings[].weight | number | 否 |  |
| $（变体 1）.snapshot.graph.prerequisites | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.graph.prerequisites[] | object | 否 |  |
| $（变体 1）.snapshot.graph.prerequisites[].prerequisite | string | 否 |  |
| $（变体 1）.snapshot.graph.prerequisites[].topic | string | 否 |  |
| $（变体 1）.snapshot.graph.topics | Array&lt;string&gt; | 否 |  |
| $（变体 1）.snapshot.graph.topics[] | string | 否 |  |
| $（变体 1）.snapshot.idMap | object | 否 |  |
| $（变体 1）.snapshot.idMap[^.*$] | string | 是 |  |
| $（变体 1）.snapshot.item | object | 否 |  |
| $（变体 1）.snapshot.item.body | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.item.body[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.item.body[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.item.body[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.item.body[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.item.body[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.item.body[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.item.body[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.item.body[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.item.body[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.item.body[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.item.body[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.item.body[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.item.body[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.item.body[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.item.body[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.item.body[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.item.body[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.item.id | string | 否 |  |
| $（变体 1）.snapshot.item.requires | Array&lt;string&gt; | 否 |  |
| $（变体 1）.snapshot.item.requires[] | string | 否 |  |
| $（变体 1）.snapshot.item.slots | Array&lt;object &#124; object &#124; object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.item.slots[] | object &#124; object &#124; object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.id | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.label | string | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.layout | "list" &#124; "row" &#124; "menu" | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.layout（变体 1） | "list" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.layout（变体 2） | "row" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.layout（变体 3） | "menu" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.maxSelected | integer | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.minSelected | integer | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.multiple | boolean | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.options | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.options[] | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.options[].content | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.options[].content[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.options[].content[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.options[].content[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.options[].content[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.options[].content[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.options[].content[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.options[].content[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.options[].content[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.options[].content[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.options[].content[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.options[].content[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.options[].content[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.options[].content[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.options[].content[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.options[].content[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.options[].content[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.options[].content[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.options[].id | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.options[].label | string | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.other | object | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.other.label | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.prompt[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.prompt[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.prompt[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.prompt[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.prompt[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.prompt[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.prompt[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.prompt[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.prompt[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.prompt[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.prompt[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.prompt[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.prompt[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 1）.type | "choice" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.format | string | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.id | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.label | string | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.lines | integer | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.maxLength | integer | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.placeholder | string | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.prompt[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.prompt[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.prompt[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.prompt[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.prompt[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.prompt[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.prompt[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.prompt[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.prompt[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.prompt[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.prompt[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.prompt[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.prompt[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.quick | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.quick[] | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.suffix | string | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 2）.type | "text" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.id | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.indent | integer | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.items | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.items[] | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.items[].content | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.items[].content[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.items[].content[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.items[].content[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.items[].content[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.items[].content[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.items[].content[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.items[].content[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.items[].content[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.items[].content[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.items[].content[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.items[].content[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.items[].content[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.items[].content[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.items[].content[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.items[].content[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.items[].content[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.items[].content[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.items[].id | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.items[].label | string | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.label | string | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.partial | boolean | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.prompt[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.prompt[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.prompt[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.prompt[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.prompt[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.prompt[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.prompt[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.prompt[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.prompt[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.prompt[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.prompt[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.prompt[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.prompt[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 3）.type | "order" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.columns | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.columns[] | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.columns[].header | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.columns[].id | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.id | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.label | string | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.prompt[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.prompt[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.prompt[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.prompt[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.prompt[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.prompt[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.prompt[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.prompt[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.prompt[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.prompt[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.prompt[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.prompt[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.prompt[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.rows | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.rows[] | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.rows[].cells | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.rows[].cells[^.*$] | object &#124; object | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.rows[].cells[^.*$]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.rows[].cells[^.*$]（变体 1）.value | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input | object &#124; object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.format | string | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.lines | integer | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.maxLength | integer | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.quick | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.quick[] | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.type | "text" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.options | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.options[] | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.options[].id | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.options[].label | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.type | "choice" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.rows[].header | string | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.rows[].id | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 4）.type | "table" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.id | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.label | string | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.language | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.maxLines | integer | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.prompt[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.prompt[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.prompt[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.prompt[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.prompt[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.prompt[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.prompt[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.prompt[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.prompt[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.prompt[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.prompt[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.prompt[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.prompt[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.starter | string | 否 |  |
| $（变体 1）.snapshot.item.slots[]（变体 5）.type | "code" | 否 |  |
| $（变体 1）.snapshot.item.title | string | 是 |  |
| $（变体 1）.snapshot.item.version | string | 否 |  |
| $（变体 1）.snapshot.kpId | string | 否 |  |
| $（变体 1）.snapshot.kpVersion | string | 否 |  |
| $（变体 1）.snapshot.questionId | string | 否 |  |
| $（变体 1）.snapshot.questionVersion | string | 否 |  |
| $（变体 1）.snapshot.topic | object | 否 |  |
| $（变体 1）.snapshot.topic.data | object | 是 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$] | object &#124; object | 是 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 1）.caption | string | 是 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 1）.columns | object | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 1）.columns[^.*$] | Array&lt;string &#124; number &#124; boolean &#124; null&gt; | 是 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 1）.columns[^.*$][] | string &#124; number &#124; boolean &#124; null | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 1）.columns[^.*$][]（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 1）.columns[^.*$][]（变体 2） | number | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 1）.columns[^.*$][]（变体 3） | boolean | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 1）.columns[^.*$][]（变体 4） | null | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 1）.dtypes | object | 是 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 1）.dtypes[^.*$] | "float" | 是 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 1）.index | Array&lt;string &#124; number &#124; boolean&gt; | 是 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 1）.index[] | string &#124; number &#124; boolean | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 1）.index[]（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 1）.index[]（变体 2） | number | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 1）.index[]（变体 3） | boolean | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 1）.indexHeader | string | 是 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 1）.kind | "dataframe" | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 1）.name | string | 否 | 需要是合法的 Python 变量名 |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 1）.showIndex | boolean | 是 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 2）.code | string | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 2）.display | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 2）.display（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 2）.display（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 2）.display（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 2）.display（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 2）.display（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 2）.display（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 2）.display（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 2）.display（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 2）.display（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 2）.display（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 2）.display（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 2）.display（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 2）.display（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 2）.display（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 2）.display（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 2）.display（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 2）.display（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 2）.display（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 2）.display（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.data[^[A-Za-z][A-Za-z0-9_-]*$]（变体 2）.kind | "python" | 否 |  |
| $（变体 1）.snapshot.topic.encompassings | Array&lt;object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.encompassings[] | object | 否 |  |
| $（变体 1）.snapshot.topic.encompassings[].topic | string | 否 | topic id 只用小写字母和数字，以字母开头，例如 py17 |
| $（变体 1）.snapshot.topic.encompassings[].weight | number | 否 |  |
| $（变体 1）.snapshot.topic.id | string | 否 | topic id 只用小写字母和数字，以字母开头，例如 py17 |
| $（变体 1）.snapshot.topic.intro | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.intro（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.intro（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.intro（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.intro（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.intro（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.intro（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.intro（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.intro（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.intro（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.intro（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.intro（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.intro（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.intro（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.intro（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.intro（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.intro（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.intro（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.intro（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.intro（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].card | object | 是 |  |
| $（变体 1）.snapshot.topic.kps[].card.aliases | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].card.aliases[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].card.conditions | Array&lt;string&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].card.conditions[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].card.definition | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].card.example | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].card.example.from | string | 否 | 题目 id 写成 &lt;知识点 id&gt;.&lt;小写字母&gt;&lt;数字&gt;，例如 py17.k1.q1 |
| $（变体 1）.snapshot.topic.kps[].card.example.text | string &#124; Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].card.example.text（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].card.example.text（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].card.example.text（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].card.example.text（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].card.example.text（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].card.example.text（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].card.example.text（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].card.example.text（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].card.example.text（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].card.example.text（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].card.example.text（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].card.example.text（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].card.example.text（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].card.example.text（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].card.example.text（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].card.example.text（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].card.example.text（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].card.example.text（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].card.example.text（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].card.name | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example | object | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.body | string &#124; Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.body（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.body（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.body（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.body（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.body（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.body（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.body（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.body（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.body（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.body（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.body（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.body（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.body（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.body（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.body（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.body（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.body（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.body（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.body（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.data | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.data[] | string | 否 | 名字以字母开头，只用字母、数字、下划线和连字符 |
| $（变体 1）.snapshot.topic.kps[].example.explanation | string &#124; Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.explanation（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.explanation（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.explanation（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.explanation（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.explanation（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.explanation（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.explanation（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.explanation（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.explanation（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.explanation（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.explanation（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.explanation（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.explanation（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.explanation（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.explanation（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.explanation（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.explanation（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.explanation（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.explanation（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.id | string | 否 | 题目 id 写成 &lt;知识点 id&gt;.&lt;小写字母&gt;&lt;数字&gt;，例如 py17.k1.q1 |
| $（变体 1）.snapshot.topic.kps[].example.kind | Array&lt;"predict" &#124; "trace" &#124; "debug" &#124; "explain" &#124; "modify" &#124; "specify"&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.kind[] | "predict" &#124; "trace" &#124; "debug" &#124; "explain" &#124; "modify" &#124; "specify" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.manual | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.manual[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.measures | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.measures[] | string | 否 | 知识点 id 写成 &lt;topic id&gt;.k&lt;数字&gt;，例如 py17.k1 |
| $（变体 1）.snapshot.topic.kps[].example.slots | Array&lt;object &#124; object &#124; object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[] | object &#124; object &#124; object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.key | string &#124; Array&lt;string&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.key（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.key（变体 2） | Array&lt;string&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.key（变体 2）[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.layout | "list" &#124; "row" &#124; "menu" | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.maxSelected | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.minSelected | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.multiple | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].content | string &#124; Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].content（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].content（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].content（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].content（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].content（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].content（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].content（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].content（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].content（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].content（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].content（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].content（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].content（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].feedback | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].feedback（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].feedback（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].feedback（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].feedback（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].feedback（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].feedback（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].feedback（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].feedback（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].feedback（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].feedback（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].feedback（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].feedback（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.options[].label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.prompt | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.prompt（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.prompt（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.prompt（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.prompt（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.prompt（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.prompt（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.prompt（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.prompt（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.prompt（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.prompt（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.prompt（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.prompt（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.prompt（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.prompt（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.prompt（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.prompt（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.prompt（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.prompt（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.prompt（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.scoring | "all" &#124; "options" | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 1）.type | "choice" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback | Array&lt;object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].message | string &#124; Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].message（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].message（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].message（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].message（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].message（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].message（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].message（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].message（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].message（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].message（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].message（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].message（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].when | string &#124; number &#124; boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].when（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].when（变体 2） | number | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.feedback[].when（变体 3） | boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.format | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.key | string &#124; number &#124; boolean &#124; Array&lt;string &#124; number &#124; boolean&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.key（变体 1） | string &#124; number &#124; boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.key（变体 1）（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.key（变体 1）（变体 2） | number | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.key（变体 1）（变体 3） | boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.key（变体 2） | Array&lt;string &#124; number &#124; boolean&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.key（变体 2）[] | string &#124; number &#124; boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.key（变体 2）[]（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.key（变体 2）[]（变体 2） | number | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.key（变体 2）[]（变体 3） | boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.lines | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.match | "integer" &#124; "number" &#124; "text" &#124; "output" &#124; "nonempty" | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.maxLength | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.placeholder | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.prompt | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.prompt（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.prompt（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.prompt（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.prompt（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.prompt（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.prompt（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.prompt（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.prompt（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.prompt（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.prompt（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.prompt（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.prompt（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.prompt（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.prompt（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.prompt（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.prompt（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.prompt（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.prompt（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.prompt（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.quick | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.quick[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.rubric | Array&lt;object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.rubric[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.rubric[].guide | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.rubric[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.rubric[].label | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.suffix | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.tolerance | number | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 2）.type | "text" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.alternatives | Array&lt;Array&lt;string&gt;&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.alternatives[] | Array&lt;string&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.alternatives[][] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.indent | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.indents | object | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.indents[^[A-Za-z0-9][A-Za-z0-9._:/-]*$] | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[].code | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[].content | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[].content（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[].content（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[].content（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[].content（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[].content（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[].content（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[].content（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[].content（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[].content（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[].content（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[].content（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[].content（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[].content（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.items[].label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.key | Array&lt;string&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.key[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.partial | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.prompt | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.prompt（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.prompt（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.prompt（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.prompt（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.prompt（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.prompt（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.prompt（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.prompt（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.prompt（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.prompt（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.prompt（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.prompt（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.prompt（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.prompt（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.prompt（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.prompt（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.prompt（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.prompt（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.prompt（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.tests | Array&lt;object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.tests[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.tests[].data | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.tests[].data[] | string | 否 | 名字以字母开头，只用字母、数字、下划线和连字符 |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.tests[].doctest | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.tests[].expect | object | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.tests[].expect[^.*$] | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.tests[].hidden | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.tests[].name | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.tests[].setup | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.tests[].stdout | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 3）.type | "order" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.columns | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.columns[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.columns[].header | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.columns[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.columns[].input | "bool" &#124; "integer" &#124; "text" &#124; object &#124; object | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.columns[].input（变体 1） | "bool" &#124; "integer" &#124; "text" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.columns[].input（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.columns[].input（变体 2）.format | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.columns[].input（变体 2）.lines | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.columns[].input（变体 2）.match | "integer" &#124; "number" &#124; "text" &#124; "output" &#124; "nonempty" | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.columns[].input（变体 2）.maxLength | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.columns[].input（变体 2）.quick | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.columns[].input（变体 2）.quick[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.columns[].input（变体 2）.type | "text" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.columns[].input（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.columns[].input（变体 3）.options | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.columns[].input（变体 3）.options[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.columns[].input（变体 3）.options[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.columns[].input（变体 3）.options[].label | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.columns[].input（变体 3）.type | "choice" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.prompt | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.prompt（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.prompt（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.prompt（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.prompt（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.prompt（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.prompt（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.prompt（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.prompt（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.prompt（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.prompt（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.prompt（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.prompt（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.prompt（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.prompt（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.prompt（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.prompt（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.prompt（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.prompt（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.prompt（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$] | string &#124; number &#124; boolean &#124; object &#124; object | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 1） | string &#124; number &#124; boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 1）（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 1）（变体 2） | number | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 1）（变体 3） | boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.value | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input | "bool" &#124; "integer" &#124; "text" &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 1） | "bool" &#124; "integer" &#124; "text" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.format | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.lines | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.match | "integer" &#124; "number" &#124; "text" &#124; "output" &#124; "nonempty" | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.maxLength | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.quick | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.quick[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.type | "text" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3）.options | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3）.options[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3）.options[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3）.options[].label | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3）.type | "choice" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.key | string &#124; number &#124; boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.key（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.key（变体 2） | number | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.key（变体 3） | boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].header | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.rows[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 4）.type | "table" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.accepts | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.accepts[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.language | "python" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.maxLines | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.prompt | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.prompt（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.prompt（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.prompt（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.prompt（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.prompt（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.prompt（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.prompt（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.prompt（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.prompt（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.prompt（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.prompt（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.prompt（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.prompt（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.prompt（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.prompt（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.prompt（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.prompt（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.prompt（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.prompt（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.rejects | Array&lt;object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.rejects[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.rejects[].code | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.rejects[].why | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.solution | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.starter | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.tests | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.tests[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.tests[].data | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.tests[].data[] | string | 否 | 名字以字母开头，只用字母、数字、下划线和连字符 |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.tests[].doctest | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.tests[].expect | object | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.tests[].expect[^.*$] | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.tests[].hidden | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.tests[].name | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.tests[].setup | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.tests[].stdout | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.slots[]（变体 5）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].example.title | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.uses | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].example.uses[] | string | 否 | 知识点 id 写成 &lt;topic id&gt;.k&lt;数字&gt;，例如 py17.k1 |
| $（变体 1）.snapshot.topic.kps[].example.verify | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].id | string | 否 | 知识点 id 写成 &lt;topic id&gt;.k&lt;数字&gt;，例如 py17.k1 |
| $（变体 1）.snapshot.topic.kps[].keyPrerequisites | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].keyPrerequisites[] | string | 否 | topic id 只用小写字母和数字，以字母开头，例如 py17 |
| $（变体 1）.snapshot.topic.kps[].lesson | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].lesson（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].lesson（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].lesson（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].lesson（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].lesson（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].lesson（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].lesson（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].lesson（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].lesson（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].lesson（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].lesson（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].lesson（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].lesson（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].lesson（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].lesson（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].lesson（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].lesson（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].lesson（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].lesson（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice | Array&lt;object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].body | string &#124; Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].body（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].body（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].body（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].body（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].body（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].body（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].body（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].body（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].body（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].body（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].body（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].body（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].body（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].body（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].body（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].body（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].body（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].body（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].body（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].data | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].data[] | string | 否 | 名字以字母开头，只用字母、数字、下划线和连字符 |
| $（变体 1）.snapshot.topic.kps[].practice[].explanation | string &#124; Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].explanation（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].explanation（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].explanation（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].explanation（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].explanation（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].explanation（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].explanation（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].explanation（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].explanation（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].explanation（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].explanation（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].explanation（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].explanation（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].explanation（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].explanation（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].explanation（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].explanation（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].explanation（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].explanation（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].id | string | 否 | 题目 id 写成 &lt;知识点 id&gt;.&lt;小写字母&gt;&lt;数字&gt;，例如 py17.k1.q1 |
| $（变体 1）.snapshot.topic.kps[].practice[].kind | Array&lt;"predict" &#124; "trace" &#124; "debug" &#124; "explain" &#124; "modify" &#124; "specify"&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].kind[] | "predict" &#124; "trace" &#124; "debug" &#124; "explain" &#124; "modify" &#124; "specify" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].manual | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].manual[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].measures | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].measures[] | string | 否 | 知识点 id 写成 &lt;topic id&gt;.k&lt;数字&gt;，例如 py17.k1 |
| $（变体 1）.snapshot.topic.kps[].practice[].slots | Array&lt;object &#124; object &#124; object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[] | object &#124; object &#124; object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.key | string &#124; Array&lt;string&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.key（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.key（变体 2） | Array&lt;string&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.key（变体 2）[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.layout | "list" &#124; "row" &#124; "menu" | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.maxSelected | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.minSelected | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.multiple | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].content | string &#124; Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].content（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].content（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].content（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].content（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].content（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].content（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].content（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].content（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].content（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].content（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].content（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].content（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].content（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].feedback | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].feedback（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].feedback（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].feedback（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.options[].label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.prompt | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.prompt（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.prompt（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.prompt（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.prompt（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.prompt（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.prompt（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.prompt（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.prompt（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.prompt（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.prompt（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.prompt（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.prompt（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.prompt（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.prompt（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.prompt（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.prompt（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.prompt（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.prompt（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.prompt（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.scoring | "all" &#124; "options" | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 1）.type | "choice" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback | Array&lt;object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].message | string &#124; Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].message（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].message（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].message（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].when | string &#124; number &#124; boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].when（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].when（变体 2） | number | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.feedback[].when（变体 3） | boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.format | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.key | string &#124; number &#124; boolean &#124; Array&lt;string &#124; number &#124; boolean&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.key（变体 1） | string &#124; number &#124; boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.key（变体 1）（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.key（变体 1）（变体 2） | number | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.key（变体 1）（变体 3） | boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.key（变体 2） | Array&lt;string &#124; number &#124; boolean&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.key（变体 2）[] | string &#124; number &#124; boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.key（变体 2）[]（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.key（变体 2）[]（变体 2） | number | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.key（变体 2）[]（变体 3） | boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.lines | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.match | "integer" &#124; "number" &#124; "text" &#124; "output" &#124; "nonempty" | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.maxLength | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.placeholder | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.prompt | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.prompt（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.prompt（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.prompt（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.prompt（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.prompt（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.prompt（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.prompt（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.prompt（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.prompt（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.prompt（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.prompt（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.prompt（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.prompt（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.prompt（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.prompt（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.prompt（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.prompt（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.prompt（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.prompt（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.quick | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.quick[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.rubric | Array&lt;object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.rubric[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.rubric[].guide | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.rubric[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.rubric[].label | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.suffix | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.tolerance | number | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 2）.type | "text" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.alternatives | Array&lt;Array&lt;string&gt;&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.alternatives[] | Array&lt;string&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.alternatives[][] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.indent | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.indents | object | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.indents[^[A-Za-z0-9][A-Za-z0-9._:/-]*$] | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[].code | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[].content | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[].content（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[].content（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[].content（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[].content（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[].content（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[].content（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[].content（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[].content（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[].content（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[].content（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[].content（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[].content（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[].content（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.items[].label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.key | Array&lt;string&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.key[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.partial | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.prompt | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.prompt（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.prompt（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.prompt（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.prompt（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.prompt（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.prompt（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.prompt（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.prompt（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.prompt（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.prompt（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.prompt（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.prompt（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.prompt（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.prompt（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.prompt（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.prompt（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.prompt（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.prompt（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.prompt（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.tests | Array&lt;object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.tests[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.tests[].data | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.tests[].data[] | string | 否 | 名字以字母开头，只用字母、数字、下划线和连字符 |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.tests[].doctest | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.tests[].expect | object | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.tests[].expect[^.*$] | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.tests[].hidden | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.tests[].name | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.tests[].setup | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.tests[].stdout | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 3）.type | "order" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.columns | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.columns[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.columns[].header | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.columns[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.columns[].input | "bool" &#124; "integer" &#124; "text" &#124; object &#124; object | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.columns[].input（变体 1） | "bool" &#124; "integer" &#124; "text" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.columns[].input（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.columns[].input（变体 2）.format | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.columns[].input（变体 2）.lines | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.columns[].input（变体 2）.match | "integer" &#124; "number" &#124; "text" &#124; "output" &#124; "nonempty" | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.columns[].input（变体 2）.maxLength | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.columns[].input（变体 2）.quick | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.columns[].input（变体 2）.quick[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.columns[].input（变体 2）.type | "text" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.columns[].input（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.columns[].input（变体 3）.options | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.columns[].input（变体 3）.options[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.columns[].input（变体 3）.options[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.columns[].input（变体 3）.options[].label | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.columns[].input（变体 3）.type | "choice" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.prompt | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.prompt（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.prompt（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.prompt（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.prompt（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.prompt（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.prompt（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.prompt（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.prompt（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.prompt（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.prompt（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.prompt（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.prompt（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.prompt（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.prompt（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.prompt（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.prompt（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.prompt（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.prompt（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.prompt（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$] | string &#124; number &#124; boolean &#124; object &#124; object | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 1） | string &#124; number &#124; boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 1）（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 1）（变体 2） | number | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 1）（变体 3） | boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.value | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input | "bool" &#124; "integer" &#124; "text" &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 1） | "bool" &#124; "integer" &#124; "text" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.format | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.lines | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.match | "integer" &#124; "number" &#124; "text" &#124; "output" &#124; "nonempty" | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.maxLength | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.quick | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.quick[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.type | "text" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3）.options | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3）.options[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3）.options[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3）.options[].label | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3）.type | "choice" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.key | string &#124; number &#124; boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.key（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.key（变体 2） | number | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.key（变体 3） | boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].header | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.rows[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 4）.type | "table" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.accepts | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.accepts[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.language | "python" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.maxLines | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.prompt | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.prompt（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.prompt（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.prompt（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.prompt（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.prompt（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.prompt（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.prompt（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.prompt（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.prompt（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.prompt（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.prompt（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.prompt（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.prompt（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.prompt（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.prompt（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.prompt（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.prompt（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.prompt（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.prompt（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.rejects | Array&lt;object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.rejects[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.rejects[].code | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.rejects[].why | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.solution | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.starter | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.tests | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.tests[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.tests[].data | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.tests[].data[] | string | 否 | 名字以字母开头，只用字母、数字、下划线和连字符 |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.tests[].doctest | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.tests[].expect | object | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.tests[].expect[^.*$] | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.tests[].hidden | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.tests[].name | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.tests[].setup | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.tests[].stdout | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].slots[]（变体 5）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].title | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].uses | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].practice[].uses[] | string | 否 | 知识点 id 写成 &lt;topic id&gt;.k&lt;数字&gt;，例如 py17.k1 |
| $（变体 1）.snapshot.topic.kps[].practice[].verify | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz | Array&lt;object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].body | string &#124; Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].body（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].body（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].body（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].body（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].body（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].body（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].body（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].body（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].body（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].body（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].body（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].body（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].body（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].body（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].body（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].body（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].body（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].body（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].body（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].data | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].data[] | string | 否 | 名字以字母开头，只用字母、数字、下划线和连字符 |
| $（变体 1）.snapshot.topic.kps[].quiz[].explanation | string &#124; Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].explanation（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].explanation（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].explanation（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].explanation（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].explanation（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].explanation（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].explanation（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].explanation（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].explanation（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].explanation（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].explanation（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].explanation（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].explanation（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].explanation（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].explanation（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].explanation（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].explanation（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].explanation（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].explanation（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].id | string | 否 | 题目 id 写成 &lt;知识点 id&gt;.&lt;小写字母&gt;&lt;数字&gt;，例如 py17.k1.q1 |
| $（变体 1）.snapshot.topic.kps[].quiz[].kind | Array&lt;"predict" &#124; "trace" &#124; "debug" &#124; "explain" &#124; "modify" &#124; "specify"&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].kind[] | "predict" &#124; "trace" &#124; "debug" &#124; "explain" &#124; "modify" &#124; "specify" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].manual | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].manual[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].measures | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].measures[] | string | 否 | 知识点 id 写成 &lt;topic id&gt;.k&lt;数字&gt;，例如 py17.k1 |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots | Array&lt;object &#124; object &#124; object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[] | object &#124; object &#124; object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.key | string &#124; Array&lt;string&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.key（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.key（变体 2） | Array&lt;string&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.key（变体 2）[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.layout | "list" &#124; "row" &#124; "menu" | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.maxSelected | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.minSelected | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.multiple | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].content | string &#124; Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].content（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].content（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].content（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].content（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].content（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].content（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].content（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].content（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].content（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].content（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].content（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].content（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].content（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].feedback | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].feedback（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].feedback（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].feedback（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.options[].label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.prompt | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.prompt（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.prompt（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.prompt（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.prompt（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.prompt（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.prompt（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.prompt（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.prompt（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.prompt（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.prompt（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.prompt（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.prompt（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.prompt（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.prompt（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.prompt（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.prompt（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.prompt（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.prompt（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.prompt（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.scoring | "all" &#124; "options" | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 1）.type | "choice" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback | Array&lt;object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].message | string &#124; Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].message（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].message（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].message（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].when | string &#124; number &#124; boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].when（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].when（变体 2） | number | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.feedback[].when（变体 3） | boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.format | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.key | string &#124; number &#124; boolean &#124; Array&lt;string &#124; number &#124; boolean&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.key（变体 1） | string &#124; number &#124; boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.key（变体 1）（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.key（变体 1）（变体 2） | number | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.key（变体 1）（变体 3） | boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.key（变体 2） | Array&lt;string &#124; number &#124; boolean&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.key（变体 2）[] | string &#124; number &#124; boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.key（变体 2）[]（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.key（变体 2）[]（变体 2） | number | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.key（变体 2）[]（变体 3） | boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.lines | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.match | "integer" &#124; "number" &#124; "text" &#124; "output" &#124; "nonempty" | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.maxLength | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.placeholder | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.prompt | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.prompt（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.prompt（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.prompt（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.prompt（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.prompt（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.prompt（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.prompt（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.prompt（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.prompt（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.prompt（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.prompt（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.prompt（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.prompt（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.prompt（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.prompt（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.prompt（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.prompt（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.prompt（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.prompt（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.quick | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.quick[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.rubric | Array&lt;object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.rubric[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.rubric[].guide | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.rubric[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.rubric[].label | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.suffix | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.tolerance | number | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 2）.type | "text" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.alternatives | Array&lt;Array&lt;string&gt;&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.alternatives[] | Array&lt;string&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.alternatives[][] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.indent | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.indents | object | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.indents[^[A-Za-z0-9][A-Za-z0-9._:/-]*$] | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[].code | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[].content | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[].content（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[].content（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[].content（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[].content（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[].content（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[].content（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[].content（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[].content（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[].content（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[].content（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[].content（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[].content（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[].content（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.items[].label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.key | Array&lt;string&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.key[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.partial | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.prompt | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.prompt（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.prompt（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.prompt（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.prompt（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.prompt（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.prompt（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.prompt（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.prompt（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.prompt（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.prompt（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.prompt（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.prompt（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.prompt（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.prompt（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.prompt（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.prompt（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.prompt（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.prompt（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.prompt（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.tests | Array&lt;object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.tests[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.tests[].data | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.tests[].data[] | string | 否 | 名字以字母开头，只用字母、数字、下划线和连字符 |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.tests[].doctest | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.tests[].expect | object | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.tests[].expect[^.*$] | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.tests[].hidden | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.tests[].name | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.tests[].setup | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.tests[].stdout | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 3）.type | "order" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.columns | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.columns[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.columns[].header | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.columns[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.columns[].input | "bool" &#124; "integer" &#124; "text" &#124; object &#124; object | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.columns[].input（变体 1） | "bool" &#124; "integer" &#124; "text" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.columns[].input（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.columns[].input（变体 2）.format | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.columns[].input（变体 2）.lines | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.columns[].input（变体 2）.match | "integer" &#124; "number" &#124; "text" &#124; "output" &#124; "nonempty" | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.columns[].input（变体 2）.maxLength | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.columns[].input（变体 2）.quick | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.columns[].input（变体 2）.quick[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.columns[].input（变体 2）.type | "text" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.columns[].input（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.columns[].input（变体 3）.options | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.columns[].input（变体 3）.options[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.columns[].input（变体 3）.options[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.columns[].input（变体 3）.options[].label | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.columns[].input（变体 3）.type | "choice" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.prompt | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.prompt（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.prompt（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.prompt（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.prompt（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.prompt（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.prompt（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.prompt（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.prompt（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.prompt（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.prompt（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.prompt（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.prompt（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.prompt（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.prompt（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.prompt（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.prompt（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.prompt（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.prompt（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.prompt（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$] | string &#124; number &#124; boolean &#124; object &#124; object | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 1） | string &#124; number &#124; boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 1）（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 1）（变体 2） | number | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 1）（变体 3） | boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.value | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input | "bool" &#124; "integer" &#124; "text" &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 1） | "bool" &#124; "integer" &#124; "text" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.format | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.lines | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.match | "integer" &#124; "number" &#124; "text" &#124; "output" &#124; "nonempty" | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.maxLength | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.quick | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.quick[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.type | "text" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3）.options | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3）.options[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3）.options[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3）.options[].label | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3）.type | "choice" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.key | string &#124; number &#124; boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.key（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.key（变体 2） | number | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.key（变体 3） | boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].header | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.rows[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 4）.type | "table" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.accepts | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.accepts[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.language | "python" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.maxLines | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.prompt | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.prompt（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.prompt（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.prompt（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.prompt（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.prompt（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.prompt（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.prompt（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.prompt（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.prompt（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.prompt（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.prompt（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.prompt（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.prompt（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.prompt（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.prompt（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.prompt（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.prompt（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.prompt（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.prompt（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.rejects | Array&lt;object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.rejects[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.rejects[].code | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.rejects[].why | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.solution | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.starter | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.tests | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.tests[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.tests[].data | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.tests[].data[] | string | 否 | 名字以字母开头，只用字母、数字、下划线和连字符 |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.tests[].doctest | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.tests[].expect | object | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.tests[].expect[^.*$] | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.tests[].hidden | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.tests[].name | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.tests[].setup | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.tests[].stdout | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].slots[]（变体 5）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].title | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].uses | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].quiz[].uses[] | string | 否 | 知识点 id 写成 &lt;topic id&gt;.k&lt;数字&gt;，例如 py17.k1 |
| $（变体 1）.snapshot.topic.kps[].quiz[].verify | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review | Array&lt;object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].body | string &#124; Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].body（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].body（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].body（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].body（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].body（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].body（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].body（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].body（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].body（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].body（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].body（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].body（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].body（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].body（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].body（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].body（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].body（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].body（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].body（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].data | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].data[] | string | 否 | 名字以字母开头，只用字母、数字、下划线和连字符 |
| $（变体 1）.snapshot.topic.kps[].review[].explanation | string &#124; Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].explanation（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].explanation（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].explanation（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].explanation（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].explanation（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].explanation（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].explanation（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].explanation（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].explanation（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].explanation（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].explanation（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].explanation（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].explanation（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].explanation（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].explanation（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].explanation（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].explanation（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].explanation（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].explanation（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].id | string | 否 | 题目 id 写成 &lt;知识点 id&gt;.&lt;小写字母&gt;&lt;数字&gt;，例如 py17.k1.q1 |
| $（变体 1）.snapshot.topic.kps[].review[].kind | Array&lt;"predict" &#124; "trace" &#124; "debug" &#124; "explain" &#124; "modify" &#124; "specify"&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].kind[] | "predict" &#124; "trace" &#124; "debug" &#124; "explain" &#124; "modify" &#124; "specify" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].manual | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].manual[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].measures | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].measures[] | string | 否 | 知识点 id 写成 &lt;topic id&gt;.k&lt;数字&gt;，例如 py17.k1 |
| $（变体 1）.snapshot.topic.kps[].review[].slots | Array&lt;object &#124; object &#124; object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[] | object &#124; object &#124; object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.key | string &#124; Array&lt;string&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.key（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.key（变体 2） | Array&lt;string&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.key（变体 2）[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.layout | "list" &#124; "row" &#124; "menu" | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.maxSelected | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.minSelected | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.multiple | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].content | string &#124; Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].content（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].content（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].content（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].content（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].content（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].content（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].content（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].content（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].content（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].content（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].content（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].content（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].content（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].content（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].feedback | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].feedback（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].feedback（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].feedback（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].feedback（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.options[].label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.prompt | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.prompt（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.prompt（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.prompt（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.prompt（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.prompt（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.prompt（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.prompt（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.prompt（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.prompt（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.prompt（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.prompt（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.prompt（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.prompt（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.prompt（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.prompt（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.prompt（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.prompt（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.prompt（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.prompt（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.scoring | "all" &#124; "options" | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 1）.type | "choice" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback | Array&lt;object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].message | string &#124; Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].message（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].message（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].message（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].message（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].when | string &#124; number &#124; boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].when（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].when（变体 2） | number | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.feedback[].when（变体 3） | boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.format | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.key | string &#124; number &#124; boolean &#124; Array&lt;string &#124; number &#124; boolean&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.key（变体 1） | string &#124; number &#124; boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.key（变体 1）（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.key（变体 1）（变体 2） | number | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.key（变体 1）（变体 3） | boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.key（变体 2） | Array&lt;string &#124; number &#124; boolean&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.key（变体 2）[] | string &#124; number &#124; boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.key（变体 2）[]（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.key（变体 2）[]（变体 2） | number | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.key（变体 2）[]（变体 3） | boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.lines | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.match | "integer" &#124; "number" &#124; "text" &#124; "output" &#124; "nonempty" | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.maxLength | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.placeholder | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.prompt | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.prompt（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.prompt（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.prompt（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.prompt（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.prompt（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.prompt（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.prompt（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.prompt（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.prompt（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.prompt（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.prompt（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.prompt（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.prompt（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.prompt（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.prompt（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.prompt（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.prompt（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.prompt（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.prompt（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.quick | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.quick[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.rubric | Array&lt;object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.rubric[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.rubric[].guide | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.rubric[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.rubric[].label | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.suffix | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.tolerance | number | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 2）.type | "text" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.alternatives | Array&lt;Array&lt;string&gt;&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.alternatives[] | Array&lt;string&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.alternatives[][] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.indent | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.indents | object | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.indents[^[A-Za-z0-9][A-Za-z0-9._:/-]*$] | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[].code | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[].content | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[].content（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[].content（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[].content（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[].content（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[].content（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[].content（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[].content（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[].content（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[].content（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[].content（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[].content（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[].content（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[].content（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[].content（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.items[].label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.key | Array&lt;string&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.key[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.partial | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.prompt | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.prompt（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.prompt（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.prompt（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.prompt（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.prompt（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.prompt（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.prompt（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.prompt（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.prompt（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.prompt（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.prompt（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.prompt（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.prompt（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.prompt（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.prompt（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.prompt（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.prompt（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.prompt（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.prompt（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.tests | Array&lt;object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.tests[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.tests[].data | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.tests[].data[] | string | 否 | 名字以字母开头，只用字母、数字、下划线和连字符 |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.tests[].doctest | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.tests[].expect | object | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.tests[].expect[^.*$] | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.tests[].hidden | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.tests[].name | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.tests[].setup | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.tests[].stdout | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 3）.type | "order" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.columns | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.columns[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.columns[].header | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.columns[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.columns[].input | "bool" &#124; "integer" &#124; "text" &#124; object &#124; object | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.columns[].input（变体 1） | "bool" &#124; "integer" &#124; "text" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.columns[].input（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.columns[].input（变体 2）.format | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.columns[].input（变体 2）.lines | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.columns[].input（变体 2）.match | "integer" &#124; "number" &#124; "text" &#124; "output" &#124; "nonempty" | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.columns[].input（变体 2）.maxLength | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.columns[].input（变体 2）.quick | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.columns[].input（变体 2）.quick[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.columns[].input（变体 2）.type | "text" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.columns[].input（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.columns[].input（变体 3）.options | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.columns[].input（变体 3）.options[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.columns[].input（变体 3）.options[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.columns[].input（变体 3）.options[].label | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.columns[].input（变体 3）.type | "choice" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.prompt | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.prompt（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.prompt（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.prompt（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.prompt（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.prompt（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.prompt（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.prompt（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.prompt（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.prompt（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.prompt（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.prompt（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.prompt（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.prompt（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.prompt（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.prompt（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.prompt（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.prompt（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.prompt（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.prompt（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$] | string &#124; number &#124; boolean &#124; object &#124; object | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 1） | string &#124; number &#124; boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 1）（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 1）（变体 2） | number | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 1）（变体 3） | boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.value | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input | "bool" &#124; "integer" &#124; "text" &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 1） | "bool" &#124; "integer" &#124; "text" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.format | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.lines | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.match | "integer" &#124; "number" &#124; "text" &#124; "output" &#124; "nonempty" | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.maxLength | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.quick | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.quick[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 2）.type | "text" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3）.options | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3）.options[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3）.options[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3）.options[].label | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.input（变体 3）.type | "choice" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.key | string &#124; number &#124; boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.key（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.key（变体 2） | number | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].cells[^.*$]（变体 3）.key（变体 3） | boolean | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].header | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.rows[].id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 4）.type | "table" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.accepts | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.accepts[] | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.id | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.label | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.language | "python" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.maxLines | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.optional | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.prompt | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.prompt（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.prompt（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.prompt（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.prompt（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.prompt（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.prompt（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.prompt（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.prompt（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.prompt（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.prompt（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.prompt（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.prompt（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.prompt（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.prompt（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.prompt（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.prompt（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.prompt（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.prompt（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.prompt（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.rejects | Array&lt;object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.rejects[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.rejects[].code | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.rejects[].why | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.solution | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.starter | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.tests | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.tests[] | object | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.tests[].data | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.tests[].data[] | string | 否 | 名字以字母开头，只用字母、数字、下划线和连字符 |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.tests[].doctest | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.tests[].expect | object | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.tests[].expect[^.*$] | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.tests[].hidden | boolean | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.tests[].name | string | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.tests[].setup | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.tests[].stdout | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].slots[]（变体 5）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.kps[].review[].title | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].uses | Array&lt;string&gt; | 是 |  |
| $（变体 1）.snapshot.topic.kps[].review[].uses[] | string | 否 | 知识点 id 写成 &lt;topic id&gt;.k&lt;数字&gt;，例如 py17.k1 |
| $（变体 1）.snapshot.topic.kps[].review[].verify | string | 是 |  |
| $（变体 1）.snapshot.topic.kps[].title | string | 否 |  |
| $（变体 1）.snapshot.topic.minutes | integer | 否 |  |
| $（变体 1）.snapshot.topic.notes | string | 是 |  |
| $（变体 1）.snapshot.topic.prerequisites | Array&lt;string&gt; | 否 |  |
| $（变体 1）.snapshot.topic.prerequisites[] | string | 否 | topic id 只用小写字母和数字，以字母开头，例如 py17 |
| $（变体 1）.snapshot.topic.sources | Array&lt;object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.sources[] | object | 否 |  |
| $（变体 1）.snapshot.topic.sources[].notice | string | 是 |  |
| $（变体 1）.snapshot.topic.sources[].source | string | 否 | 名字以字母开头，只用字母、数字、下划线和连字符 |
| $（变体 1）.snapshot.topic.sources[].url | string | 是 | 链接需要以 https:// 开头 |
| $（变体 1）.snapshot.topic.sources[].use | "reference" &#124; "adapt" &#124; "code" &#124; "quote" | 否 |  |
| $（变体 1）.snapshot.topic.sources[].where | string | 否 |  |
| $（变体 1）.snapshot.topic.status | "outline" &#124; "complete" | 否 |  |
| $（变体 1）.snapshot.topic.summary | string | 是 |  |
| $（变体 1）.snapshot.topic.title | string | 否 |  |
| $（变体 1）.snapshot.topic.verified | Array&lt;object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.verified[] | object | 否 |  |
| $（变体 1）.snapshot.topic.verified[].date | string | 否 | 日期写成 YYYY-MM-DD |
| $（变体 1）.snapshot.topic.verified[].model | string | 否 |  |
| $（变体 1）.snapshot.topic.verified[].question | string | 否 | 题目 id 写成 &lt;知识点 id&gt;.&lt;小写字母&gt;&lt;数字&gt;，例如 py17.k1.q1 |
| $（变体 1）.snapshot.topic.verified[].scope | "question-runtime-v1" | 是 |  |
| $（变体 1）.snapshot.topic.verified[].slots | Array&lt;string&gt; | 否 |  |
| $（变体 1）.snapshot.topic.verified[].slots[] | string | 否 |  |
| $（变体 1）.snapshot.topic.verified[].version | string | 否 | 核对哈希写成 sha256:&lt;64 位十六进制&gt; |
| $（变体 1）.snapshot.topic.wrapup | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）.snapshot.topic.wrapup（变体 1） | string | 否 |  |
| $（变体 1）.snapshot.topic.wrapup（变体 2） | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 1）.snapshot.topic.wrapup（变体 2）[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）.snapshot.topic.wrapup（变体 2）[]（变体 1） | object | 否 |  |
| $（变体 1）.snapshot.topic.wrapup（变体 2）[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）.snapshot.topic.wrapup（变体 2）[]（变体 1）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.wrapup（变体 2）[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）.snapshot.topic.wrapup（变体 2）[]（变体 2） | object | 否 |  |
| $（变体 1）.snapshot.topic.wrapup（变体 2）[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）.snapshot.topic.wrapup（变体 2）[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）.snapshot.topic.wrapup（变体 2）[]（变体 2）.language | string | 否 |  |
| $（变体 1）.snapshot.topic.wrapup（变体 2）[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）.snapshot.topic.wrapup（变体 2）[]（变体 2）.text | string | 否 |  |
| $（变体 1）.snapshot.topic.wrapup（变体 2）[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）.snapshot.topic.wrapup（变体 2）[]（变体 3） | object | 否 |  |
| $（变体 1）.snapshot.topic.wrapup（变体 2）[]（变体 3）.alt | string | 否 |  |
| $（变体 1）.snapshot.topic.wrapup（变体 2）[]（变体 3）.asset | string | 否 |  |
| $（变体 1）.snapshot.topic.wrapup（变体 2）[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）.snapshot.topic.wrapup（变体 2）[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）.snapshot.topicVersion | string | 否 |  |
| $（变体 1）.type | "snapshot" | 否 |  |
| $（变体 1）.v | 1 | 否 |  |
| $（变体 2） | object | 否 |  |
| $（变体 2）.at | integer | 否 |  |
| $（变体 2）.decision | object | 否 |  |
| $（变体 2）.decision.candidates | Array&lt;string&gt; | 否 |  |
| $（变体 2）.decision.candidates[] | string | 否 |  |
| $（变体 2）.decision.now | integer | 否 |  |
| $（变体 2）.decision.policyVersion | string | 否 |  |
| $（变体 2）.decision.scores | object | 否 |  |
| $（变体 2）.decision.scores[^.*$] | number | 是 |  |
| $（变体 2）.decision.seed | integer | 否 |  |
| $（变体 2）.decision.selected | string &#124; null | 否 |  |
| $（变体 2）.decision.selected（变体 1） | string | 否 |  |
| $（变体 2）.decision.selected（变体 2） | null | 否 |  |
| $（变体 2）.projection | object | 否 |  |
| $（变体 2）.projection.deliveries | object | 否 |  |
| $（变体 2）.projection.deliveries[^.*$] | string | 是 |  |
| $（变体 2）.projection.state | object | 否 |  |
| $（变体 2）.projection.state.course | object &#124; null | 否 |  |
| $（变体 2）.projection.state.course（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.course（变体 1）.id | string | 否 |  |
| $（变体 2）.projection.state.course（变体 1）.title | string | 否 |  |
| $（变体 2）.projection.state.course（变体 1）.version | string | 否 |  |
| $（变体 2）.projection.state.course（变体 2） | null | 否 |  |
| $（变体 2）.projection.state.menu | object &#124; null | 否 |  |
| $（变体 2）.projection.state.menu（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.menu（变体 1）.availableAt | integer | 是 |  |
| $（变体 2）.projection.state.menu（变体 1）.candidates | Array&lt;object&gt; | 否 |  |
| $（变体 2）.projection.state.menu（变体 1）.candidates[] | object | 否 |  |
| $（变体 2）.projection.state.menu（变体 1）.candidates[].id | string | 否 |  |
| $（变体 2）.projection.state.menu（变体 1）.candidates[].kind | "lesson" &#124; "review" &#124; "quiz" &#124; "retake" | 否 |  |
| $（变体 2）.projection.state.menu（变体 1）.candidates[].originalTaskId | string | 是 |  |
| $（变体 2）.projection.state.menu（变体 1）.candidates[].title | string | 否 |  |
| $（变体 2）.projection.state.menu（变体 1）.candidates[].topicIds | Array&lt;string&gt; | 否 |  |
| $（变体 2）.projection.state.menu（变体 1）.candidates[].topicIds[] | string | 否 |  |
| $（变体 2）.projection.state.menu（变体 1）.menuId | string | 否 |  |
| $（变体 2）.projection.state.menu（变体 1）.unavailableReason | string | 是 |  |
| $（变体 2）.projection.state.menu（变体 2） | null | 否 |  |
| $（变体 2）.projection.state.progress | object | 否 |  |
| $（变体 2）.projection.state.progress.completedTopics | integer | 否 |  |
| $（变体 2）.projection.state.progress.completionRate | number | 否 |  |
| $（变体 2）.projection.state.progress.dailyGoalXp | integer | 否 |  |
| $（变体 2）.projection.state.progress.day | string | 否 |  |
| $（变体 2）.projection.state.progress.etaDays | number &#124; null | 否 |  |
| $（变体 2）.projection.state.progress.etaDays（变体 1） | number | 否 |  |
| $（变体 2）.projection.state.progress.etaDays（变体 2） | null | 否 |  |
| $（变体 2）.projection.state.progress.timeZone | string | 否 |  |
| $（变体 2）.projection.state.progress.todayXp | integer | 否 |  |
| $（变体 2）.projection.state.progress.totalTopics | integer | 否 |  |
| $（变体 2）.projection.state.progress.totalXp | integer | 否 |  |
| $（变体 2）.projection.state.restrictions | object | 否 |  |
| $（变体 2）.projection.state.restrictions.kind | "none" &#124; "review" &#124; "quiz" | 否 |  |
| $（变体 2）.projection.state.restrictions.referenceContentAllowed | boolean | 否 |  |
| $（变体 2）.projection.state.restrictions.tutorAllowed | boolean | 否 |  |
| $（变体 2）.projection.state.revision | integer | 否 |  |
| $（变体 2）.projection.state.serverNow | integer | 否 |  |
| $（变体 2）.projection.state.task | object &#124; null | 否 |  |
| $（变体 2）.projection.state.task（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deadlineAt | integer &#124; null | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deadlineAt（变体 1） | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deadlineAt（变体 2） | null | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries | Array&lt;object&gt; | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[] | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].deliveryId | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.body | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.body[] | object &#124; object &#124; object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 1）.math | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 1）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 2） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 2）.language | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 2）.startLine | integer | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 2）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 2）.type | "code" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 3） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 3）.alt | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 3）.asset | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 3）.type | "image" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.id | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.requires | Array&lt;string&gt; | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.requires[] | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots | Array&lt;object &#124; object &#124; object &#124; object &#124; object&gt; | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[] | object &#124; object &#124; object &#124; object &#124; object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.id | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.label | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.layout | "list" &#124; "row" &#124; "menu" | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.layout（变体 1） | "list" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.layout（变体 2） | "row" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.layout（变体 3） | "menu" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.maxSelected | integer | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.minSelected | integer | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.multiple | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.optional | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options | Array&lt;object&gt; | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[] | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[] | object &#124; object &#124; object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 1）.math | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 1）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 2） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 2）.language | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 2）.startLine | integer | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 2）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 2）.type | "code" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 3） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 3）.alt | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 3）.asset | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 3）.type | "image" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].id | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].label | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.other | object | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.other.label | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[] | object &#124; object &#124; object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 1）.math | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 1）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 2） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 2）.language | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 2）.startLine | integer | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 2）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 2）.type | "code" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 3） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 3）.alt | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 3）.asset | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 3）.type | "image" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.type | "choice" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.format | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.id | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.label | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.lines | integer | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.maxLength | integer | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.optional | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.placeholder | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[] | object &#124; object &#124; object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 1）.math | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 1）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 2） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 2）.language | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 2）.startLine | integer | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 2）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 2）.type | "code" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 3） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 3）.alt | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 3）.asset | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 3）.type | "image" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.quick | Array&lt;string&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.quick[] | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.suffix | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.type | "text" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.id | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.indent | integer | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items | Array&lt;object&gt; | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[] | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[] | object &#124; object &#124; object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 1）.math | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 1）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 2） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 2）.language | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 2）.startLine | integer | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 2）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 2）.type | "code" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 3） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 3）.alt | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 3）.asset | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 3）.type | "image" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].id | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].label | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.label | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.optional | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.partial | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[] | object &#124; object &#124; object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 1）.math | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 1）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 2） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 2）.language | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 2）.startLine | integer | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 2）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 2）.type | "code" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 3） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 3）.alt | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 3）.asset | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 3）.type | "image" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.type | "order" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.columns | Array&lt;object&gt; | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.columns[] | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.columns[].header | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.columns[].id | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.id | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.label | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.optional | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[] | object &#124; object &#124; object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 1）.math | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 1）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 2） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 2）.language | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 2）.startLine | integer | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 2）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 2）.type | "code" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 3） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 3）.alt | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 3）.asset | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 3）.type | "image" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows | Array&lt;object&gt; | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[] | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$] | object &#124; object | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 1）.value | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input | object &#124; object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.format | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.lines | integer | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.maxLength | integer | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.quick | Array&lt;string&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.quick[] | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.type | "text" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.options | Array&lt;object&gt; | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.options[] | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.options[].id | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.options[].label | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.type | "choice" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].header | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].id | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.type | "table" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.id | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.label | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.language | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.maxLines | integer | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.optional | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[] | object &#124; object &#124; object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 1）.math | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 1）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 2） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 2）.language | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 2）.startLine | integer | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 2）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 2）.type | "code" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 3） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 3）.alt | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 3）.asset | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 3）.type | "image" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.starter | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.type | "code" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.title | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].item.version | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].kpId | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].mode | "practice" &#124; "review" &#124; "quiz" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].repeated | boolean | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].requiresServices | Array&lt;string&gt; | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].requiresServices[] | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].submissionId | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.deliveries[].topicId | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.kind | "lesson" &#124; "review" &#124; "quiz" &#124; "retake" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.kps | Array&lt;object&gt; | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.kps[] | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.kps[].attempts | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.kps[].completed | boolean | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.kps[].consecutiveCorrect | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.kps[].kpId | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase | object &#124; object &#124; object &#124; object &#124; object &#124; object &#124; object &#124; object &#124; object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 1）.stage | "preparing" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.blocks | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[] | object &#124; object &#124; object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 1）.math | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 1）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 2） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 2）.language | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 2）.startLine | integer | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 2）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 2）.type | "code" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 3） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 3）.alt | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 3）.asset | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 3）.type | "image" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.offset | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.origin | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.origin.content | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.origin.content.courseId | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.origin.content.id | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.origin.content.kind | "topic" &#124; "kp" &#124; "lesson" &#124; "example" &#124; "card" &#124; "explanation" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.origin.content.kpId | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.origin.content.topicId | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.origin.content.version | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.origin.deliveryId | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.origin.taskId | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.ref | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.ref.courseId | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.ref.id | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.ref.kind | "topic" &#124; "kp" &#124; "lesson" &#124; "example" &#124; "card" &#124; "explanation" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.ref.kpId | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.ref.topicId | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.ref.version | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.page.total | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 2）.stage | "explanation" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.blocks | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[] | object &#124; object &#124; object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 1）.math | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 1）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 2） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 2）.language | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 2）.startLine | integer | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 2）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 2）.type | "code" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 3） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 3）.alt | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 3）.asset | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 3）.type | "image" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.offset | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.origin | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.origin.content | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.origin.content.courseId | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.origin.content.id | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.origin.content.kind | "topic" &#124; "kp" &#124; "lesson" &#124; "example" &#124; "card" &#124; "explanation" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.origin.content.kpId | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.origin.content.topicId | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.origin.content.version | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.origin.deliveryId | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.origin.taskId | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.ref | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.ref.courseId | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.ref.id | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.ref.kind | "topic" &#124; "kp" &#124; "lesson" &#124; "example" &#124; "card" &#124; "explanation" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.ref.kpId | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.ref.topicId | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.ref.version | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.page.total | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 3）.stage | "example" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 4） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 4）.deliveryId | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 4）.stage | "awaiting_answer" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 5） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 5）.stage | "judging" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 5）.submissionId | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 6） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 6）.stage | "recovery" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 6）.submissionId | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 7） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 7）.stage | "feedback" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 7）.submissionId | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 8） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 8）.outcome | "passed" &#124; "failed" &#124; "timeout" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 8）.stage | "completed" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 9） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 9）.reason | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.phase（变体 9）.stage | "aborted" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.startedAt | integer &#124; null | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.startedAt（变体 1） | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.startedAt（变体 2） | null | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions | Array&lt;object&gt; | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[] | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].acceptedAt | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].deliveryId | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].explanation | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].explanation[] | object &#124; object &#124; object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].explanation[]（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].explanation[]（变体 1）.math | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].explanation[]（变体 1）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].explanation[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].explanation[]（变体 2） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].explanation[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].explanation[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].explanation[]（变体 2）.language | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].explanation[]（变体 2）.startLine | integer | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].explanation[]（变体 2）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].explanation[]（变体 2）.type | "code" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].explanation[]（变体 3） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].explanation[]（变体 3）.alt | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].explanation[]（变体 3）.asset | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].explanation[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].explanation[]（变体 3）.type | "image" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback | object | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.evidence | object | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.evidence.reason | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.evidence.status | "eligible" &#124; "ineligible" &#124; "unresolved" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.item | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.item.id | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.item.version | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.judge | "rule" &#124; "tests" &#124; "model" &#124; "person" | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.judge（变体 1） | "rule" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.judge（变体 2） | "tests" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.judge（变体 3） | "model" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.judge（变体 4） | "person" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.message | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.message[] | object &#124; object &#124; object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 1）.math | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 1）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 2） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 2）.language | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 2）.startLine | integer | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 2）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 2）.type | "code" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 3） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 3）.alt | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 3）.asset | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 3）.type | "image" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.score | object | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.score.earned | number | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.score.max | number | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots | object | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$] | object | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria | Array&lt;object&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria[] | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria[].comment | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria[].label | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria[].met | "yes" &#124; "no" &#124; "unsure" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria[].met（变体 1） | "yes" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria[].met（变体 2） | "no" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria[].met（变体 3） | "unsure" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected | object &#124; object &#124; object &#124; object &#124; object | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 1）.other | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 1）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 1）.selected[] | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 1）.type | "choice" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 2） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 2）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 2）.type | "text" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 3） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 3）.indents | Array&lt;integer&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 3）.indents[] | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 3）.items | Array&lt;string&gt; | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 3）.items[] | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 3）.type | "order" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$] | object | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$] | object &#124; object | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 1）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 1）.type | "text" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.other | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.selected[] | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.type | "choice" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.type | "table" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 5） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 5）.code | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 5）.type | "code" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].marks | object | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].marks[^.*$] | "correct" &#124; "incorrect" &#124; "missed" | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].marks[^.*$]（变体 1） | "correct" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].marks[^.*$]（变体 2） | "incorrect" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].marks[^.*$]（变体 3） | "missed" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[] | object &#124; object &#124; object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 1）.math | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 1）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 2） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 2）.language | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 2）.startLine | integer | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 2）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 2）.type | "code" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 3） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 3）.alt | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 3）.asset | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 3）.type | "image" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].score | object | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].score.earned | number | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].score.max | number | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests | Array&lt;object&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[] | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[] | object &#124; object &#124; object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 1）.math | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 1）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 2） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 2）.language | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 2）.startLine | integer | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 2）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 2）.type | "code" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 3） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 3）.alt | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 3）.asset | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 3）.type | "image" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].hidden | boolean | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].name | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].result | "passed" &#124; "failed" &#124; "error" &#124; "timeout" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].result（变体 1） | "passed" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].result（变体 2） | "failed" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].result（变体 3） | "error" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].result（变体 4） | "timeout" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].verdict | "correct" &#124; "partial" &#124; "incorrect" &#124; "ungraded" &#124; "pending" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].verdict（变体 1） | "correct" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].verdict（变体 2） | "partial" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].verdict（变体 3） | "incorrect" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].verdict（变体 4） | "ungraded" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].verdict（变体 5） | "pending" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.verdict | "correct" &#124; "partial" &#124; "incorrect" &#124; "ungraded" &#124; "pending" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.verdict（变体 1） | "correct" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.verdict（变体 2） | "partial" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.verdict（变体 3） | "incorrect" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.verdict（变体 4） | "ungraded" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].feedback.verdict（变体 5） | "pending" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].gradeRevision | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].processing | object &#124; object &#124; object &#124; object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].processing（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].processing（变体 1）.status | "accepted" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].processing（变体 2） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].processing（变体 2）.status | "pending" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].processing（变体 3） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].processing（变体 3）.reason | "restart" &#124; "service_failure" &#124; "uncertain_grade" &#124; "cancelled" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].processing（变体 3）.status | "interrupted" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].processing（变体 4） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].processing（变体 4）.status | "completed" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$] | object &#124; object &#124; object &#124; object &#124; object | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 1）.other | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 1）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 1）.selected[] | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 1）.type | "choice" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 2） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 2）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 2）.type | "text" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 3） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 3）.indents | Array&lt;integer&gt; | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 3）.indents[] | integer | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 3）.items | Array&lt;string&gt; | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 3）.items[] | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 3）.type | "order" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$] | object | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$] | object &#124; object | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 1） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 1）.text | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 1）.type | "text" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.other | string | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.selected[] | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.type | "choice" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.type | "table" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 5） | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 5）.code | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 5）.type | "code" | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.dontKnow | true | 是 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.item | object | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.item.id | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].response.item.version | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].submissionId | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.submissions[].taskId | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.taskId | string | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.topicIds | Array&lt;string&gt; | 否 |  |
| $（变体 2）.projection.state.task（变体 1）.topicIds[] | string | 否 |  |
| $（变体 2）.projection.state.task（变体 2） | null | 否 |  |
| $（变体 2）.projection.student | object | 否 |  |
| $（变体 2）.projection.student[^.*$] | object | 是 |  |
| $（变体 2）.projection.student[^.*$].interval | number | 否 |  |
| $（变体 2）.projection.student[^.*$].lastRepetitionDay | number | 否 |  |
| $（变体 2）.projection.student[^.*$].memory | number | 否 |  |
| $（变体 2）.projection.student[^.*$].repNum | number | 否 |  |
| $（变体 2）.projection.student[^.*$].speed | number | 否 |  |
| $（变体 2）.projection.xp | object | 是 |  |
| $（变体 2）.projection.xp.consumed | integer | 否 |  |
| $（变体 2）.projection.xp.highWater | integer | 否 |  |
| $（变体 2）.projection.xp.origins | object | 否 |  |
| $（变体 2）.projection.xp.origins[^.*$] | string | 是 |  |
| $（变体 2）.projection.xp.pending | object | 是 |  |
| $（变体 2）.projection.xp.pending.atXp | integer | 否 |  |
| $（变体 2）.projection.xp.pending.id | string | 否 |  |
| $（变体 2）.projection.xp.pending.seed | integer | 否 |  |
| $（变体 2）.projection.xp.pending.topicIds | Array&lt;string&gt; | 否 |  |
| $（变体 2）.projection.xp.pending.topicIds[] | string | 否 |  |
| $（变体 2）.projection.xp.rewards | Array&lt;object&gt; | 否 |  |
| $（变体 2）.projection.xp.rewards[] | object | 否 |  |
| $（变体 2）.projection.xp.rewards[].at | integer | 否 |  |
| $（变体 2）.projection.xp.rewards[].ruleVersion | string | 否 |  |
| $（变体 2）.projection.xp.rewards[].taskId | string | 否 |  |
| $（变体 2）.projection.xp.rewards[].xp | integer | 否 |  |
| $（变体 2）.seq | integer | 否 |  |
| $（变体 2）.type | "checkpoint" | 否 |  |
| $（变体 2）.v | 1 | 否 |  |
| $（变体 3） | object | 否 |  |
| $（变体 3）.at | integer | 否 |  |
| $（变体 3）.context | object | 否 |  |
| $（变体 3）.context.helpBefore | Array&lt;string&gt; | 否 |  |
| $（变体 3）.context.helpBefore[] | string | 否 |  |
| $（变体 3）.context.model | object | 否 |  |
| $（变体 3）.context.model.before | object | 否 |  |
| $（变体 3）.context.model.before[^.*$] | object | 是 |  |
| $（变体 3）.context.model.before[^.*$].interval | number | 否 |  |
| $（变体 3）.context.model.before[^.*$].lastRepetitionDay | number | 否 |  |
| $（变体 3）.context.model.before[^.*$].memory | number | 否 |  |
| $（变体 3）.context.model.before[^.*$].repNum | number | 否 |  |
| $（变体 3）.context.model.before[^.*$].speed | number | 否 |  |
| $（变体 3）.context.model.config | object | 否 |  |
| $（变体 3）.context.model.config.decayExponent | number | 否 |  |
| $（变体 3）.context.model.config.decaySlope | number | 否 |  |
| $（变体 3）.context.model.config.dueMemory | number | 否 |  |
| $（变体 3）.context.model.config.earlyExponent | number | 否 |  |
| $（变体 3）.context.model.config.failScale | number | 否 |  |
| $（变体 3）.context.model.config.failSpeedStep | number | 否 |  |
| $（变体 3）.context.model.config.initialSpeed | number | 否 |  |
| $（变体 3）.context.model.config.intervalBase | number | 否 |  |
| $（变体 3）.context.model.config.intervalScale | number | 否 |  |
| $（变体 3）.context.model.config.maximumInterval | number | 否 |  |
| $（变体 3）.context.model.config.maximumSpeed | number | 否 |  |
| $（变体 3）.context.model.config.minimumSpeed | number | 否 |  |
| $（变体 3）.context.model.config.passScale | number | 否 |  |
| $（变体 3）.context.model.config.passSpeedStep | number | 否 |  |
| $（变体 3）.context.model.config.pathCombination | "max" &#124; "capped-sum" | 否 |  |
| $（变体 3）.context.model.config.pathCombination（变体 1） | "max" | 否 |  |
| $（变体 3）.context.model.config.pathCombination（变体 2） | "capped-sum" | 否 |  |
| $（变体 3）.context.model.config.qualityExponent | number | 否 |  |
| $（变体 3）.context.model.config.updateSpeed | boolean | 否 |  |
| $（变体 3）.context.model.configVersion | string | 否 |  |
| $（变体 3）.context.model.now | integer | 否 |  |
| $（变体 3）.context.startedAt | integer | 否 |  |
| $（变体 3）.context.startOffsetMs | integer | 否 |  |
| $（变体 3）.context.submitOffsetMs | integer | 否 |  |
| $（变体 3）.context.submittedAt | integer | 否 |  |
| $（变体 3）.seq | integer | 否 |  |
| $（变体 3）.submission | object | 否 |  |
| $（变体 3）.submission.acceptedAt | integer | 否 |  |
| $（变体 3）.submission.deliveryId | string | 否 |  |
| $（变体 3）.submission.explanation | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 3）.submission.explanation[] | object &#124; object &#124; object | 否 |  |
| $（变体 3）.submission.explanation[]（变体 1） | object | 否 |  |
| $（变体 3）.submission.explanation[]（变体 1）.math | boolean | 是 |  |
| $（变体 3）.submission.explanation[]（变体 1）.text | string | 否 |  |
| $（变体 3）.submission.explanation[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 3）.submission.explanation[]（变体 2） | object | 否 |  |
| $（变体 3）.submission.explanation[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 3）.submission.explanation[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 3）.submission.explanation[]（变体 2）.language | string | 否 |  |
| $（变体 3）.submission.explanation[]（变体 2）.startLine | integer | 是 |  |
| $（变体 3）.submission.explanation[]（变体 2）.text | string | 否 |  |
| $（变体 3）.submission.explanation[]（变体 2）.type | "code" | 否 |  |
| $（变体 3）.submission.explanation[]（变体 3） | object | 否 |  |
| $（变体 3）.submission.explanation[]（变体 3）.alt | string | 否 |  |
| $（变体 3）.submission.explanation[]（变体 3）.asset | string | 否 |  |
| $（变体 3）.submission.explanation[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 3）.submission.explanation[]（变体 3）.type | "image" | 否 |  |
| $（变体 3）.submission.feedback | object | 是 |  |
| $（变体 3）.submission.feedback.evidence | object | 是 |  |
| $（变体 3）.submission.feedback.evidence.reason | string | 是 |  |
| $（变体 3）.submission.feedback.evidence.status | "eligible" &#124; "ineligible" &#124; "unresolved" | 否 |  |
| $（变体 3）.submission.feedback.item | object | 否 |  |
| $（变体 3）.submission.feedback.item.id | string | 否 |  |
| $（变体 3）.submission.feedback.item.version | string | 否 |  |
| $（变体 3）.submission.feedback.judge | "rule" &#124; "tests" &#124; "model" &#124; "person" | 是 |  |
| $（变体 3）.submission.feedback.judge（变体 1） | "rule" | 否 |  |
| $（变体 3）.submission.feedback.judge（变体 2） | "tests" | 否 |  |
| $（变体 3）.submission.feedback.judge（变体 3） | "model" | 否 |  |
| $（变体 3）.submission.feedback.judge（变体 4） | "person" | 否 |  |
| $（变体 3）.submission.feedback.message | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 3）.submission.feedback.message[] | object &#124; object &#124; object | 否 |  |
| $（变体 3）.submission.feedback.message[]（变体 1） | object | 否 |  |
| $（变体 3）.submission.feedback.message[]（变体 1）.math | boolean | 是 |  |
| $（变体 3）.submission.feedback.message[]（变体 1）.text | string | 否 |  |
| $（变体 3）.submission.feedback.message[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 3）.submission.feedback.message[]（变体 2） | object | 否 |  |
| $（变体 3）.submission.feedback.message[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 3）.submission.feedback.message[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 3）.submission.feedback.message[]（变体 2）.language | string | 否 |  |
| $（变体 3）.submission.feedback.message[]（变体 2）.startLine | integer | 是 |  |
| $（变体 3）.submission.feedback.message[]（变体 2）.text | string | 否 |  |
| $（变体 3）.submission.feedback.message[]（变体 2）.type | "code" | 否 |  |
| $（变体 3）.submission.feedback.message[]（变体 3） | object | 否 |  |
| $（变体 3）.submission.feedback.message[]（变体 3）.alt | string | 否 |  |
| $（变体 3）.submission.feedback.message[]（变体 3）.asset | string | 否 |  |
| $（变体 3）.submission.feedback.message[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 3）.submission.feedback.message[]（变体 3）.type | "image" | 否 |  |
| $（变体 3）.submission.feedback.score | object | 是 |  |
| $（变体 3）.submission.feedback.score.earned | number | 否 |  |
| $（变体 3）.submission.feedback.score.max | number | 否 |  |
| $（变体 3）.submission.feedback.slots | object | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$] | object | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].criteria | Array&lt;object&gt; | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].criteria[] | object | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].criteria[].comment | string | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].criteria[].label | string | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].criteria[].met | "yes" &#124; "no" &#124; "unsure" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].criteria[].met（变体 1） | "yes" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].criteria[].met（变体 2） | "no" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].criteria[].met（变体 3） | "unsure" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected | object &#124; object &#124; object &#124; object &#124; object | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 1） | object | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 1）.other | string | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 1）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 1）.selected[] | string | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 1）.type | "choice" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 2） | object | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 2）.text | string | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 2）.type | "text" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 3） | object | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 3）.indents | Array&lt;integer&gt; | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 3）.indents[] | integer | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 3）.items | Array&lt;string&gt; | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 3）.items[] | string | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 3）.type | "order" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 4） | object | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 4）.cells | object | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 4）.cells[^.*$] | object | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$] | object &#124; object | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 1） | object | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 1）.text | string | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 1）.type | "text" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2） | object | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.other | string | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.selected[] | string | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.type | "choice" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 4）.type | "table" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 5） | object | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 5）.code | string | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].expected（变体 5）.type | "code" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].marks | object | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].marks[^.*$] | "correct" &#124; "incorrect" &#124; "missed" | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].marks[^.*$]（变体 1） | "correct" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].marks[^.*$]（变体 2） | "incorrect" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].marks[^.*$]（变体 3） | "missed" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].message | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].message[] | object &#124; object &#124; object | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].message[]（变体 1） | object | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].message[]（变体 1）.math | boolean | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].message[]（变体 1）.text | string | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].message[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].message[]（变体 2） | object | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].message[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].message[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].message[]（变体 2）.language | string | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].message[]（变体 2）.startLine | integer | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].message[]（变体 2）.text | string | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].message[]（变体 2）.type | "code" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].message[]（变体 3） | object | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].message[]（变体 3）.alt | string | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].message[]（变体 3）.asset | string | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].message[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].message[]（变体 3）.type | "image" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].score | object | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].score.earned | number | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].score.max | number | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests | Array&lt;object&gt; | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[] | object | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].detail | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].detail[] | object &#124; object &#124; object | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].detail[]（变体 1） | object | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].detail[]（变体 1）.math | boolean | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].detail[]（变体 1）.text | string | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].detail[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].detail[]（变体 2） | object | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].detail[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].detail[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].detail[]（变体 2）.language | string | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].detail[]（变体 2）.startLine | integer | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].detail[]（变体 2）.text | string | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].detail[]（变体 2）.type | "code" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].detail[]（变体 3） | object | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].detail[]（变体 3）.alt | string | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].detail[]（变体 3）.asset | string | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].detail[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].detail[]（变体 3）.type | "image" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].hidden | boolean | 是 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].name | string | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].result | "passed" &#124; "failed" &#124; "error" &#124; "timeout" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].result（变体 1） | "passed" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].result（变体 2） | "failed" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].result（变体 3） | "error" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].tests[].result（变体 4） | "timeout" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].verdict | "correct" &#124; "partial" &#124; "incorrect" &#124; "ungraded" &#124; "pending" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].verdict（变体 1） | "correct" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].verdict（变体 2） | "partial" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].verdict（变体 3） | "incorrect" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].verdict（变体 4） | "ungraded" | 否 |  |
| $（变体 3）.submission.feedback.slots[^.*$].verdict（变体 5） | "pending" | 否 |  |
| $（变体 3）.submission.feedback.verdict | "correct" &#124; "partial" &#124; "incorrect" &#124; "ungraded" &#124; "pending" | 否 |  |
| $（变体 3）.submission.feedback.verdict（变体 1） | "correct" | 否 |  |
| $（变体 3）.submission.feedback.verdict（变体 2） | "partial" | 否 |  |
| $（变体 3）.submission.feedback.verdict（变体 3） | "incorrect" | 否 |  |
| $（变体 3）.submission.feedback.verdict（变体 4） | "ungraded" | 否 |  |
| $（变体 3）.submission.feedback.verdict（变体 5） | "pending" | 否 |  |
| $（变体 3）.submission.gradeRevision | integer | 否 |  |
| $（变体 3）.submission.processing | object &#124; object &#124; object &#124; object | 否 |  |
| $（变体 3）.submission.processing（变体 1） | object | 否 |  |
| $（变体 3）.submission.processing（变体 1）.status | "accepted" | 否 |  |
| $（变体 3）.submission.processing（变体 2） | object | 否 |  |
| $（变体 3）.submission.processing（变体 2）.status | "pending" | 否 |  |
| $（变体 3）.submission.processing（变体 3） | object | 否 |  |
| $（变体 3）.submission.processing（变体 3）.reason | "restart" &#124; "service_failure" &#124; "uncertain_grade" &#124; "cancelled" | 否 |  |
| $（变体 3）.submission.processing（变体 3）.status | "interrupted" | 否 |  |
| $（变体 3）.submission.processing（变体 4） | object | 否 |  |
| $（变体 3）.submission.processing（变体 4）.status | "completed" | 否 |  |
| $（变体 3）.submission.response | object | 否 |  |
| $（变体 3）.submission.response.answers | object | 否 |  |
| $（变体 3）.submission.response.answers[^.*$] | object &#124; object &#124; object &#124; object &#124; object | 是 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 1） | object | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 1）.other | string | 是 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 1）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 1）.selected[] | string | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 1）.type | "choice" | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 2） | object | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 2）.text | string | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 2）.type | "text" | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 3） | object | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 3）.indents | Array&lt;integer&gt; | 是 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 3）.indents[] | integer | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 3）.items | Array&lt;string&gt; | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 3）.items[] | string | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 3）.type | "order" | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 4） | object | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 4）.cells | object | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 4）.cells[^.*$] | object | 是 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 4）.cells[^.*$][^.*$] | object &#124; object | 是 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 1） | object | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 1）.text | string | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 1）.type | "text" | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2） | object | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.other | string | 是 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.selected[] | string | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.type | "choice" | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 4）.type | "table" | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 5） | object | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 5）.code | string | 否 |  |
| $（变体 3）.submission.response.answers[^.*$]（变体 5）.type | "code" | 否 |  |
| $（变体 3）.submission.response.dontKnow | true | 是 |  |
| $（变体 3）.submission.response.item | object | 否 |  |
| $（变体 3）.submission.response.item.id | string | 否 |  |
| $（变体 3）.submission.response.item.version | string | 否 |  |
| $（变体 3）.submission.submissionId | string | 否 |  |
| $（变体 3）.submission.taskId | string | 否 |  |
| $（变体 3）.type | "accepted" | 否 |  |
| $（变体 3）.v | 1 | 否 |  |
| $（变体 4） | object | 否 |  |
| $（变体 4）.at | integer | 否 |  |
| $（变体 4）.expectedGradeRevision | integer | 否 |  |
| $（变体 4）.reason | string | 否 |  |
| $（变体 4）.seq | integer | 否 |  |
| $（变体 4）.submissionId | string | 否 |  |
| $（变体 4）.type | "appeal" | 否 |  |
| $（变体 4）.v | 1 | 否 |  |
| $（变体 5） | object | 否 |  |
| $（变体 5）.at | integer | 否 |  |
| $（变体 5）.grade | object | 否 |  |
| $（变体 5）.grade.feedback | object | 否 |  |
| $（变体 5）.grade.feedback.evidence | object | 是 |  |
| $（变体 5）.grade.feedback.evidence.reason | string | 是 |  |
| $（变体 5）.grade.feedback.evidence.status | "eligible" &#124; "ineligible" &#124; "unresolved" | 否 |  |
| $（变体 5）.grade.feedback.item | object | 否 |  |
| $（变体 5）.grade.feedback.item.id | string | 否 |  |
| $（变体 5）.grade.feedback.item.version | string | 否 |  |
| $（变体 5）.grade.feedback.judge | "rule" &#124; "tests" &#124; "model" &#124; "person" | 是 |  |
| $（变体 5）.grade.feedback.judge（变体 1） | "rule" | 否 |  |
| $（变体 5）.grade.feedback.judge（变体 2） | "tests" | 否 |  |
| $（变体 5）.grade.feedback.judge（变体 3） | "model" | 否 |  |
| $（变体 5）.grade.feedback.judge（变体 4） | "person" | 否 |  |
| $（变体 5）.grade.feedback.message | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 5）.grade.feedback.message[] | object &#124; object &#124; object | 否 |  |
| $（变体 5）.grade.feedback.message[]（变体 1） | object | 否 |  |
| $（变体 5）.grade.feedback.message[]（变体 1）.math | boolean | 是 |  |
| $（变体 5）.grade.feedback.message[]（变体 1）.text | string | 否 |  |
| $（变体 5）.grade.feedback.message[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 5）.grade.feedback.message[]（变体 2） | object | 否 |  |
| $（变体 5）.grade.feedback.message[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.grade.feedback.message[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 5）.grade.feedback.message[]（变体 2）.language | string | 否 |  |
| $（变体 5）.grade.feedback.message[]（变体 2）.startLine | integer | 是 |  |
| $（变体 5）.grade.feedback.message[]（变体 2）.text | string | 否 |  |
| $（变体 5）.grade.feedback.message[]（变体 2）.type | "code" | 否 |  |
| $（变体 5）.grade.feedback.message[]（变体 3） | object | 否 |  |
| $（变体 5）.grade.feedback.message[]（变体 3）.alt | string | 否 |  |
| $（变体 5）.grade.feedback.message[]（变体 3）.asset | string | 否 |  |
| $（变体 5）.grade.feedback.message[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 5）.grade.feedback.message[]（变体 3）.type | "image" | 否 |  |
| $（变体 5）.grade.feedback.score | object | 是 |  |
| $（变体 5）.grade.feedback.score.earned | number | 否 |  |
| $（变体 5）.grade.feedback.score.max | number | 否 |  |
| $（变体 5）.grade.feedback.slots | object | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$] | object | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].criteria | Array&lt;object&gt; | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].criteria[] | object | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].criteria[].comment | string | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].criteria[].label | string | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].criteria[].met | "yes" &#124; "no" &#124; "unsure" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].criteria[].met（变体 1） | "yes" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].criteria[].met（变体 2） | "no" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].criteria[].met（变体 3） | "unsure" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected | object &#124; object &#124; object &#124; object &#124; object | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 1） | object | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 1）.other | string | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 1）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 1）.selected[] | string | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 1）.type | "choice" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 2） | object | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 2）.text | string | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 2）.type | "text" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 3） | object | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 3）.indents | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 3）.indents[] | integer | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 3）.items | Array&lt;string&gt; | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 3）.items[] | string | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 3）.type | "order" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 4） | object | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 4）.cells | object | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 4）.cells[^.*$] | object | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$] | object &#124; object | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 1） | object | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 1）.text | string | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 1）.type | "text" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2） | object | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.other | string | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.selected[] | string | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.type | "choice" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 4）.type | "table" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 5） | object | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 5）.code | string | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].expected（变体 5）.type | "code" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].marks | object | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].marks[^.*$] | "correct" &#124; "incorrect" &#124; "missed" | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].marks[^.*$]（变体 1） | "correct" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].marks[^.*$]（变体 2） | "incorrect" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].marks[^.*$]（变体 3） | "missed" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].message | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].message[] | object &#124; object &#124; object | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].message[]（变体 1） | object | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].message[]（变体 1）.math | boolean | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].message[]（变体 1）.text | string | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].message[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].message[]（变体 2） | object | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].message[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].message[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].message[]（变体 2）.language | string | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].message[]（变体 2）.startLine | integer | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].message[]（变体 2）.text | string | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].message[]（变体 2）.type | "code" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].message[]（变体 3） | object | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].message[]（变体 3）.alt | string | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].message[]（变体 3）.asset | string | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].message[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].message[]（变体 3）.type | "image" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].score | object | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].score.earned | number | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].score.max | number | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests | Array&lt;object&gt; | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[] | object | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].detail | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].detail[] | object &#124; object &#124; object | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].detail[]（变体 1） | object | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].detail[]（变体 1）.math | boolean | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].detail[]（变体 1）.text | string | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].detail[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].detail[]（变体 2） | object | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].detail[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].detail[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].detail[]（变体 2）.language | string | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].detail[]（变体 2）.startLine | integer | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].detail[]（变体 2）.text | string | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].detail[]（变体 2）.type | "code" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].detail[]（变体 3） | object | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].detail[]（变体 3）.alt | string | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].detail[]（变体 3）.asset | string | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].detail[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].detail[]（变体 3）.type | "image" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].hidden | boolean | 是 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].name | string | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].result | "passed" &#124; "failed" &#124; "error" &#124; "timeout" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].result（变体 1） | "passed" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].result（变体 2） | "failed" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].result（变体 3） | "error" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].tests[].result（变体 4） | "timeout" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].verdict | "correct" &#124; "partial" &#124; "incorrect" &#124; "ungraded" &#124; "pending" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].verdict（变体 1） | "correct" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].verdict（变体 2） | "partial" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].verdict（变体 3） | "incorrect" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].verdict（变体 4） | "ungraded" | 否 |  |
| $（变体 5）.grade.feedback.slots[^.*$].verdict（变体 5） | "pending" | 否 |  |
| $（变体 5）.grade.feedback.verdict | "correct" &#124; "partial" &#124; "incorrect" &#124; "ungraded" &#124; "pending" | 否 |  |
| $（变体 5）.grade.feedback.verdict（变体 1） | "correct" | 否 |  |
| $（变体 5）.grade.feedback.verdict（变体 2） | "partial" | 否 |  |
| $（变体 5）.grade.feedback.verdict（变体 3） | "incorrect" | 否 |  |
| $（变体 5）.grade.feedback.verdict（变体 4） | "ungraded" | 否 |  |
| $（变体 5）.grade.feedback.verdict（变体 5） | "pending" | 否 |  |
| $（变体 5）.grade.ruleVersion | string | 否 |  |
| $（变体 5）.grade.source | unknown | 否 |  |
| $（变体 5）.projection | object | 否 |  |
| $（变体 5）.projection.deliveries | object | 否 |  |
| $（变体 5）.projection.deliveries[^.*$] | string | 是 |  |
| $（变体 5）.projection.state | object | 否 |  |
| $（变体 5）.projection.state.course | object &#124; null | 否 |  |
| $（变体 5）.projection.state.course（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.course（变体 1）.id | string | 否 |  |
| $（变体 5）.projection.state.course（变体 1）.title | string | 否 |  |
| $（变体 5）.projection.state.course（变体 1）.version | string | 否 |  |
| $（变体 5）.projection.state.course（变体 2） | null | 否 |  |
| $（变体 5）.projection.state.menu | object &#124; null | 否 |  |
| $（变体 5）.projection.state.menu（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.menu（变体 1）.availableAt | integer | 是 |  |
| $（变体 5）.projection.state.menu（变体 1）.candidates | Array&lt;object&gt; | 否 |  |
| $（变体 5）.projection.state.menu（变体 1）.candidates[] | object | 否 |  |
| $（变体 5）.projection.state.menu（变体 1）.candidates[].id | string | 否 |  |
| $（变体 5）.projection.state.menu（变体 1）.candidates[].kind | "lesson" &#124; "review" &#124; "quiz" &#124; "retake" | 否 |  |
| $（变体 5）.projection.state.menu（变体 1）.candidates[].originalTaskId | string | 是 |  |
| $（变体 5）.projection.state.menu（变体 1）.candidates[].title | string | 否 |  |
| $（变体 5）.projection.state.menu（变体 1）.candidates[].topicIds | Array&lt;string&gt; | 否 |  |
| $（变体 5）.projection.state.menu（变体 1）.candidates[].topicIds[] | string | 否 |  |
| $（变体 5）.projection.state.menu（变体 1）.menuId | string | 否 |  |
| $（变体 5）.projection.state.menu（变体 1）.unavailableReason | string | 是 |  |
| $（变体 5）.projection.state.menu（变体 2） | null | 否 |  |
| $（变体 5）.projection.state.progress | object | 否 |  |
| $（变体 5）.projection.state.progress.completedTopics | integer | 否 |  |
| $（变体 5）.projection.state.progress.completionRate | number | 否 |  |
| $（变体 5）.projection.state.progress.dailyGoalXp | integer | 否 |  |
| $（变体 5）.projection.state.progress.day | string | 否 |  |
| $（变体 5）.projection.state.progress.etaDays | number &#124; null | 否 |  |
| $（变体 5）.projection.state.progress.etaDays（变体 1） | number | 否 |  |
| $（变体 5）.projection.state.progress.etaDays（变体 2） | null | 否 |  |
| $（变体 5）.projection.state.progress.timeZone | string | 否 |  |
| $（变体 5）.projection.state.progress.todayXp | integer | 否 |  |
| $（变体 5）.projection.state.progress.totalTopics | integer | 否 |  |
| $（变体 5）.projection.state.progress.totalXp | integer | 否 |  |
| $（变体 5）.projection.state.restrictions | object | 否 |  |
| $（变体 5）.projection.state.restrictions.kind | "none" &#124; "review" &#124; "quiz" | 否 |  |
| $（变体 5）.projection.state.restrictions.referenceContentAllowed | boolean | 否 |  |
| $（变体 5）.projection.state.restrictions.tutorAllowed | boolean | 否 |  |
| $（变体 5）.projection.state.revision | integer | 否 |  |
| $（变体 5）.projection.state.serverNow | integer | 否 |  |
| $（变体 5）.projection.state.task | object &#124; null | 否 |  |
| $（变体 5）.projection.state.task（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deadlineAt | integer &#124; null | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deadlineAt（变体 1） | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deadlineAt（变体 2） | null | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries | Array&lt;object&gt; | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[] | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].deliveryId | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.body | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.body[] | object &#124; object &#124; object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 1）.math | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 1）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 2） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 2）.language | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 2）.startLine | integer | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 2）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 2）.type | "code" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 3） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 3）.alt | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 3）.asset | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 3）.type | "image" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.id | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.requires | Array&lt;string&gt; | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.requires[] | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots | Array&lt;object &#124; object &#124; object &#124; object &#124; object&gt; | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[] | object &#124; object &#124; object &#124; object &#124; object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.id | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.label | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.layout | "list" &#124; "row" &#124; "menu" | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.layout（变体 1） | "list" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.layout（变体 2） | "row" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.layout（变体 3） | "menu" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.maxSelected | integer | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.minSelected | integer | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.multiple | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.optional | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options | Array&lt;object&gt; | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[] | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[] | object &#124; object &#124; object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 1）.math | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 1）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 2） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 2）.language | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 2）.startLine | integer | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 2）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 2）.type | "code" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 3） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 3）.alt | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 3）.asset | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 3）.type | "image" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].id | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].label | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.other | object | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.other.label | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[] | object &#124; object &#124; object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 1）.math | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 1）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 2） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 2）.language | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 2）.startLine | integer | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 2）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 2）.type | "code" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 3） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 3）.alt | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 3）.asset | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 3）.type | "image" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.type | "choice" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.format | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.id | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.label | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.lines | integer | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.maxLength | integer | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.optional | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.placeholder | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[] | object &#124; object &#124; object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 1）.math | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 1）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 2） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 2）.language | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 2）.startLine | integer | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 2）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 2）.type | "code" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 3） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 3）.alt | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 3）.asset | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 3）.type | "image" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.quick | Array&lt;string&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.quick[] | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.suffix | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.type | "text" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.id | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.indent | integer | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items | Array&lt;object&gt; | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[] | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[] | object &#124; object &#124; object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 1）.math | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 1）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 2） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 2）.language | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 2）.startLine | integer | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 2）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 2）.type | "code" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 3） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 3）.alt | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 3）.asset | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 3）.type | "image" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].id | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].label | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.label | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.optional | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.partial | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[] | object &#124; object &#124; object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 1）.math | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 1）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 2） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 2）.language | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 2）.startLine | integer | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 2）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 2）.type | "code" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 3） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 3）.alt | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 3）.asset | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 3）.type | "image" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.type | "order" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.columns | Array&lt;object&gt; | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.columns[] | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.columns[].header | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.columns[].id | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.id | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.label | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.optional | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[] | object &#124; object &#124; object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 1）.math | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 1）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 2） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 2）.language | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 2）.startLine | integer | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 2）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 2）.type | "code" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 3） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 3）.alt | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 3）.asset | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 3）.type | "image" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows | Array&lt;object&gt; | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[] | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$] | object &#124; object | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 1）.value | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input | object &#124; object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.format | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.lines | integer | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.maxLength | integer | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.quick | Array&lt;string&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.quick[] | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.type | "text" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.options | Array&lt;object&gt; | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.options[] | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.options[].id | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.options[].label | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.type | "choice" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].header | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].id | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.type | "table" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.id | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.label | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.language | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.maxLines | integer | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.optional | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[] | object &#124; object &#124; object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 1）.math | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 1）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 2） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 2）.language | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 2）.startLine | integer | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 2）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 2）.type | "code" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 3） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 3）.alt | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 3）.asset | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 3）.type | "image" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.starter | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.type | "code" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.title | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].item.version | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].kpId | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].mode | "practice" &#124; "review" &#124; "quiz" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].repeated | boolean | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].requiresServices | Array&lt;string&gt; | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].requiresServices[] | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].submissionId | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.deliveries[].topicId | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.kind | "lesson" &#124; "review" &#124; "quiz" &#124; "retake" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.kps | Array&lt;object&gt; | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.kps[] | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.kps[].attempts | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.kps[].completed | boolean | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.kps[].consecutiveCorrect | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.kps[].kpId | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase | object &#124; object &#124; object &#124; object &#124; object &#124; object &#124; object &#124; object &#124; object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 1）.stage | "preparing" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.blocks | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[] | object &#124; object &#124; object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 1）.math | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 1）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 2） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 2）.language | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 2）.startLine | integer | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 2）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 2）.type | "code" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 3） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 3）.alt | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 3）.asset | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 3）.type | "image" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.offset | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.origin | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.origin.content | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.origin.content.courseId | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.origin.content.id | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.origin.content.kind | "topic" &#124; "kp" &#124; "lesson" &#124; "example" &#124; "card" &#124; "explanation" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.origin.content.kpId | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.origin.content.topicId | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.origin.content.version | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.origin.deliveryId | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.origin.taskId | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.ref | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.ref.courseId | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.ref.id | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.ref.kind | "topic" &#124; "kp" &#124; "lesson" &#124; "example" &#124; "card" &#124; "explanation" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.ref.kpId | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.ref.topicId | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.ref.version | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.page.total | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 2）.stage | "explanation" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.blocks | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[] | object &#124; object &#124; object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 1）.math | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 1）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 2） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 2）.language | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 2）.startLine | integer | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 2）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 2）.type | "code" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 3） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 3）.alt | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 3）.asset | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 3）.type | "image" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.offset | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.origin | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.origin.content | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.origin.content.courseId | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.origin.content.id | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.origin.content.kind | "topic" &#124; "kp" &#124; "lesson" &#124; "example" &#124; "card" &#124; "explanation" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.origin.content.kpId | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.origin.content.topicId | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.origin.content.version | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.origin.deliveryId | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.origin.taskId | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.ref | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.ref.courseId | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.ref.id | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.ref.kind | "topic" &#124; "kp" &#124; "lesson" &#124; "example" &#124; "card" &#124; "explanation" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.ref.kpId | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.ref.topicId | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.ref.version | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.page.total | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 3）.stage | "example" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 4） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 4）.deliveryId | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 4）.stage | "awaiting_answer" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 5） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 5）.stage | "judging" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 5）.submissionId | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 6） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 6）.stage | "recovery" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 6）.submissionId | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 7） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 7）.stage | "feedback" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 7）.submissionId | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 8） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 8）.outcome | "passed" &#124; "failed" &#124; "timeout" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 8）.stage | "completed" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 9） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 9）.reason | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.phase（变体 9）.stage | "aborted" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.startedAt | integer &#124; null | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.startedAt（变体 1） | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.startedAt（变体 2） | null | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions | Array&lt;object&gt; | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[] | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].acceptedAt | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].deliveryId | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].explanation | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].explanation[] | object &#124; object &#124; object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].explanation[]（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].explanation[]（变体 1）.math | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].explanation[]（变体 1）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].explanation[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].explanation[]（变体 2） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].explanation[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].explanation[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].explanation[]（变体 2）.language | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].explanation[]（变体 2）.startLine | integer | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].explanation[]（变体 2）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].explanation[]（变体 2）.type | "code" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].explanation[]（变体 3） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].explanation[]（变体 3）.alt | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].explanation[]（变体 3）.asset | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].explanation[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].explanation[]（变体 3）.type | "image" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback | object | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.evidence | object | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.evidence.reason | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.evidence.status | "eligible" &#124; "ineligible" &#124; "unresolved" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.item | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.item.id | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.item.version | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.judge | "rule" &#124; "tests" &#124; "model" &#124; "person" | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.judge（变体 1） | "rule" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.judge（变体 2） | "tests" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.judge（变体 3） | "model" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.judge（变体 4） | "person" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.message | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.message[] | object &#124; object &#124; object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 1）.math | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 1）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 2） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 2）.language | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 2）.startLine | integer | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 2）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 2）.type | "code" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 3） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 3）.alt | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 3）.asset | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 3）.type | "image" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.score | object | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.score.earned | number | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.score.max | number | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots | object | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$] | object | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria | Array&lt;object&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria[] | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria[].comment | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria[].label | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria[].met | "yes" &#124; "no" &#124; "unsure" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria[].met（变体 1） | "yes" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria[].met（变体 2） | "no" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria[].met（变体 3） | "unsure" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected | object &#124; object &#124; object &#124; object &#124; object | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 1）.other | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 1）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 1）.selected[] | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 1）.type | "choice" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 2） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 2）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 2）.type | "text" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 3） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 3）.indents | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 3）.indents[] | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 3）.items | Array&lt;string&gt; | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 3）.items[] | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 3）.type | "order" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$] | object | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$] | object &#124; object | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 1）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 1）.type | "text" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.other | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.selected[] | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.type | "choice" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.type | "table" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 5） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 5）.code | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 5）.type | "code" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].marks | object | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].marks[^.*$] | "correct" &#124; "incorrect" &#124; "missed" | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].marks[^.*$]（变体 1） | "correct" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].marks[^.*$]（变体 2） | "incorrect" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].marks[^.*$]（变体 3） | "missed" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[] | object &#124; object &#124; object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 1）.math | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 1）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 2） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 2）.language | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 2）.startLine | integer | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 2）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 2）.type | "code" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 3） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 3）.alt | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 3）.asset | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 3）.type | "image" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].score | object | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].score.earned | number | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].score.max | number | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests | Array&lt;object&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[] | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[] | object &#124; object &#124; object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 1）.math | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 1）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 2） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 2）.language | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 2）.startLine | integer | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 2）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 2）.type | "code" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 3） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 3）.alt | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 3）.asset | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 3）.type | "image" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].hidden | boolean | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].name | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].result | "passed" &#124; "failed" &#124; "error" &#124; "timeout" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].result（变体 1） | "passed" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].result（变体 2） | "failed" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].result（变体 3） | "error" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].result（变体 4） | "timeout" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].verdict | "correct" &#124; "partial" &#124; "incorrect" &#124; "ungraded" &#124; "pending" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].verdict（变体 1） | "correct" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].verdict（变体 2） | "partial" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].verdict（变体 3） | "incorrect" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].verdict（变体 4） | "ungraded" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].verdict（变体 5） | "pending" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.verdict | "correct" &#124; "partial" &#124; "incorrect" &#124; "ungraded" &#124; "pending" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.verdict（变体 1） | "correct" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.verdict（变体 2） | "partial" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.verdict（变体 3） | "incorrect" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.verdict（变体 4） | "ungraded" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].feedback.verdict（变体 5） | "pending" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].gradeRevision | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].processing | object &#124; object &#124; object &#124; object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].processing（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].processing（变体 1）.status | "accepted" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].processing（变体 2） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].processing（变体 2）.status | "pending" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].processing（变体 3） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].processing（变体 3）.reason | "restart" &#124; "service_failure" &#124; "uncertain_grade" &#124; "cancelled" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].processing（变体 3）.status | "interrupted" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].processing（变体 4） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].processing（变体 4）.status | "completed" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$] | object &#124; object &#124; object &#124; object &#124; object | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 1）.other | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 1）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 1）.selected[] | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 1）.type | "choice" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 2） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 2）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 2）.type | "text" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 3） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 3）.indents | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 3）.indents[] | integer | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 3）.items | Array&lt;string&gt; | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 3）.items[] | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 3）.type | "order" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$] | object | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$] | object &#124; object | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 1） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 1）.text | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 1）.type | "text" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.other | string | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.selected[] | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.type | "choice" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.type | "table" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 5） | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 5）.code | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 5）.type | "code" | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.dontKnow | true | 是 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.item | object | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.item.id | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].response.item.version | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].submissionId | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.submissions[].taskId | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.taskId | string | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.topicIds | Array&lt;string&gt; | 否 |  |
| $（变体 5）.projection.state.task（变体 1）.topicIds[] | string | 否 |  |
| $（变体 5）.projection.state.task（变体 2） | null | 否 |  |
| $（变体 5）.projection.student | object | 否 |  |
| $（变体 5）.projection.student[^.*$] | object | 是 |  |
| $（变体 5）.projection.student[^.*$].interval | number | 否 |  |
| $（变体 5）.projection.student[^.*$].lastRepetitionDay | number | 否 |  |
| $（变体 5）.projection.student[^.*$].memory | number | 否 |  |
| $（变体 5）.projection.student[^.*$].repNum | number | 否 |  |
| $（变体 5）.projection.student[^.*$].speed | number | 否 |  |
| $（变体 5）.projection.xp | object | 是 |  |
| $（变体 5）.projection.xp.consumed | integer | 否 |  |
| $（变体 5）.projection.xp.highWater | integer | 否 |  |
| $（变体 5）.projection.xp.origins | object | 否 |  |
| $（变体 5）.projection.xp.origins[^.*$] | string | 是 |  |
| $（变体 5）.projection.xp.pending | object | 是 |  |
| $（变体 5）.projection.xp.pending.atXp | integer | 否 |  |
| $（变体 5）.projection.xp.pending.id | string | 否 |  |
| $（变体 5）.projection.xp.pending.seed | integer | 否 |  |
| $（变体 5）.projection.xp.pending.topicIds | Array&lt;string&gt; | 否 |  |
| $（变体 5）.projection.xp.pending.topicIds[] | string | 否 |  |
| $（变体 5）.projection.xp.rewards | Array&lt;object&gt; | 否 |  |
| $（变体 5）.projection.xp.rewards[] | object | 否 |  |
| $（变体 5）.projection.xp.rewards[].at | integer | 否 |  |
| $（变体 5）.projection.xp.rewards[].ruleVersion | string | 否 |  |
| $（变体 5）.projection.xp.rewards[].taskId | string | 否 |  |
| $（变体 5）.projection.xp.rewards[].xp | integer | 否 |  |
| $（变体 5）.seq | integer | 否 |  |
| $（变体 5）.submission | object | 否 |  |
| $（变体 5）.submission.acceptedAt | integer | 否 |  |
| $（变体 5）.submission.deliveryId | string | 否 |  |
| $（变体 5）.submission.explanation | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 5）.submission.explanation[] | object &#124; object &#124; object | 否 |  |
| $（变体 5）.submission.explanation[]（变体 1） | object | 否 |  |
| $（变体 5）.submission.explanation[]（变体 1）.math | boolean | 是 |  |
| $（变体 5）.submission.explanation[]（变体 1）.text | string | 否 |  |
| $（变体 5）.submission.explanation[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 5）.submission.explanation[]（变体 2） | object | 否 |  |
| $（变体 5）.submission.explanation[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.submission.explanation[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 5）.submission.explanation[]（变体 2）.language | string | 否 |  |
| $（变体 5）.submission.explanation[]（变体 2）.startLine | integer | 是 |  |
| $（变体 5）.submission.explanation[]（变体 2）.text | string | 否 |  |
| $（变体 5）.submission.explanation[]（变体 2）.type | "code" | 否 |  |
| $（变体 5）.submission.explanation[]（变体 3） | object | 否 |  |
| $（变体 5）.submission.explanation[]（变体 3）.alt | string | 否 |  |
| $（变体 5）.submission.explanation[]（变体 3）.asset | string | 否 |  |
| $（变体 5）.submission.explanation[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 5）.submission.explanation[]（变体 3）.type | "image" | 否 |  |
| $（变体 5）.submission.feedback | object | 是 |  |
| $（变体 5）.submission.feedback.evidence | object | 是 |  |
| $（变体 5）.submission.feedback.evidence.reason | string | 是 |  |
| $（变体 5）.submission.feedback.evidence.status | "eligible" &#124; "ineligible" &#124; "unresolved" | 否 |  |
| $（变体 5）.submission.feedback.item | object | 否 |  |
| $（变体 5）.submission.feedback.item.id | string | 否 |  |
| $（变体 5）.submission.feedback.item.version | string | 否 |  |
| $（变体 5）.submission.feedback.judge | "rule" &#124; "tests" &#124; "model" &#124; "person" | 是 |  |
| $（变体 5）.submission.feedback.judge（变体 1） | "rule" | 否 |  |
| $（变体 5）.submission.feedback.judge（变体 2） | "tests" | 否 |  |
| $（变体 5）.submission.feedback.judge（变体 3） | "model" | 否 |  |
| $（变体 5）.submission.feedback.judge（变体 4） | "person" | 否 |  |
| $（变体 5）.submission.feedback.message | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 5）.submission.feedback.message[] | object &#124; object &#124; object | 否 |  |
| $（变体 5）.submission.feedback.message[]（变体 1） | object | 否 |  |
| $（变体 5）.submission.feedback.message[]（变体 1）.math | boolean | 是 |  |
| $（变体 5）.submission.feedback.message[]（变体 1）.text | string | 否 |  |
| $（变体 5）.submission.feedback.message[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 5）.submission.feedback.message[]（变体 2） | object | 否 |  |
| $（变体 5）.submission.feedback.message[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.submission.feedback.message[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 5）.submission.feedback.message[]（变体 2）.language | string | 否 |  |
| $（变体 5）.submission.feedback.message[]（变体 2）.startLine | integer | 是 |  |
| $（变体 5）.submission.feedback.message[]（变体 2）.text | string | 否 |  |
| $（变体 5）.submission.feedback.message[]（变体 2）.type | "code" | 否 |  |
| $（变体 5）.submission.feedback.message[]（变体 3） | object | 否 |  |
| $（变体 5）.submission.feedback.message[]（变体 3）.alt | string | 否 |  |
| $（变体 5）.submission.feedback.message[]（变体 3）.asset | string | 否 |  |
| $（变体 5）.submission.feedback.message[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 5）.submission.feedback.message[]（变体 3）.type | "image" | 否 |  |
| $（变体 5）.submission.feedback.score | object | 是 |  |
| $（变体 5）.submission.feedback.score.earned | number | 否 |  |
| $（变体 5）.submission.feedback.score.max | number | 否 |  |
| $（变体 5）.submission.feedback.slots | object | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$] | object | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].criteria | Array&lt;object&gt; | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].criteria[] | object | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].criteria[].comment | string | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].criteria[].label | string | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].criteria[].met | "yes" &#124; "no" &#124; "unsure" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].criteria[].met（变体 1） | "yes" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].criteria[].met（变体 2） | "no" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].criteria[].met（变体 3） | "unsure" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected | object &#124; object &#124; object &#124; object &#124; object | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 1） | object | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 1）.other | string | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 1）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 1）.selected[] | string | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 1）.type | "choice" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 2） | object | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 2）.text | string | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 2）.type | "text" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 3） | object | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 3）.indents | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 3）.indents[] | integer | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 3）.items | Array&lt;string&gt; | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 3）.items[] | string | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 3）.type | "order" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 4） | object | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 4）.cells | object | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 4）.cells[^.*$] | object | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$] | object &#124; object | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 1） | object | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 1）.text | string | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 1）.type | "text" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2） | object | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.other | string | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.selected[] | string | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.type | "choice" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 4）.type | "table" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 5） | object | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 5）.code | string | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].expected（变体 5）.type | "code" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].marks | object | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].marks[^.*$] | "correct" &#124; "incorrect" &#124; "missed" | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].marks[^.*$]（变体 1） | "correct" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].marks[^.*$]（变体 2） | "incorrect" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].marks[^.*$]（变体 3） | "missed" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].message | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].message[] | object &#124; object &#124; object | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].message[]（变体 1） | object | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].message[]（变体 1）.math | boolean | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].message[]（变体 1）.text | string | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].message[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].message[]（变体 2） | object | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].message[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].message[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].message[]（变体 2）.language | string | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].message[]（变体 2）.startLine | integer | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].message[]（变体 2）.text | string | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].message[]（变体 2）.type | "code" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].message[]（变体 3） | object | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].message[]（变体 3）.alt | string | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].message[]（变体 3）.asset | string | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].message[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].message[]（变体 3）.type | "image" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].score | object | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].score.earned | number | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].score.max | number | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests | Array&lt;object&gt; | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[] | object | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].detail | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].detail[] | object &#124; object &#124; object | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].detail[]（变体 1） | object | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].detail[]（变体 1）.math | boolean | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].detail[]（变体 1）.text | string | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].detail[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].detail[]（变体 2） | object | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].detail[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].detail[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].detail[]（变体 2）.language | string | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].detail[]（变体 2）.startLine | integer | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].detail[]（变体 2）.text | string | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].detail[]（变体 2）.type | "code" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].detail[]（变体 3） | object | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].detail[]（变体 3）.alt | string | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].detail[]（变体 3）.asset | string | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].detail[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].detail[]（变体 3）.type | "image" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].hidden | boolean | 是 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].name | string | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].result | "passed" &#124; "failed" &#124; "error" &#124; "timeout" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].result（变体 1） | "passed" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].result（变体 2） | "failed" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].result（变体 3） | "error" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].tests[].result（变体 4） | "timeout" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].verdict | "correct" &#124; "partial" &#124; "incorrect" &#124; "ungraded" &#124; "pending" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].verdict（变体 1） | "correct" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].verdict（变体 2） | "partial" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].verdict（变体 3） | "incorrect" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].verdict（变体 4） | "ungraded" | 否 |  |
| $（变体 5）.submission.feedback.slots[^.*$].verdict（变体 5） | "pending" | 否 |  |
| $（变体 5）.submission.feedback.verdict | "correct" &#124; "partial" &#124; "incorrect" &#124; "ungraded" &#124; "pending" | 否 |  |
| $（变体 5）.submission.feedback.verdict（变体 1） | "correct" | 否 |  |
| $（变体 5）.submission.feedback.verdict（变体 2） | "partial" | 否 |  |
| $（变体 5）.submission.feedback.verdict（变体 3） | "incorrect" | 否 |  |
| $（变体 5）.submission.feedback.verdict（变体 4） | "ungraded" | 否 |  |
| $（变体 5）.submission.feedback.verdict（变体 5） | "pending" | 否 |  |
| $（变体 5）.submission.gradeRevision | integer | 否 |  |
| $（变体 5）.submission.processing | object &#124; object &#124; object &#124; object | 否 |  |
| $（变体 5）.submission.processing（变体 1） | object | 否 |  |
| $（变体 5）.submission.processing（变体 1）.status | "accepted" | 否 |  |
| $（变体 5）.submission.processing（变体 2） | object | 否 |  |
| $（变体 5）.submission.processing（变体 2）.status | "pending" | 否 |  |
| $（变体 5）.submission.processing（变体 3） | object | 否 |  |
| $（变体 5）.submission.processing（变体 3）.reason | "restart" &#124; "service_failure" &#124; "uncertain_grade" &#124; "cancelled" | 否 |  |
| $（变体 5）.submission.processing（变体 3）.status | "interrupted" | 否 |  |
| $（变体 5）.submission.processing（变体 4） | object | 否 |  |
| $（变体 5）.submission.processing（变体 4）.status | "completed" | 否 |  |
| $（变体 5）.submission.response | object | 否 |  |
| $（变体 5）.submission.response.answers | object | 否 |  |
| $（变体 5）.submission.response.answers[^.*$] | object &#124; object &#124; object &#124; object &#124; object | 是 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 1） | object | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 1）.other | string | 是 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 1）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 1）.selected[] | string | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 1）.type | "choice" | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 2） | object | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 2）.text | string | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 2）.type | "text" | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 3） | object | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 3）.indents | Array&lt;integer&gt; | 是 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 3）.indents[] | integer | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 3）.items | Array&lt;string&gt; | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 3）.items[] | string | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 3）.type | "order" | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 4） | object | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 4）.cells | object | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 4）.cells[^.*$] | object | 是 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 4）.cells[^.*$][^.*$] | object &#124; object | 是 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 1） | object | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 1）.text | string | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 1）.type | "text" | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2） | object | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.other | string | 是 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.selected[] | string | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.type | "choice" | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 4）.type | "table" | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 5） | object | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 5）.code | string | 否 |  |
| $（变体 5）.submission.response.answers[^.*$]（变体 5）.type | "code" | 否 |  |
| $（变体 5）.submission.response.dontKnow | true | 是 |  |
| $（变体 5）.submission.response.item | object | 否 |  |
| $（变体 5）.submission.response.item.id | string | 否 |  |
| $（变体 5）.submission.response.item.version | string | 否 |  |
| $（变体 5）.submission.submissionId | string | 否 |  |
| $（变体 5）.submission.taskId | string | 否 |  |
| $（变体 5）.type | "regraded" | 否 |  |
| $（变体 5）.v | 1 | 否 |  |
| $（变体 6） | object | 否 |  |
| $（变体 6）.at | integer | 否 |  |
| $（变体 6）.grade | object | 否 |  |
| $（变体 6）.grade.feedback | object | 否 |  |
| $（变体 6）.grade.feedback.evidence | object | 是 |  |
| $（变体 6）.grade.feedback.evidence.reason | string | 是 |  |
| $（变体 6）.grade.feedback.evidence.status | "eligible" &#124; "ineligible" &#124; "unresolved" | 否 |  |
| $（变体 6）.grade.feedback.item | object | 否 |  |
| $（变体 6）.grade.feedback.item.id | string | 否 |  |
| $（变体 6）.grade.feedback.item.version | string | 否 |  |
| $（变体 6）.grade.feedback.judge | "rule" &#124; "tests" &#124; "model" &#124; "person" | 是 |  |
| $（变体 6）.grade.feedback.judge（变体 1） | "rule" | 否 |  |
| $（变体 6）.grade.feedback.judge（变体 2） | "tests" | 否 |  |
| $（变体 6）.grade.feedback.judge（变体 3） | "model" | 否 |  |
| $（变体 6）.grade.feedback.judge（变体 4） | "person" | 否 |  |
| $（变体 6）.grade.feedback.message | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 6）.grade.feedback.message[] | object &#124; object &#124; object | 否 |  |
| $（变体 6）.grade.feedback.message[]（变体 1） | object | 否 |  |
| $（变体 6）.grade.feedback.message[]（变体 1）.math | boolean | 是 |  |
| $（变体 6）.grade.feedback.message[]（变体 1）.text | string | 否 |  |
| $（变体 6）.grade.feedback.message[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 6）.grade.feedback.message[]（变体 2） | object | 否 |  |
| $（变体 6）.grade.feedback.message[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 6）.grade.feedback.message[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 6）.grade.feedback.message[]（变体 2）.language | string | 否 |  |
| $（变体 6）.grade.feedback.message[]（变体 2）.startLine | integer | 是 |  |
| $（变体 6）.grade.feedback.message[]（变体 2）.text | string | 否 |  |
| $（变体 6）.grade.feedback.message[]（变体 2）.type | "code" | 否 |  |
| $（变体 6）.grade.feedback.message[]（变体 3） | object | 否 |  |
| $（变体 6）.grade.feedback.message[]（变体 3）.alt | string | 否 |  |
| $（变体 6）.grade.feedback.message[]（变体 3）.asset | string | 否 |  |
| $（变体 6）.grade.feedback.message[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 6）.grade.feedback.message[]（变体 3）.type | "image" | 否 |  |
| $（变体 6）.grade.feedback.score | object | 是 |  |
| $（变体 6）.grade.feedback.score.earned | number | 否 |  |
| $（变体 6）.grade.feedback.score.max | number | 否 |  |
| $（变体 6）.grade.feedback.slots | object | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$] | object | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].criteria | Array&lt;object&gt; | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].criteria[] | object | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].criteria[].comment | string | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].criteria[].label | string | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].criteria[].met | "yes" &#124; "no" &#124; "unsure" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].criteria[].met（变体 1） | "yes" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].criteria[].met（变体 2） | "no" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].criteria[].met（变体 3） | "unsure" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected | object &#124; object &#124; object &#124; object &#124; object | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 1） | object | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 1）.other | string | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 1）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 1）.selected[] | string | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 1）.type | "choice" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 2） | object | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 2）.text | string | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 2）.type | "text" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 3） | object | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 3）.indents | Array&lt;integer&gt; | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 3）.indents[] | integer | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 3）.items | Array&lt;string&gt; | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 3）.items[] | string | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 3）.type | "order" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 4） | object | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 4）.cells | object | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 4）.cells[^.*$] | object | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$] | object &#124; object | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 1） | object | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 1）.text | string | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 1）.type | "text" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2） | object | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.other | string | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.selected[] | string | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.type | "choice" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 4）.type | "table" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 5） | object | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 5）.code | string | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].expected（变体 5）.type | "code" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].marks | object | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].marks[^.*$] | "correct" &#124; "incorrect" &#124; "missed" | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].marks[^.*$]（变体 1） | "correct" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].marks[^.*$]（变体 2） | "incorrect" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].marks[^.*$]（变体 3） | "missed" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].message | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].message[] | object &#124; object &#124; object | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].message[]（变体 1） | object | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].message[]（变体 1）.math | boolean | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].message[]（变体 1）.text | string | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].message[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].message[]（变体 2） | object | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].message[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].message[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].message[]（变体 2）.language | string | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].message[]（变体 2）.startLine | integer | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].message[]（变体 2）.text | string | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].message[]（变体 2）.type | "code" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].message[]（变体 3） | object | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].message[]（变体 3）.alt | string | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].message[]（变体 3）.asset | string | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].message[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].message[]（变体 3）.type | "image" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].score | object | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].score.earned | number | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].score.max | number | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests | Array&lt;object&gt; | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[] | object | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].detail | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].detail[] | object &#124; object &#124; object | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].detail[]（变体 1） | object | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].detail[]（变体 1）.math | boolean | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].detail[]（变体 1）.text | string | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].detail[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].detail[]（变体 2） | object | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].detail[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].detail[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].detail[]（变体 2）.language | string | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].detail[]（变体 2）.startLine | integer | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].detail[]（变体 2）.text | string | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].detail[]（变体 2）.type | "code" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].detail[]（变体 3） | object | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].detail[]（变体 3）.alt | string | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].detail[]（变体 3）.asset | string | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].detail[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].detail[]（变体 3）.type | "image" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].hidden | boolean | 是 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].name | string | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].result | "passed" &#124; "failed" &#124; "error" &#124; "timeout" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].result（变体 1） | "passed" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].result（变体 2） | "failed" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].result（变体 3） | "error" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].tests[].result（变体 4） | "timeout" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].verdict | "correct" &#124; "partial" &#124; "incorrect" &#124; "ungraded" &#124; "pending" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].verdict（变体 1） | "correct" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].verdict（变体 2） | "partial" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].verdict（变体 3） | "incorrect" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].verdict（变体 4） | "ungraded" | 否 |  |
| $（变体 6）.grade.feedback.slots[^.*$].verdict（变体 5） | "pending" | 否 |  |
| $（变体 6）.grade.feedback.verdict | "correct" &#124; "partial" &#124; "incorrect" &#124; "ungraded" &#124; "pending" | 否 |  |
| $（变体 6）.grade.feedback.verdict（变体 1） | "correct" | 否 |  |
| $（变体 6）.grade.feedback.verdict（变体 2） | "partial" | 否 |  |
| $（变体 6）.grade.feedback.verdict（变体 3） | "incorrect" | 否 |  |
| $（变体 6）.grade.feedback.verdict（变体 4） | "ungraded" | 否 |  |
| $（变体 6）.grade.feedback.verdict（变体 5） | "pending" | 否 |  |
| $（变体 6）.grade.ruleVersion | string | 否 |  |
| $（变体 6）.grade.source | unknown | 否 |  |
| $（变体 6）.projection | object | 否 |  |
| $（变体 6）.projection.deliveries | object | 否 |  |
| $（变体 6）.projection.deliveries[^.*$] | string | 是 |  |
| $（变体 6）.projection.state | object | 否 |  |
| $（变体 6）.projection.state.course | object &#124; null | 否 |  |
| $（变体 6）.projection.state.course（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.course（变体 1）.id | string | 否 |  |
| $（变体 6）.projection.state.course（变体 1）.title | string | 否 |  |
| $（变体 6）.projection.state.course（变体 1）.version | string | 否 |  |
| $（变体 6）.projection.state.course（变体 2） | null | 否 |  |
| $（变体 6）.projection.state.menu | object &#124; null | 否 |  |
| $（变体 6）.projection.state.menu（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.menu（变体 1）.availableAt | integer | 是 |  |
| $（变体 6）.projection.state.menu（变体 1）.candidates | Array&lt;object&gt; | 否 |  |
| $（变体 6）.projection.state.menu（变体 1）.candidates[] | object | 否 |  |
| $（变体 6）.projection.state.menu（变体 1）.candidates[].id | string | 否 |  |
| $（变体 6）.projection.state.menu（变体 1）.candidates[].kind | "lesson" &#124; "review" &#124; "quiz" &#124; "retake" | 否 |  |
| $（变体 6）.projection.state.menu（变体 1）.candidates[].originalTaskId | string | 是 |  |
| $（变体 6）.projection.state.menu（变体 1）.candidates[].title | string | 否 |  |
| $（变体 6）.projection.state.menu（变体 1）.candidates[].topicIds | Array&lt;string&gt; | 否 |  |
| $（变体 6）.projection.state.menu（变体 1）.candidates[].topicIds[] | string | 否 |  |
| $（变体 6）.projection.state.menu（变体 1）.menuId | string | 否 |  |
| $（变体 6）.projection.state.menu（变体 1）.unavailableReason | string | 是 |  |
| $（变体 6）.projection.state.menu（变体 2） | null | 否 |  |
| $（变体 6）.projection.state.progress | object | 否 |  |
| $（变体 6）.projection.state.progress.completedTopics | integer | 否 |  |
| $（变体 6）.projection.state.progress.completionRate | number | 否 |  |
| $（变体 6）.projection.state.progress.dailyGoalXp | integer | 否 |  |
| $（变体 6）.projection.state.progress.day | string | 否 |  |
| $（变体 6）.projection.state.progress.etaDays | number &#124; null | 否 |  |
| $（变体 6）.projection.state.progress.etaDays（变体 1） | number | 否 |  |
| $（变体 6）.projection.state.progress.etaDays（变体 2） | null | 否 |  |
| $（变体 6）.projection.state.progress.timeZone | string | 否 |  |
| $（变体 6）.projection.state.progress.todayXp | integer | 否 |  |
| $（变体 6）.projection.state.progress.totalTopics | integer | 否 |  |
| $（变体 6）.projection.state.progress.totalXp | integer | 否 |  |
| $（变体 6）.projection.state.restrictions | object | 否 |  |
| $（变体 6）.projection.state.restrictions.kind | "none" &#124; "review" &#124; "quiz" | 否 |  |
| $（变体 6）.projection.state.restrictions.referenceContentAllowed | boolean | 否 |  |
| $（变体 6）.projection.state.restrictions.tutorAllowed | boolean | 否 |  |
| $（变体 6）.projection.state.revision | integer | 否 |  |
| $（变体 6）.projection.state.serverNow | integer | 否 |  |
| $（变体 6）.projection.state.task | object &#124; null | 否 |  |
| $（变体 6）.projection.state.task（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deadlineAt | integer &#124; null | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deadlineAt（变体 1） | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deadlineAt（变体 2） | null | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries | Array&lt;object&gt; | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[] | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].deliveryId | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.body | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.body[] | object &#124; object &#124; object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 1）.math | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 1）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 2） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 2）.language | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 2）.startLine | integer | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 2）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 2）.type | "code" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 3） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 3）.alt | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 3）.asset | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.body[]（变体 3）.type | "image" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.id | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.requires | Array&lt;string&gt; | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.requires[] | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots | Array&lt;object &#124; object &#124; object &#124; object &#124; object&gt; | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[] | object &#124; object &#124; object &#124; object &#124; object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.id | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.label | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.layout | "list" &#124; "row" &#124; "menu" | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.layout（变体 1） | "list" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.layout（变体 2） | "row" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.layout（变体 3） | "menu" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.maxSelected | integer | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.minSelected | integer | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.multiple | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.optional | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options | Array&lt;object&gt; | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[] | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[] | object &#124; object &#124; object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 1）.math | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 1）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 2） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 2）.language | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 2）.startLine | integer | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 2）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 2）.type | "code" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 3） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 3）.alt | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 3）.asset | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].content[]（变体 3）.type | "image" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].id | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.options[].label | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.other | object | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.other.label | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[] | object &#124; object &#124; object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 1）.math | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 1）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 2） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 2）.language | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 2）.startLine | integer | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 2）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 2）.type | "code" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 3） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 3）.alt | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 3）.asset | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.prompt[]（变体 3）.type | "image" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 1）.type | "choice" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.format | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.id | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.label | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.lines | integer | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.maxLength | integer | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.optional | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.placeholder | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[] | object &#124; object &#124; object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 1）.math | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 1）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 2） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 2）.language | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 2）.startLine | integer | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 2）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 2）.type | "code" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 3） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 3）.alt | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 3）.asset | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.prompt[]（变体 3）.type | "image" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.quick | Array&lt;string&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.quick[] | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.suffix | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 2）.type | "text" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.id | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.indent | integer | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items | Array&lt;object&gt; | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[] | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[] | object &#124; object &#124; object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 1）.math | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 1）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 2） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 2）.language | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 2）.startLine | integer | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 2）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 2）.type | "code" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 3） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 3）.alt | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 3）.asset | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].content[]（变体 3）.type | "image" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].id | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.items[].label | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.label | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.optional | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.partial | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[] | object &#124; object &#124; object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 1）.math | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 1）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 2） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 2）.language | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 2）.startLine | integer | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 2）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 2）.type | "code" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 3） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 3）.alt | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 3）.asset | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.prompt[]（变体 3）.type | "image" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 3）.type | "order" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.columns | Array&lt;object&gt; | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.columns[] | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.columns[].header | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.columns[].id | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.id | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.label | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.optional | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[] | object &#124; object &#124; object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 1）.math | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 1）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 2） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 2）.language | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 2）.startLine | integer | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 2）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 2）.type | "code" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 3） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 3）.alt | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 3）.asset | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.prompt[]（变体 3）.type | "image" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows | Array&lt;object&gt; | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[] | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$] | object &#124; object | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 1）.value | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input | object &#124; object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.format | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.lines | integer | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.maxLength | integer | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.quick | Array&lt;string&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.quick[] | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.type | "text" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.options | Array&lt;object&gt; | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.options[] | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.options[].id | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.options[].label | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.type | "choice" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].header | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.rows[].id | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 4）.type | "table" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.id | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.label | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.language | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.maxLines | integer | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.optional | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[] | object &#124; object &#124; object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 1）.math | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 1）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 2） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 2）.language | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 2）.startLine | integer | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 2）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 2）.type | "code" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 3） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 3）.alt | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 3）.asset | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.prompt[]（变体 3）.type | "image" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.starter | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.slots[]（变体 5）.type | "code" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.title | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].item.version | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].kpId | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].mode | "practice" &#124; "review" &#124; "quiz" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].repeated | boolean | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].requiresServices | Array&lt;string&gt; | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].requiresServices[] | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].submissionId | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.deliveries[].topicId | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.kind | "lesson" &#124; "review" &#124; "quiz" &#124; "retake" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.kps | Array&lt;object&gt; | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.kps[] | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.kps[].attempts | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.kps[].completed | boolean | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.kps[].consecutiveCorrect | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.kps[].kpId | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase | object &#124; object &#124; object &#124; object &#124; object &#124; object &#124; object &#124; object &#124; object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 1）.stage | "preparing" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.blocks | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[] | object &#124; object &#124; object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 1）.math | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 1）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 2） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 2）.language | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 2）.startLine | integer | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 2）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 2）.type | "code" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 3） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 3）.alt | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 3）.asset | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.blocks[]（变体 3）.type | "image" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.offset | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.origin | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.origin.content | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.origin.content.courseId | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.origin.content.id | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.origin.content.kind | "topic" &#124; "kp" &#124; "lesson" &#124; "example" &#124; "card" &#124; "explanation" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.origin.content.kpId | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.origin.content.topicId | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.origin.content.version | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.origin.deliveryId | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.origin.taskId | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.ref | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.ref.courseId | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.ref.id | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.ref.kind | "topic" &#124; "kp" &#124; "lesson" &#124; "example" &#124; "card" &#124; "explanation" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.ref.kpId | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.ref.topicId | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.ref.version | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.page.total | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 2）.stage | "explanation" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.blocks | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[] | object &#124; object &#124; object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 1）.math | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 1）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 2） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 2）.language | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 2）.startLine | integer | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 2）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 2）.type | "code" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 3） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 3）.alt | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 3）.asset | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.blocks[]（变体 3）.type | "image" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.offset | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.origin | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.origin.content | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.origin.content.courseId | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.origin.content.id | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.origin.content.kind | "topic" &#124; "kp" &#124; "lesson" &#124; "example" &#124; "card" &#124; "explanation" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.origin.content.kpId | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.origin.content.topicId | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.origin.content.version | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.origin.deliveryId | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.origin.taskId | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.ref | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.ref.courseId | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.ref.id | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.ref.kind | "topic" &#124; "kp" &#124; "lesson" &#124; "example" &#124; "card" &#124; "explanation" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.ref.kpId | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.ref.topicId | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.ref.version | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.page.total | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 3）.stage | "example" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 4） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 4）.deliveryId | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 4）.stage | "awaiting_answer" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 5） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 5）.stage | "judging" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 5）.submissionId | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 6） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 6）.stage | "recovery" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 6）.submissionId | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 7） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 7）.stage | "feedback" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 7）.submissionId | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 8） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 8）.outcome | "passed" &#124; "failed" &#124; "timeout" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 8）.stage | "completed" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 9） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 9）.reason | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.phase（变体 9）.stage | "aborted" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.startedAt | integer &#124; null | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.startedAt（变体 1） | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.startedAt（变体 2） | null | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions | Array&lt;object&gt; | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[] | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].acceptedAt | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].deliveryId | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].explanation | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].explanation[] | object &#124; object &#124; object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].explanation[]（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].explanation[]（变体 1）.math | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].explanation[]（变体 1）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].explanation[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].explanation[]（变体 2） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].explanation[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].explanation[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].explanation[]（变体 2）.language | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].explanation[]（变体 2）.startLine | integer | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].explanation[]（变体 2）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].explanation[]（变体 2）.type | "code" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].explanation[]（变体 3） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].explanation[]（变体 3）.alt | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].explanation[]（变体 3）.asset | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].explanation[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].explanation[]（变体 3）.type | "image" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback | object | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.evidence | object | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.evidence.reason | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.evidence.status | "eligible" &#124; "ineligible" &#124; "unresolved" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.item | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.item.id | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.item.version | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.judge | "rule" &#124; "tests" &#124; "model" &#124; "person" | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.judge（变体 1） | "rule" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.judge（变体 2） | "tests" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.judge（变体 3） | "model" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.judge（变体 4） | "person" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.message | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.message[] | object &#124; object &#124; object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 1）.math | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 1）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 2） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 2）.language | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 2）.startLine | integer | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 2）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 2）.type | "code" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 3） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 3）.alt | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 3）.asset | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.message[]（变体 3）.type | "image" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.score | object | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.score.earned | number | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.score.max | number | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots | object | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$] | object | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria | Array&lt;object&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria[] | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria[].comment | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria[].label | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria[].met | "yes" &#124; "no" &#124; "unsure" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria[].met（变体 1） | "yes" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria[].met（变体 2） | "no" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].criteria[].met（变体 3） | "unsure" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected | object &#124; object &#124; object &#124; object &#124; object | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 1）.other | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 1）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 1）.selected[] | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 1）.type | "choice" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 2） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 2）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 2）.type | "text" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 3） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 3）.indents | Array&lt;integer&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 3）.indents[] | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 3）.items | Array&lt;string&gt; | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 3）.items[] | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 3）.type | "order" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$] | object | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$] | object &#124; object | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 1）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 1）.type | "text" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.other | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.selected[] | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.cells[^.*$][^.*$]（变体 2）.type | "choice" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 4）.type | "table" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 5） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 5）.code | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].expected（变体 5）.type | "code" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].marks | object | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].marks[^.*$] | "correct" &#124; "incorrect" &#124; "missed" | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].marks[^.*$]（变体 1） | "correct" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].marks[^.*$]（变体 2） | "incorrect" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].marks[^.*$]（变体 3） | "missed" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[] | object &#124; object &#124; object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 1）.math | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 1）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 2） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 2）.language | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 2）.startLine | integer | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 2）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 2）.type | "code" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 3） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 3）.alt | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 3）.asset | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].message[]（变体 3）.type | "image" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].score | object | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].score.earned | number | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].score.max | number | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests | Array&lt;object&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[] | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[] | object &#124; object &#124; object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 1）.math | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 1）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 2） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 2）.language | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 2）.startLine | integer | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 2）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 2）.type | "code" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 3） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 3）.alt | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 3）.asset | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].detail[]（变体 3）.type | "image" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].hidden | boolean | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].name | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].result | "passed" &#124; "failed" &#124; "error" &#124; "timeout" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].result（变体 1） | "passed" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].result（变体 2） | "failed" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].result（变体 3） | "error" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].tests[].result（变体 4） | "timeout" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].verdict | "correct" &#124; "partial" &#124; "incorrect" &#124; "ungraded" &#124; "pending" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].verdict（变体 1） | "correct" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].verdict（变体 2） | "partial" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].verdict（变体 3） | "incorrect" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].verdict（变体 4） | "ungraded" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.slots[^.*$].verdict（变体 5） | "pending" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.verdict | "correct" &#124; "partial" &#124; "incorrect" &#124; "ungraded" &#124; "pending" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.verdict（变体 1） | "correct" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.verdict（变体 2） | "partial" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.verdict（变体 3） | "incorrect" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.verdict（变体 4） | "ungraded" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].feedback.verdict（变体 5） | "pending" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].gradeRevision | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].processing | object &#124; object &#124; object &#124; object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].processing（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].processing（变体 1）.status | "accepted" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].processing（变体 2） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].processing（变体 2）.status | "pending" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].processing（变体 3） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].processing（变体 3）.reason | "restart" &#124; "service_failure" &#124; "uncertain_grade" &#124; "cancelled" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].processing（变体 3）.status | "interrupted" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].processing（变体 4） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].processing（变体 4）.status | "completed" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$] | object &#124; object &#124; object &#124; object &#124; object | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 1）.other | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 1）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 1）.selected[] | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 1）.type | "choice" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 2） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 2）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 2）.type | "text" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 3） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 3）.indents | Array&lt;integer&gt; | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 3）.indents[] | integer | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 3）.items | Array&lt;string&gt; | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 3）.items[] | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 3）.type | "order" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$] | object | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$] | object &#124; object | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 1） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 1）.text | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 1）.type | "text" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.other | string | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.selected | Array&lt;string&gt; | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.selected[] | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.type | "choice" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 4）.type | "table" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 5） | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 5）.code | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.answers[^.*$]（变体 5）.type | "code" | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.dontKnow | true | 是 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.item | object | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.item.id | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].response.item.version | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].submissionId | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.submissions[].taskId | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.taskId | string | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.topicIds | Array&lt;string&gt; | 否 |  |
| $（变体 6）.projection.state.task（变体 1）.topicIds[] | string | 否 |  |
| $（变体 6）.projection.state.task（变体 2） | null | 否 |  |
| $（变体 6）.projection.student | object | 否 |  |
| $（变体 6）.projection.student[^.*$] | object | 是 |  |
| $（变体 6）.projection.student[^.*$].interval | number | 否 |  |
| $（变体 6）.projection.student[^.*$].lastRepetitionDay | number | 否 |  |
| $（变体 6）.projection.student[^.*$].memory | number | 否 |  |
| $（变体 6）.projection.student[^.*$].repNum | number | 否 |  |
| $（变体 6）.projection.student[^.*$].speed | number | 否 |  |
| $（变体 6）.projection.xp | object | 是 |  |
| $（变体 6）.projection.xp.consumed | integer | 否 |  |
| $（变体 6）.projection.xp.highWater | integer | 否 |  |
| $（变体 6）.projection.xp.origins | object | 否 |  |
| $（变体 6）.projection.xp.origins[^.*$] | string | 是 |  |
| $（变体 6）.projection.xp.pending | object | 是 |  |
| $（变体 6）.projection.xp.pending.atXp | integer | 否 |  |
| $（变体 6）.projection.xp.pending.id | string | 否 |  |
| $（变体 6）.projection.xp.pending.seed | integer | 否 |  |
| $（变体 6）.projection.xp.pending.topicIds | Array&lt;string&gt; | 否 |  |
| $（变体 6）.projection.xp.pending.topicIds[] | string | 否 |  |
| $（变体 6）.projection.xp.rewards | Array&lt;object&gt; | 否 |  |
| $（变体 6）.projection.xp.rewards[] | object | 否 |  |
| $（变体 6）.projection.xp.rewards[].at | integer | 否 |  |
| $（变体 6）.projection.xp.rewards[].ruleVersion | string | 否 |  |
| $（变体 6）.projection.xp.rewards[].taskId | string | 否 |  |
| $（变体 6）.projection.xp.rewards[].xp | integer | 否 |  |
| $（变体 6）.seq | integer | 否 |  |
| $（变体 6）.submissionId | string | 否 |  |
| $（变体 6）.type | "graded" | 否 |  |
| $（变体 6）.v | 1 | 否 |  |
| $（变体 7） | object | 否 |  |
| $（变体 7）.action | "explanation" &#124; "card" &#124; "kp" &#124; "help_before" &#124; "help_after" | 否 |  |
| $（变体 7）.at | integer | 否 |  |
| $（变体 7）.deliveryId | string | 是 |  |
| $（变体 7）.ref | object | 否 |  |
| $（变体 7）.ref.courseId | string | 否 |  |
| $（变体 7）.ref.id | string | 否 |  |
| $（变体 7）.ref.kind | "topic" &#124; "kp" &#124; "lesson" &#124; "example" &#124; "card" &#124; "explanation" | 否 |  |
| $（变体 7）.ref.kpId | string | 是 |  |
| $（变体 7）.ref.topicId | string | 否 |  |
| $（变体 7）.ref.version | string | 否 |  |
| $（变体 7）.seq | integer | 否 |  |
| $（变体 7）.taskId | string | 否 |  |
| $（变体 7）.type | "viewed" | 否 |  |
| $（变体 7）.v | 1 | 否 |  |
