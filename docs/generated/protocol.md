<!-- 由 scripts/docs/gen-protocol.ts 生成，不要手改。 -->

# 前后端协议

## 方法：agent.list

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $[].description | string | 是 |  |
| $[].direct | boolean | 否 |  |
| $[].id | string | 否 |  |

## 通知：ask.closed

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| id | string | 否 |  |
| reason | "answered" &#124; "cancelled" &#124; "aborted" &#124; "closed" | 否 |  |

## 方法：ask.reply

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| action | "submit" &#124; "decline" &#124; "cancel" &#124; "unsupported" | 否 |  |
| id | string | 否 |  |
| message | string | 是 |  |
| response | object | 是 |  |
| response.answers | object | 否 | 嵌套对象，字段见源码 |
| response.item | object | 否 | 嵌套对象，字段见源码 |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object &#124; object &#124; null | 否 | 嵌套对象，字段见源码 |

## 通知：ask.request

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| id | string | 否 |  |
| item | object | 否 |  |
| item.body[] | object &#124; object &#124; object | 否 | 嵌套对象，字段见源码 |
| item.id | string | 否 |  |
| item.requires[] | string | 否 |  |
| item.slots[] | object &#124; object &#124; object &#124; object &#124; object | 否 | 嵌套对象，字段见源码 |
| item.title | string | 是 |  |
| item.version | string | 否 |  |
| origin | object | 否 |  |
| origin.callId | string | 是 |  |
| origin.kind | "agent" &#124; "plugin" | 否 |  |
| origin.pluginId | string | 是 |  |
| origin.sessionId | string | 是 |  |

## 方法：auth.login

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
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
| provider | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | null | 否 |  |

## 方法：auth.setKey

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
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
| id | string | 否 |  |
| value | string &#124; boolean &#124; null | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | null | 否 |  |

## 通知：confirm.request

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| id | string | 否 |  |
| request | object | 否 |  |
| request.kind | "command" &#124; "input" &#124; "select" &#124; "display" | 否 |  |
| request.message | string | 是 |  |
| request.options[] | string | 是 |  |
| request.secret | boolean | 是 |  |
| request.title | string | 否 |  |
| request.url | string | 是 |  |

## 方法：feedback.create

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| clientErrors[] | object | 是 |  |
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
| files[] | string | 否 |  |
| path | string | 否 |  |

## 方法：history.changes

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| since | string | 是 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |

## 方法：history.list

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| limit | integer | 是 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $[] | unknown | 否 |  |

## 方法：history.undo

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| revision | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |

## 方法：history.undoRun

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| runId | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |

## 方法：initialize

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| capabilities | object | 是 |  |
| capabilities.interaction | object | 是 | 嵌套对象，字段见源码 |
| capabilities.services[] | string | 是 |  |
| token | string | 否 |  |
| version | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| baseline | object | 否 |  |
| baseline.disabledPlugins[] | object | 否 | 嵌套对象，字段见源码 |
| baseline.sessions[] | object | 否 | 嵌套对象，字段见源码 |
| baseline.space | object &#124; null | 否 | 嵌套对象，字段见源码 |
| serverId | string | 否 |  |
| version | "3" | 否 |  |

## 方法：model.getDefault

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object &#124; null | 否 | 嵌套对象，字段见源码 |

## 方法：model.list

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $[].available | boolean | 否 |  |
| $[].id | string | 否 |  |
| $[].name | string | 否 |  |
| $[].provider | string | 否 |  |

## 方法：model.providers

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $[].configured | "api_key" &#124; "oauth" | 是 |  |
| $[].id | string | 否 |  |
| $[].methods[] | object | 否 |  |
| $[].methods[].login | boolean | 否 |  |
| $[].methods[].name | string | 否 |  |
| $[].methods[].type | "api_key" &#124; "oauth" | 否 |  |
| $[].name | string | 否 |  |
| $[].stored | boolean | 否 |  |

## 方法：model.setDefault

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
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

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $[].id | string | 否 |  |
| $[].reason | object | 否 |  |
| $[].reason.code | string | 否 |  |
| $[].reason.message | string | 否 |  |

## 通知：plugin.event

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| event | unknown | 否 |  |
| pluginId | string | 否 |  |

## 方法：plugin.list

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $[].id | string | 否 |  |
| $[].methods[] | string | 否 |  |
| $[].tools[] | string | 否 |  |

## 方法：prompt.list

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| agent | string | 是 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $[].defaultText | string | 否 |  |
| $[].enabled | boolean | 否 |  |
| $[].id | string | 否 |  |
| $[].text | string | 否 |  |

## 方法：prompt.preview

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| agent | string | 是 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| sections[] | object | 否 |  |
| sections[].defaultText | string | 否 |  |
| sections[].enabled | boolean | 否 |  |
| sections[].id | string | 否 |  |
| sections[].text | string | 否 |  |
| views[] | object | 否 |  |
| views[].id | string | 否 |  |
| views[].text | string | 否 |  |

## 方法：prompt.reset

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| id | string | 否 |  |
| scope | "app" &#124; "space" | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | null | 否 |  |

## 方法：prompt.set

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| id | string | 否 |  |
| override | object | 否 |  |
| override.enabled | boolean | 是 |  |
| override.text | string | 是 |  |
| scope | "app" &#124; "space" | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | null | 否 |  |

## 通知：service.closed

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| id | string | 否 |  |
| reason | "aborted" &#124; "closed" | 否 |  |

## 方法：service.reply

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object &#124; object | 否 | 嵌套对象，字段见源码 |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | null | 否 |  |

## 通知：service.request

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| id | string | 否 |  |
| input | unknown | 否 |  |
| service | string | 否 |  |

## 方法：session.abort

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| sessionId | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | null | 否 |  |

## 方法：session.compact

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| sessionId | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | null | 否 |  |

## 方法：session.create

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| agent | string | 是 |  |
| model | object | 是 |  |
| model.id | string | 否 |  |
| model.provider | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
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
| usage | object | 是 |  |
| usage.cacheRead | number | 否 |  |
| usage.cacheWrite | number | 否 |  |
| usage.input | number | 否 |  |
| usage.output | number | 否 |  |

## 方法：session.followUp

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
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
| entryId | string | 否 |  |
| sessionId | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
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
| sessionId | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $[].data | unknown | 是 |  |
| $[].id | string | 否 |  |
| $[].text | string | 是 |  |
| $[].timestamp | string | 否 |  |
| $[].type | "user" &#124; "assistant" &#124; "tool" &#124; "view" &#124; "prompt" &#124; "promptChange" &#124; "contextEdit" &#124; "compaction" &#124; "usage" &#124; "run" | 否 |  |
| $[].usage | object | 是 |  |
| $[].usage.cacheRead | number | 否 |  |
| $[].usage.cacheWrite | number | 否 |  |
| $[].usage.input | number | 否 |  |
| $[].usage.output | number | 否 |  |

## 方法：session.list

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
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

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| commandPolicy | "ask" &#124; "fullAccess" | 否 |  |
| prompts | object | 否 |  |
| prompts[^.*$] | object | 是 | 嵌套对象，字段见源码 |
| recentSpaces[] | string | 否 |  |

## 方法：settings.set

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| commandPolicy | "ask" &#124; "fullAccess" | 是 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| commandPolicy | "ask" &#124; "fullAccess" | 否 |  |
| prompts | object | 否 |  |
| prompts[^.*$] | object | 是 | 嵌套对象，字段见源码 |
| recentSpaces[] | string | 否 |  |

## 方法：space.browse

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| path | string | 是 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| entries[] | object | 否 |  |
| entries[].name | string | 否 |  |
| entries[].path | string | 否 |  |
| entries[].space | boolean | 否 |  |
| parent | string &#124; null | 否 |  |
| path | string | 否 |  |
| space | boolean | 否 |  |
| truncated | boolean | 否 |  |

## 方法：space.close

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | null | 否 |  |

## 方法：space.create

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| root | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| disabledPlugins[] | object | 否 |  |
| disabledPlugins[].id | string | 否 |  |
| disabledPlugins[].reason | object | 否 | 嵌套对象，字段见源码 |
| root | string | 否 |  |

## 方法：space.list

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $[] | string | 否 |  |

## 方法：space.open

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| root | string | 否 |  |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| disabledPlugins[] | object | 否 |  |
| disabledPlugins[].id | string | 否 |  |
| disabledPlugins[].reason | object | 否 | 嵌套对象，字段见源码 |
| root | string | 否 |  |

## 方法：space.roots

### 参数

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |

### 结果

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $[].label | string | 否 |  |
| $[].path | string | 否 |  |
