<!-- 由 scripts/docs/gen-protocol.ts 生成，不要手改。 -->

# 前后端协议

## 方法：agent.list

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | Array&lt;object&gt; | 否 |  |
| $[] | object | 否 |  |
| $[].description | string | 是 |  |
| $[].direct | boolean | 否 |  |
| $[].id | string | 否 |  |

## 通知：ask.closed

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| id | string | 否 |  |
| reason | "answered" &#124; "cancelled" &#124; "aborted" &#124; "closed" | 否 |  |
| reason（变体 1） | "answered" | 否 |  |
| reason（变体 2） | "cancelled" | 否 |  |
| reason（变体 3） | "aborted" | 否 |  |
| reason（变体 4） | "closed" | 否 |  |

## 方法：ask.reply

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| action | "submit" &#124; "decline" &#124; "cancel" &#124; "unsupported" | 否 |  |
| action（变体 1） | "submit" | 否 |  |
| action（变体 2） | "decline" | 否 |  |
| action（变体 3） | "cancel" | 否 |  |
| action（变体 4） | "unsupported" | 否 |  |
| id | string | 否 |  |
| message | string | 是 |  |
| response | object | 是 |  |
| response.answers | object | 否 |  |
| response.answers[^.*$] | object &#124; object &#124; object &#124; object &#124; object | 是 |  |
| response.answers[^.*$]（变体 1） | object | 否 |  |
| response.answers[^.*$]（变体 1）.other | string | 是 |  |
| response.answers[^.*$]（变体 1）.selected | Array&lt;string&gt; | 否 |  |
| response.answers[^.*$]（变体 1）.selected[] | string | 否 |  |
| response.answers[^.*$]（变体 1）.type | "choice" | 否 |  |
| response.answers[^.*$]（变体 2） | object | 否 |  |
| response.answers[^.*$]（变体 2）.text | string | 否 |  |
| response.answers[^.*$]（变体 2）.type | "text" | 否 |  |
| response.answers[^.*$]（变体 3） | object | 否 |  |
| response.answers[^.*$]（变体 3）.indents | Array&lt;integer&gt; | 是 |  |
| response.answers[^.*$]（变体 3）.indents[] | integer | 否 |  |
| response.answers[^.*$]（变体 3）.items | Array&lt;string&gt; | 否 |  |
| response.answers[^.*$]（变体 3）.items[] | string | 否 |  |
| response.answers[^.*$]（变体 3）.type | "order" | 否 |  |
| response.answers[^.*$]（变体 4） | object | 否 |  |
| response.answers[^.*$]（变体 4）.cells | object | 否 |  |
| response.answers[^.*$]（变体 4）.cells[^.*$] | object | 是 |  |
| response.answers[^.*$]（变体 4）.cells[^.*$][^.*$] | object &#124; object | 是 |  |
| response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 1） | object | 否 |  |
| response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 1）.text | string | 否 |  |
| response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 1）.type | "text" | 否 |  |
| response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2） | object | 否 |  |
| response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.other | string | 是 |  |
| response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.selected | Array&lt;string&gt; | 否 |  |
| response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.selected[] | string | 否 |  |
| response.answers[^.*$]（变体 4）.cells[^.*$][^.*$]（变体 2）.type | "choice" | 否 |  |
| response.answers[^.*$]（变体 4）.type | "table" | 否 |  |
| response.answers[^.*$]（变体 5） | object | 否 |  |
| response.answers[^.*$]（变体 5）.code | string | 否 |  |
| response.answers[^.*$]（变体 5）.type | "code" | 否 |  |
| response.item | object | 否 |  |
| response.item.id | string | 否 |  |
| response.item.version | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object &#124; object &#124; null | 否 |  |
| $（变体 1） | object &#124; object | 否 |  |
| $（变体 1）（变体 1） | object | 否 |  |
| $（变体 1）（变体 1）.problems | Array&lt;object&gt; | 否 |  |
| $（变体 1）（变体 1）.problems[] | object | 否 |  |
| $（变体 1）（变体 1）.problems[].message | string | 否 |  |
| $（变体 1）（变体 1）.problems[].slot | string | 是 |  |
| $（变体 1）（变体 1）.status | "invalid" | 否 |  |
| $（变体 1）（变体 2） | object | 否 |  |
| $（变体 1）（变体 2）.message | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| $（变体 1）（变体 2）.message[] | object &#124; object &#124; object | 否 |  |
| $（变体 1）（变体 2）.message[]（变体 1） | object | 否 |  |
| $（变体 1）（变体 2）.message[]（变体 1）.math | boolean | 是 |  |
| $（变体 1）（变体 2）.message[]（变体 1）.text | string | 否 |  |
| $（变体 1）（变体 2）.message[]（变体 1）.type | "markdown" | 否 |  |
| $（变体 1）（变体 2）.message[]（变体 2） | object | 否 |  |
| $（变体 1）（变体 2）.message[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| $（变体 1）（变体 2）.message[]（变体 2）.highlight[] | integer | 否 |  |
| $（变体 1）（变体 2）.message[]（变体 2）.language | string | 否 |  |
| $（变体 1）（变体 2）.message[]（变体 2）.startLine | integer | 是 |  |
| $（变体 1）（变体 2）.message[]（变体 2）.text | string | 否 |  |
| $（变体 1）（变体 2）.message[]（变体 2）.type | "code" | 否 |  |
| $（变体 1）（变体 2）.message[]（变体 3） | object | 否 |  |
| $（变体 1）（变体 2）.message[]（变体 3）.alt | string | 否 |  |
| $（变体 1）（变体 2）.message[]（变体 3）.asset | string | 否 |  |
| $（变体 1）（变体 2）.message[]（变体 3）.decorative | boolean | 是 |  |
| $（变体 1）（变体 2）.message[]（变体 3）.type | "image" | 否 |  |
| $（变体 1）（变体 2）.status | "accepted" | 否 |  |
| $（变体 2） | null | 否 |  |

## 通知：ask.request

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| id | string | 否 |  |
| item | object | 否 |  |
| item.body | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| item.body[] | object &#124; object &#124; object | 否 |  |
| item.body[]（变体 1） | object | 否 |  |
| item.body[]（变体 1）.math | boolean | 是 |  |
| item.body[]（变体 1）.text | string | 否 |  |
| item.body[]（变体 1）.type | "markdown" | 否 |  |
| item.body[]（变体 2） | object | 否 |  |
| item.body[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| item.body[]（变体 2）.highlight[] | integer | 否 |  |
| item.body[]（变体 2）.language | string | 否 |  |
| item.body[]（变体 2）.startLine | integer | 是 |  |
| item.body[]（变体 2）.text | string | 否 |  |
| item.body[]（变体 2）.type | "code" | 否 |  |
| item.body[]（变体 3） | object | 否 |  |
| item.body[]（变体 3）.alt | string | 否 |  |
| item.body[]（变体 3）.asset | string | 否 |  |
| item.body[]（变体 3）.decorative | boolean | 是 |  |
| item.body[]（变体 3）.type | "image" | 否 |  |
| item.id | string | 否 |  |
| item.requires | Array&lt;string&gt; | 否 |  |
| item.requires[] | string | 否 |  |
| item.slots | Array&lt;object &#124; object &#124; object &#124; object &#124; object&gt; | 否 |  |
| item.slots[] | object &#124; object &#124; object &#124; object &#124; object | 否 |  |
| item.slots[]（变体 1） | object | 否 |  |
| item.slots[]（变体 1）.id | string | 否 |  |
| item.slots[]（变体 1）.label | string | 是 |  |
| item.slots[]（变体 1）.layout | "list" &#124; "row" &#124; "menu" | 是 |  |
| item.slots[]（变体 1）.layout（变体 1） | "list" | 否 |  |
| item.slots[]（变体 1）.layout（变体 2） | "row" | 否 |  |
| item.slots[]（变体 1）.layout（变体 3） | "menu" | 否 |  |
| item.slots[]（变体 1）.maxSelected | integer | 是 |  |
| item.slots[]（变体 1）.minSelected | integer | 是 |  |
| item.slots[]（变体 1）.multiple | boolean | 是 |  |
| item.slots[]（变体 1）.optional | boolean | 是 |  |
| item.slots[]（变体 1）.options | Array&lt;object&gt; | 否 |  |
| item.slots[]（变体 1）.options[] | object | 否 |  |
| item.slots[]（变体 1）.options[].content | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| item.slots[]（变体 1）.options[].content[] | object &#124; object &#124; object | 否 |  |
| item.slots[]（变体 1）.options[].content[]（变体 1） | object | 否 |  |
| item.slots[]（变体 1）.options[].content[]（变体 1）.math | boolean | 是 |  |
| item.slots[]（变体 1）.options[].content[]（变体 1）.text | string | 否 |  |
| item.slots[]（变体 1）.options[].content[]（变体 1）.type | "markdown" | 否 |  |
| item.slots[]（变体 1）.options[].content[]（变体 2） | object | 否 |  |
| item.slots[]（变体 1）.options[].content[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| item.slots[]（变体 1）.options[].content[]（变体 2）.highlight[] | integer | 否 |  |
| item.slots[]（变体 1）.options[].content[]（变体 2）.language | string | 否 |  |
| item.slots[]（变体 1）.options[].content[]（变体 2）.startLine | integer | 是 |  |
| item.slots[]（变体 1）.options[].content[]（变体 2）.text | string | 否 |  |
| item.slots[]（变体 1）.options[].content[]（变体 2）.type | "code" | 否 |  |
| item.slots[]（变体 1）.options[].content[]（变体 3） | object | 否 |  |
| item.slots[]（变体 1）.options[].content[]（变体 3）.alt | string | 否 |  |
| item.slots[]（变体 1）.options[].content[]（变体 3）.asset | string | 否 |  |
| item.slots[]（变体 1）.options[].content[]（变体 3）.decorative | boolean | 是 |  |
| item.slots[]（变体 1）.options[].content[]（变体 3）.type | "image" | 否 |  |
| item.slots[]（变体 1）.options[].id | string | 否 |  |
| item.slots[]（变体 1）.options[].label | string | 是 |  |
| item.slots[]（变体 1）.other | object | 是 |  |
| item.slots[]（变体 1）.other.label | string | 否 |  |
| item.slots[]（变体 1）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| item.slots[]（变体 1）.prompt[] | object &#124; object &#124; object | 否 |  |
| item.slots[]（变体 1）.prompt[]（变体 1） | object | 否 |  |
| item.slots[]（变体 1）.prompt[]（变体 1）.math | boolean | 是 |  |
| item.slots[]（变体 1）.prompt[]（变体 1）.text | string | 否 |  |
| item.slots[]（变体 1）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| item.slots[]（变体 1）.prompt[]（变体 2） | object | 否 |  |
| item.slots[]（变体 1）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| item.slots[]（变体 1）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| item.slots[]（变体 1）.prompt[]（变体 2）.language | string | 否 |  |
| item.slots[]（变体 1）.prompt[]（变体 2）.startLine | integer | 是 |  |
| item.slots[]（变体 1）.prompt[]（变体 2）.text | string | 否 |  |
| item.slots[]（变体 1）.prompt[]（变体 2）.type | "code" | 否 |  |
| item.slots[]（变体 1）.prompt[]（变体 3） | object | 否 |  |
| item.slots[]（变体 1）.prompt[]（变体 3）.alt | string | 否 |  |
| item.slots[]（变体 1）.prompt[]（变体 3）.asset | string | 否 |  |
| item.slots[]（变体 1）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| item.slots[]（变体 1）.prompt[]（变体 3）.type | "image" | 否 |  |
| item.slots[]（变体 1）.type | "choice" | 否 |  |
| item.slots[]（变体 2） | object | 否 |  |
| item.slots[]（变体 2）.format | string | 是 |  |
| item.slots[]（变体 2）.id | string | 否 |  |
| item.slots[]（变体 2）.label | string | 是 |  |
| item.slots[]（变体 2）.lines | integer | 是 |  |
| item.slots[]（变体 2）.maxLength | integer | 是 |  |
| item.slots[]（变体 2）.optional | boolean | 是 |  |
| item.slots[]（变体 2）.placeholder | string | 是 |  |
| item.slots[]（变体 2）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| item.slots[]（变体 2）.prompt[] | object &#124; object &#124; object | 否 |  |
| item.slots[]（变体 2）.prompt[]（变体 1） | object | 否 |  |
| item.slots[]（变体 2）.prompt[]（变体 1）.math | boolean | 是 |  |
| item.slots[]（变体 2）.prompt[]（变体 1）.text | string | 否 |  |
| item.slots[]（变体 2）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| item.slots[]（变体 2）.prompt[]（变体 2） | object | 否 |  |
| item.slots[]（变体 2）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| item.slots[]（变体 2）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| item.slots[]（变体 2）.prompt[]（变体 2）.language | string | 否 |  |
| item.slots[]（变体 2）.prompt[]（变体 2）.startLine | integer | 是 |  |
| item.slots[]（变体 2）.prompt[]（变体 2）.text | string | 否 |  |
| item.slots[]（变体 2）.prompt[]（变体 2）.type | "code" | 否 |  |
| item.slots[]（变体 2）.prompt[]（变体 3） | object | 否 |  |
| item.slots[]（变体 2）.prompt[]（变体 3）.alt | string | 否 |  |
| item.slots[]（变体 2）.prompt[]（变体 3）.asset | string | 否 |  |
| item.slots[]（变体 2）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| item.slots[]（变体 2）.prompt[]（变体 3）.type | "image" | 否 |  |
| item.slots[]（变体 2）.quick | Array&lt;string&gt; | 是 |  |
| item.slots[]（变体 2）.quick[] | string | 否 |  |
| item.slots[]（变体 2）.suffix | string | 是 |  |
| item.slots[]（变体 2）.type | "text" | 否 |  |
| item.slots[]（变体 3） | object | 否 |  |
| item.slots[]（变体 3）.id | string | 否 |  |
| item.slots[]（变体 3）.indent | integer | 是 |  |
| item.slots[]（变体 3）.items | Array&lt;object&gt; | 否 |  |
| item.slots[]（变体 3）.items[] | object | 否 |  |
| item.slots[]（变体 3）.items[].content | Array&lt;object &#124; object &#124; object&gt; | 否 |  |
| item.slots[]（变体 3）.items[].content[] | object &#124; object &#124; object | 否 |  |
| item.slots[]（变体 3）.items[].content[]（变体 1） | object | 否 |  |
| item.slots[]（变体 3）.items[].content[]（变体 1）.math | boolean | 是 |  |
| item.slots[]（变体 3）.items[].content[]（变体 1）.text | string | 否 |  |
| item.slots[]（变体 3）.items[].content[]（变体 1）.type | "markdown" | 否 |  |
| item.slots[]（变体 3）.items[].content[]（变体 2） | object | 否 |  |
| item.slots[]（变体 3）.items[].content[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| item.slots[]（变体 3）.items[].content[]（变体 2）.highlight[] | integer | 否 |  |
| item.slots[]（变体 3）.items[].content[]（变体 2）.language | string | 否 |  |
| item.slots[]（变体 3）.items[].content[]（变体 2）.startLine | integer | 是 |  |
| item.slots[]（变体 3）.items[].content[]（变体 2）.text | string | 否 |  |
| item.slots[]（变体 3）.items[].content[]（变体 2）.type | "code" | 否 |  |
| item.slots[]（变体 3）.items[].content[]（变体 3） | object | 否 |  |
| item.slots[]（变体 3）.items[].content[]（变体 3）.alt | string | 否 |  |
| item.slots[]（变体 3）.items[].content[]（变体 3）.asset | string | 否 |  |
| item.slots[]（变体 3）.items[].content[]（变体 3）.decorative | boolean | 是 |  |
| item.slots[]（变体 3）.items[].content[]（变体 3）.type | "image" | 否 |  |
| item.slots[]（变体 3）.items[].id | string | 否 |  |
| item.slots[]（变体 3）.items[].label | string | 是 |  |
| item.slots[]（变体 3）.label | string | 是 |  |
| item.slots[]（变体 3）.optional | boolean | 是 |  |
| item.slots[]（变体 3）.partial | boolean | 是 |  |
| item.slots[]（变体 3）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| item.slots[]（变体 3）.prompt[] | object &#124; object &#124; object | 否 |  |
| item.slots[]（变体 3）.prompt[]（变体 1） | object | 否 |  |
| item.slots[]（变体 3）.prompt[]（变体 1）.math | boolean | 是 |  |
| item.slots[]（变体 3）.prompt[]（变体 1）.text | string | 否 |  |
| item.slots[]（变体 3）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| item.slots[]（变体 3）.prompt[]（变体 2） | object | 否 |  |
| item.slots[]（变体 3）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| item.slots[]（变体 3）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| item.slots[]（变体 3）.prompt[]（变体 2）.language | string | 否 |  |
| item.slots[]（变体 3）.prompt[]（变体 2）.startLine | integer | 是 |  |
| item.slots[]（变体 3）.prompt[]（变体 2）.text | string | 否 |  |
| item.slots[]（变体 3）.prompt[]（变体 2）.type | "code" | 否 |  |
| item.slots[]（变体 3）.prompt[]（变体 3） | object | 否 |  |
| item.slots[]（变体 3）.prompt[]（变体 3）.alt | string | 否 |  |
| item.slots[]（变体 3）.prompt[]（变体 3）.asset | string | 否 |  |
| item.slots[]（变体 3）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| item.slots[]（变体 3）.prompt[]（变体 3）.type | "image" | 否 |  |
| item.slots[]（变体 3）.type | "order" | 否 |  |
| item.slots[]（变体 4） | object | 否 |  |
| item.slots[]（变体 4）.columns | Array&lt;object&gt; | 否 |  |
| item.slots[]（变体 4）.columns[] | object | 否 |  |
| item.slots[]（变体 4）.columns[].header | string | 否 |  |
| item.slots[]（变体 4）.columns[].id | string | 否 |  |
| item.slots[]（变体 4）.id | string | 否 |  |
| item.slots[]（变体 4）.label | string | 是 |  |
| item.slots[]（变体 4）.optional | boolean | 是 |  |
| item.slots[]（变体 4）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| item.slots[]（变体 4）.prompt[] | object &#124; object &#124; object | 否 |  |
| item.slots[]（变体 4）.prompt[]（变体 1） | object | 否 |  |
| item.slots[]（变体 4）.prompt[]（变体 1）.math | boolean | 是 |  |
| item.slots[]（变体 4）.prompt[]（变体 1）.text | string | 否 |  |
| item.slots[]（变体 4）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| item.slots[]（变体 4）.prompt[]（变体 2） | object | 否 |  |
| item.slots[]（变体 4）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| item.slots[]（变体 4）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| item.slots[]（变体 4）.prompt[]（变体 2）.language | string | 否 |  |
| item.slots[]（变体 4）.prompt[]（变体 2）.startLine | integer | 是 |  |
| item.slots[]（变体 4）.prompt[]（变体 2）.text | string | 否 |  |
| item.slots[]（变体 4）.prompt[]（变体 2）.type | "code" | 否 |  |
| item.slots[]（变体 4）.prompt[]（变体 3） | object | 否 |  |
| item.slots[]（变体 4）.prompt[]（变体 3）.alt | string | 否 |  |
| item.slots[]（变体 4）.prompt[]（变体 3）.asset | string | 否 |  |
| item.slots[]（变体 4）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| item.slots[]（变体 4）.prompt[]（变体 3）.type | "image" | 否 |  |
| item.slots[]（变体 4）.rows | Array&lt;object&gt; | 否 |  |
| item.slots[]（变体 4）.rows[] | object | 否 |  |
| item.slots[]（变体 4）.rows[].cells | object | 否 |  |
| item.slots[]（变体 4）.rows[].cells[^.*$] | object &#124; object | 是 |  |
| item.slots[]（变体 4）.rows[].cells[^.*$]（变体 1） | object | 否 |  |
| item.slots[]（变体 4）.rows[].cells[^.*$]（变体 1）.value | string | 否 |  |
| item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2） | object | 否 |  |
| item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input | object &#124; object | 否 |  |
| item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1） | object | 否 |  |
| item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.format | string | 是 |  |
| item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.lines | integer | 是 |  |
| item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.maxLength | integer | 是 |  |
| item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.quick | Array&lt;string&gt; | 是 |  |
| item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.quick[] | string | 否 |  |
| item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 1）.type | "text" | 否 |  |
| item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2） | object | 否 |  |
| item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.options | Array&lt;object&gt; | 否 |  |
| item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.options[] | object | 否 |  |
| item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.options[].id | string | 否 |  |
| item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.options[].label | string | 否 |  |
| item.slots[]（变体 4）.rows[].cells[^.*$]（变体 2）.input（变体 2）.type | "choice" | 否 |  |
| item.slots[]（变体 4）.rows[].header | string | 是 |  |
| item.slots[]（变体 4）.rows[].id | string | 否 |  |
| item.slots[]（变体 4）.type | "table" | 否 |  |
| item.slots[]（变体 5） | object | 否 |  |
| item.slots[]（变体 5）.id | string | 否 |  |
| item.slots[]（变体 5）.label | string | 是 |  |
| item.slots[]（变体 5）.language | string | 否 |  |
| item.slots[]（变体 5）.maxLines | integer | 是 |  |
| item.slots[]（变体 5）.optional | boolean | 是 |  |
| item.slots[]（变体 5）.prompt | Array&lt;object &#124; object &#124; object&gt; | 是 |  |
| item.slots[]（变体 5）.prompt[] | object &#124; object &#124; object | 否 |  |
| item.slots[]（变体 5）.prompt[]（变体 1） | object | 否 |  |
| item.slots[]（变体 5）.prompt[]（变体 1）.math | boolean | 是 |  |
| item.slots[]（变体 5）.prompt[]（变体 1）.text | string | 否 |  |
| item.slots[]（变体 5）.prompt[]（变体 1）.type | "markdown" | 否 |  |
| item.slots[]（变体 5）.prompt[]（变体 2） | object | 否 |  |
| item.slots[]（变体 5）.prompt[]（变体 2）.highlight | Array&lt;integer&gt; | 是 |  |
| item.slots[]（变体 5）.prompt[]（变体 2）.highlight[] | integer | 否 |  |
| item.slots[]（变体 5）.prompt[]（变体 2）.language | string | 否 |  |
| item.slots[]（变体 5）.prompt[]（变体 2）.startLine | integer | 是 |  |
| item.slots[]（变体 5）.prompt[]（变体 2）.text | string | 否 |  |
| item.slots[]（变体 5）.prompt[]（变体 2）.type | "code" | 否 |  |
| item.slots[]（变体 5）.prompt[]（变体 3） | object | 否 |  |
| item.slots[]（变体 5）.prompt[]（变体 3）.alt | string | 否 |  |
| item.slots[]（变体 5）.prompt[]（变体 3）.asset | string | 否 |  |
| item.slots[]（变体 5）.prompt[]（变体 3）.decorative | boolean | 是 |  |
| item.slots[]（变体 5）.prompt[]（变体 3）.type | "image" | 否 |  |
| item.slots[]（变体 5）.starter | string | 否 |  |
| item.slots[]（变体 5）.type | "code" | 否 |  |
| item.title | string | 是 |  |
| item.version | string | 否 |  |
| origin | object | 否 |  |
| origin.callId | string | 是 |  |
| origin.kind | "agent" &#124; "plugin" | 否 |  |
| origin.kind（变体 1） | "agent" | 否 |  |
| origin.kind（变体 2） | "plugin" | 否 |  |
| origin.pluginId | string | 是 |  |
| origin.sessionId | string | 是 |  |

## 方法：auth.login

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| provider | string | 否 |  |
| type | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | null | 否 |  |

## 方法：auth.logout

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| provider | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | null | 否 |  |

## 方法：auth.setKey

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| key | string | 否 |  |
| provider | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | null | 否 |  |

## 方法：confirm.reply

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| id | string | 否 |  |
| value | string &#124; boolean &#124; null | 否 |  |
| value（变体 1） | string | 否 |  |
| value（变体 2） | boolean | 否 |  |
| value（变体 3） | null | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | null | 否 |  |

## 通知：confirm.request

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| id | string | 否 |  |
| request | object | 否 |  |
| request.kind | "command" &#124; "input" &#124; "select" &#124; "display" | 否 |  |
| request.kind（变体 1） | "command" | 否 |  |
| request.kind（变体 2） | "input" | 否 |  |
| request.kind（变体 3） | "select" | 否 |  |
| request.kind（变体 4） | "display" | 否 |  |
| request.message | string | 是 |  |
| request.options | Array&lt;string&gt; | 是 |  |
| request.options[] | string | 否 |  |
| request.secret | boolean | 是 |  |
| request.title | string | 否 |  |
| request.url | string | 是 |  |

## 方法：feedback.create

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| clientErrors | Array&lt;object&gt; | 是 |  |
| clientErrors[] | object | 否 |  |
| clientErrors[].message | string | 否 |  |
| clientErrors[].source | string | 是 |  |
| clientErrors[].time | string | 否 |  |
| describe | boolean | 否 |  |
| directory | string | 是 |  |
| note | string | 是 |  |
| sessionId | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| files | Array&lt;string&gt; | 否 |  |
| files[] | string | 否 |  |
| path | string | 否 |  |

## 方法：history.changes

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| since | string | 是 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |

## 方法：history.list

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| limit | integer | 是 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | Array&lt;unknown&gt; | 否 |  |
| $[] | unknown | 否 |  |

## 方法：history.undo

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| revision | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |

## 方法：history.undoRun

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| runId | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |

## 方法：initialize

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| capabilities | object | 是 |  |
| capabilities.interaction | object | 是 |  |
| capabilities.interaction.supports | Array&lt;string&gt; | 否 |  |
| capabilities.interaction.supports[] | string | 否 |  |
| capabilities.services | Array&lt;string&gt; | 是 |  |
| capabilities.services[] | string | 否 |  |
| token | string | 否 |  |
| version | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| baseline | object | 否 |  |
| baseline.disabledPlugins | Array&lt;object&gt; | 否 |  |
| baseline.disabledPlugins[] | object | 否 |  |
| baseline.disabledPlugins[].id | string | 否 |  |
| baseline.disabledPlugins[].reason | object | 否 |  |
| baseline.disabledPlugins[].reason.code | string | 否 |  |
| baseline.disabledPlugins[].reason.message | string | 否 |  |
| baseline.sessions | Array&lt;object&gt; | 否 |  |
| baseline.sessions[] | object | 否 |  |
| baseline.sessions[].agent | string | 否 |  |
| baseline.sessions[].queued | Array&lt;object&gt; | 否 |  |
| baseline.sessions[].queued[] | object | 否 |  |
| baseline.sessions[].queued[].mode | "send" &#124; "steer" &#124; "followUp" | 否 |  |
| baseline.sessions[].queued[].mode（变体 1） | "send" | 否 |  |
| baseline.sessions[].queued[].mode（变体 2） | "steer" | 否 |  |
| baseline.sessions[].queued[].mode（变体 3） | "followUp" | 否 |  |
| baseline.sessions[].queued[].text | string | 否 |  |
| baseline.sessions[].runId | string | 是 |  |
| baseline.sessions[].sessionId | string | 否 |  |
| baseline.space | object &#124; null | 否 |  |
| baseline.space（变体 1） | object | 否 |  |
| baseline.space（变体 1）.root | string | 否 |  |
| baseline.space（变体 2） | null | 否 |  |
| serverId | string | 否 |  |
| version | "3" | 否 |  |

## 方法：model.getDefault

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object &#124; null | 否 |  |
| $（变体 1） | object | 否 |  |
| $（变体 1）.id | string | 否 |  |
| $（变体 1）.provider | string | 否 |  |
| $（变体 2） | null | 否 |  |

## 方法：model.list

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | Array&lt;object&gt; | 否 |  |
| $[] | object | 否 |  |
| $[].available | boolean | 否 |  |
| $[].id | string | 否 |  |
| $[].name | string | 否 |  |
| $[].provider | string | 否 |  |

## 方法：model.providers

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | Array&lt;object&gt; | 否 |  |
| $[] | object | 否 |  |
| $[].configured | "api_key" &#124; "oauth" | 是 |  |
| $[].configured（变体 1） | "api_key" | 否 |  |
| $[].configured（变体 2） | "oauth" | 否 |  |
| $[].id | string | 否 |  |
| $[].methods | Array&lt;object&gt; | 否 |  |
| $[].methods[] | object | 否 |  |
| $[].methods[].login | boolean | 否 |  |
| $[].methods[].name | string | 否 |  |
| $[].methods[].type | "api_key" &#124; "oauth" | 否 |  |
| $[].methods[].type（变体 1） | "api_key" | 否 |  |
| $[].methods[].type（变体 2） | "oauth" | 否 |  |
| $[].name | string | 否 |  |
| $[].stored | boolean | 否 |  |

## 方法：model.setDefault

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| model | object | 否 |  |
| model.id | string | 否 |  |
| model.provider | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | null | 否 |  |

## 方法：plugin.call

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| input | unknown | 否 |  |
| method | string | 否 |  |
| pluginId | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | unknown | 否 |  |

## 方法：plugin.disabled

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | Array&lt;object&gt; | 否 |  |
| $[] | object | 否 |  |
| $[].id | string | 否 |  |
| $[].reason | object | 否 |  |
| $[].reason.code | string | 否 |  |
| $[].reason.message | string | 否 |  |

## 通知：plugin.event

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| event | unknown | 否 |  |
| pluginId | string | 否 |  |

## 方法：plugin.list

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | Array&lt;object&gt; | 否 |  |
| $[] | object | 否 |  |
| $[].id | string | 否 |  |
| $[].methods | Array&lt;string&gt; | 否 |  |
| $[].methods[] | string | 否 |  |
| $[].tools | Array&lt;string&gt; | 否 |  |
| $[].tools[] | string | 否 |  |

## 方法：prompt.list

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| agent | string | 是 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | Array&lt;object&gt; | 否 |  |
| $[] | object | 否 |  |
| $[].defaultText | string | 否 |  |
| $[].enabled | boolean | 否 |  |
| $[].id | string | 否 |  |
| $[].text | string | 否 |  |

## 方法：prompt.preview

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| agent | string | 是 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| sections | Array&lt;object&gt; | 否 |  |
| sections[] | object | 否 |  |
| sections[].defaultText | string | 否 |  |
| sections[].enabled | boolean | 否 |  |
| sections[].id | string | 否 |  |
| sections[].text | string | 否 |  |
| views | Array&lt;object&gt; | 否 |  |
| views[] | object | 否 |  |
| views[].id | string | 否 |  |
| views[].text | string | 否 |  |

## 方法：prompt.reset

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| id | string | 否 |  |
| scope | "app" &#124; "space" | 否 |  |
| scope（变体 1） | "app" | 否 |  |
| scope（变体 2） | "space" | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | null | 否 |  |

## 方法：prompt.set

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| id | string | 否 |  |
| override | object | 否 |  |
| override.enabled | boolean | 是 |  |
| override.text | string | 是 |  |
| scope | "app" &#124; "space" | 否 |  |
| scope（变体 1） | "app" | 否 |  |
| scope（变体 2） | "space" | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | null | 否 |  |

## 通知：service.closed

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| id | string | 否 |  |
| reason | "aborted" &#124; "closed" | 否 |  |
| reason（变体 1） | "aborted" | 否 |  |
| reason（变体 2） | "closed" | 否 |  |

## 方法：service.reply

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object &#124; object | 否 |  |
| $（变体 1） | object | 否 |  |
| $（变体 1）.id | string | 否 |  |
| $（变体 1）.result | unknown | 否 |  |
| $（变体 2） | object | 否 |  |
| $（变体 2）.error | object | 否 |  |
| $（变体 2）.error.code | string | 否 |  |
| $（变体 2）.error.message | string | 否 |  |
| $（变体 2）.id | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | null | 否 |  |

## 通知：service.request

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| id | string | 否 |  |
| input | unknown | 否 |  |
| service | string | 否 |  |

## 方法：session.abort

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| sessionId | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | null | 否 |  |

## 方法：session.compact

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| sessionId | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | null | 否 |  |

## 方法：session.create

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| agent | string | 是 |  |
| model | object | 是 |  |
| model.id | string | 否 |  |
| model.provider | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| agent | string | 否 |  |
| createdAt | string | 否 |  |
| id | string | 否 |  |
| model | object | 是 |  |
| model.id | string | 否 |  |
| model.provider | string | 否 |  |
| name | string | 是 |  |
| parent | object | 是 |  |
| parent.callId | string | 否 |  |
| parent.runId | string | 否 |  |
| parent.sessionId | string | 否 |  |
| preview | string | 是 |  |
| updatedAt | string | 否 |  |

## 通知：session.event

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| data | unknown | 是 |  |
| parent | object | 是 |  |
| parent.callId | string | 否 |  |
| parent.runId | string | 否 |  |
| parent.sessionId | string | 否 |  |
| runId | string | 是 |  |
| sessionId | string | 否 |  |
| text | string | 是 |  |
| tool | string | 是 |  |
| type | "runStart" &#124; "runEnd" &#124; "textDelta" &#124; "toolStart" &#124; "toolEnd" &#124; "message" &#124; "usage" &#124; "error" &#124; "compaction" | 否 |  |
| type（变体 1） | "runStart" | 否 |  |
| type（变体 2） | "runEnd" | 否 |  |
| type（变体 3） | "textDelta" | 否 |  |
| type（变体 4） | "toolStart" | 否 |  |
| type（变体 5） | "toolEnd" | 否 |  |
| type（变体 6） | "message" | 否 |  |
| type（变体 7） | "usage" | 否 |  |
| type（变体 8） | "error" | 否 |  |
| type（变体 9） | "compaction" | 否 |  |
| usage | object | 是 |  |
| usage.cacheRead | number | 否 |  |
| usage.cacheWrite | number | 否 |  |
| usage.input | number | 否 |  |
| usage.output | number | 否 |  |

## 方法：session.followUp

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| sessionId | string | 否 |  |
| text | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | null | 否 |  |

## 方法：session.fork

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| entryId | string | 否 |  |
| sessionId | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| agent | string | 否 |  |
| createdAt | string | 否 |  |
| id | string | 否 |  |
| model | object | 是 |  |
| model.id | string | 否 |  |
| model.provider | string | 否 |  |
| name | string | 是 |  |
| parent | object | 是 |  |
| parent.callId | string | 否 |  |
| parent.runId | string | 否 |  |
| parent.sessionId | string | 否 |  |
| preview | string | 是 |  |
| updatedAt | string | 否 |  |

## 方法：session.history

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| sessionId | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | Array&lt;object&gt; | 否 |  |
| $[] | object | 否 |  |
| $[].data | unknown | 是 |  |
| $[].id | string | 否 |  |
| $[].text | string | 是 |  |
| $[].timestamp | string | 否 |  |
| $[].type | "user" &#124; "assistant" &#124; "tool" &#124; "view" &#124; "prompt" &#124; "promptChange" &#124; "contextEdit" &#124; "compaction" &#124; "usage" &#124; "run" | 否 |  |
| $[].type（变体 1） | "user" | 否 |  |
| $[].type（变体 2） | "assistant" | 否 |  |
| $[].type（变体 3） | "tool" | 否 |  |
| $[].type（变体 4） | "view" | 否 |  |
| $[].type（变体 5） | "prompt" | 否 |  |
| $[].type（变体 6） | "promptChange" | 否 |  |
| $[].type（变体 7） | "contextEdit" | 否 |  |
| $[].type（变体 8） | "compaction" | 否 |  |
| $[].type（变体 9） | "usage" | 否 |  |
| $[].type（变体 10） | "run" | 否 |  |
| $[].usage | object | 是 |  |
| $[].usage.cacheRead | number | 否 |  |
| $[].usage.cacheWrite | number | 否 |  |
| $[].usage.input | number | 否 |  |
| $[].usage.output | number | 否 |  |

## 方法：session.list

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | Array&lt;object&gt; | 否 |  |
| $[] | object | 否 |  |
| $[].agent | string | 否 |  |
| $[].createdAt | string | 否 |  |
| $[].id | string | 否 |  |
| $[].model | object | 是 |  |
| $[].model.id | string | 否 |  |
| $[].model.provider | string | 否 |  |
| $[].name | string | 是 |  |
| $[].parent | object | 是 |  |
| $[].parent.callId | string | 否 |  |
| $[].parent.runId | string | 否 |  |
| $[].parent.sessionId | string | 否 |  |
| $[].preview | string | 是 |  |
| $[].updatedAt | string | 否 |  |

## 方法：session.send

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| sessionId | string | 否 |  |
| text | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | null | 否 |  |

## 方法：session.setModel

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| model | object | 否 |  |
| model.id | string | 否 |  |
| model.provider | string | 否 |  |
| sessionId | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | null | 否 |  |

## 方法：session.steer

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| sessionId | string | 否 |  |
| text | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | null | 否 |  |

## 方法：settings.get

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |

### 结果

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

## 方法：settings.set

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| commandPolicy | "ask" &#124; "fullAccess" | 是 |  |
| commandPolicy（变体 1） | "ask" | 否 |  |
| commandPolicy（变体 2） | "fullAccess" | 否 |  |

### 结果

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

## 方法：space.browse

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| path | string | 是 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| entries | Array&lt;object&gt; | 否 |  |
| entries[] | object | 否 |  |
| entries[].name | string | 否 |  |
| entries[].path | string | 否 |  |
| entries[].space | boolean | 否 |  |
| parent | string &#124; null | 否 |  |
| parent（变体 1） | string | 否 |  |
| parent（变体 2） | null | 否 |  |
| path | string | 否 |  |
| space | boolean | 否 |  |
| truncated | boolean | 否 |  |

## 方法：space.close

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | null | 否 |  |

## 方法：space.create

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| root | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| disabledPlugins | Array&lt;object&gt; | 否 |  |
| disabledPlugins[] | object | 否 |  |
| disabledPlugins[].id | string | 否 |  |
| disabledPlugins[].reason | object | 否 |  |
| disabledPlugins[].reason.code | string | 否 |  |
| disabledPlugins[].reason.message | string | 否 |  |
| root | string | 否 |  |

## 方法：space.list

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | Array&lt;string&gt; | 否 |  |
| $[] | string | 否 |  |

## 方法：space.open

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| root | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |
| disabledPlugins | Array&lt;object&gt; | 否 |  |
| disabledPlugins[] | object | 否 |  |
| disabledPlugins[].id | string | 否 |  |
| disabledPlugins[].reason | object | 否 |  |
| disabledPlugins[].reason.code | string | 否 |  |
| disabledPlugins[].reason.message | string | 否 |  |
| root | string | 否 |  |

## 方法：space.roots

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | Array&lt;object&gt; | 否 |  |
| $[] | object | 否 |  |
| $[].label | string | 否 |  |
| $[].path | string | 否 |  |
