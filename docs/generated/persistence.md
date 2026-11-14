<!-- 由 scripts/docs/gen-persistence.ts 生成，不要手改。 -->

# 持久格式

## space-format

文件：<空间>/.repa/format.json。

负责的包：@repa/base。

版本标记：<空间>/.repa/format.json。

schema：packages/base/src/space/format.ts#FormatSchema；SHA-256 前 16 位：557283bfb3e5b4a7。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| version | integer | 否 |  |

## session-parent

文件：<空间>/.repa/sessions/<会话 id>.parent.json。

负责的包：@repa/base。

版本标记：<空间>/.repa/format.json。

schema：packages/base/src/schema.ts#SessionParentSchema；SHA-256 前 16 位：3d399c4db9c7ad1a。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
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
| $ | object &#124; object &#124; object &#124; object &#124; object | 否 | 嵌套对象，字段见源码 |

## app-settings

文件：<应用配置目录>/settings.json。

负责的包：@repa/base。

版本标记：无独立版本标记。

schema：packages/base/src/schema.ts#SettingsSchema；SHA-256 前 16 位：105f22723284d875。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| backup | object | 否 |  |
| backup.intervalMinutes | integer | 否 |  |
| backup.keep | integer | 否 |  |
| commandPolicy | "ask" &#124; "fullAccess" | 否 |  |
| prompts | object | 否 |  |
| prompts[^.*$] | object | 是 | 嵌套对象，字段见源码 |
| recentSpaces[] | string | 否 |  |

## restore-marker

文件：<空间>/.repa/restore.json。

负责的包：@repa/base。

版本标记：<空间>/.repa/format.json。

schema：packages/base/src/schema.ts#RestoreMarkerSchema；SHA-256 前 16 位：d2f76b8ec7ac81a2。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| backup | string | 否 |  |

## backup-manifest

文件：<应用配置目录>/backups/<空间分组>/<备份 id>/manifest.json。

负责的包：@repa/base。

版本标记：无独立版本标记；备份中的 data/ 是 .repa/ 的副本，由其中的 format.json 标记。

schema：packages/base/src/schema.ts#BackupManifestSchema；SHA-256 前 16 位：f4c0a408f52ae11d。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| createdAt | string | 否 |  |
| files[] | object | 否 |  |
| files[].mtimeMs | number | 否 |  |
| files[].path | string | 否 |  |
| files[].size | integer | 否 |  |
| kind | "regular" &#124; "beforeRestore" | 否 |  |
| root | string | 否 |  |

## learning-format

文件：<空间>/.repa/plugins/learning/format.json。

负责的包：@repa/learning。

版本标记：<空间>/.repa/plugins/learning/format.json。

schema：packages/base/src/space/format.ts#FormatSchema；SHA-256 前 16 位：557283bfb3e5b4a7。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| version | integer | 否 |  |

## learning-records

文件：<空间>/.repa/plugins/learning/records.jsonl。

负责的包：@repa/learning。

版本标记：<空间>/.repa/plugins/learning/format.json。

schema：packages/learning/src/records-schema.ts#FactSchema；SHA-256 前 16 位：82166e6be990a5b5。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| $ | object &#124; object &#124; object &#124; object &#124; object &#124; object &#124; object &#124; object | 否 | 嵌套对象，字段见源码 |

## plugin-manifest

文件：<空间>/.agents/plugins/<插件 id>/repa-plugin.json、随包插件文件夹的 repa-plugin.json。

负责的包：@repa/base。

版本标记：无独立版本标记；可选的 baseVersion 声明插件兼容的底座版本范围，自写插件可以不写。

schema：packages/base/src/plugins/manifest.ts#PluginManifestSchema；SHA-256 前 16 位：0fa04cc9abb82bfc。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| baseVersion | string | 是 |  |
| entry | string | 否 |  |
| id | string | 否 |  |
| pages[] | object | 是 |  |
| pages[].entry | string | 否 |  |
| pages[].id | string | 否 |  |
| pages[].title | string | 否 |  |
| title | string | 是 |  |
| version | string | 否 |  |

## plugin-snapshot

文件：<应用配置目录>/plugins/<空间分组>/<插件 id>/<摘要>/。

负责的包：@repa/base。

版本标记：目录名是插件文件夹的摘要，摘要输入的第一行 repa-plugin-folder 1 是算法版本；快照的内容是一份插件文件夹，其中的清单即 plugin-manifest。

schema：packages/base/src/plugins/manifest.ts#PluginManifestSchema；SHA-256 前 16 位：0fa04cc9abb82bfc。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| baseVersion | string | 是 |  |
| entry | string | 否 |  |
| id | string | 否 |  |
| pages[] | object | 是 |  |
| pages[].entry | string | 否 |  |
| pages[].id | string | 否 |  |
| pages[].title | string | 否 |  |
| title | string | 是 |  |
| version | string | 否 |  |

## plugin-enablement

文件：<空间>/.repa/plugins.json。

负责的包：@repa/base。

版本标记：<空间>/.repa/format.json。

schema：packages/base/src/plugins/enablement.ts#PluginEnablementSchema；SHA-256 前 16 位：6559dfb16f27d289。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| plugins | object | 否 |  |
| plugins[^[a-z][a-z0-9-]*$] | object | 是 | 嵌套对象，字段见源码 |

## learning-course-choice

文件：<空间>/.repa/plugins/learning/course.json。

负责的包：@repa/learning。

版本标记：<空间>/.repa/plugins/learning/format.json。

schema：packages/learning/src/space-course.ts#CourseChoiceSchema；SHA-256 前 16 位：55961a3217710f9c。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| active | string | 是 |  |

## learning-course

文件：<空间>/course/course.yaml、<空间>/.repa/plugins/learning/courses/<摘要>/course.yaml、随包课程的 course.yaml。

负责的包：@repa/learning。

版本标记：无独立版本标记；换用过的副本目录名是内容摘要，课程自己的 version 只记进学习记录。

schema：packages/learning/src/format/schema.ts#CourseSchema；SHA-256 前 16 位：6424754f60110faf。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| id | string | 否 | 名字以字母开头，只用字母、数字、下划线和连字符 |
| language | string | 否 |  |
| license | string | 否 |  |
| retiredIds[] | string &#124; string &#124; string | 是 |  |
| runtime | object | 是 |  |
| runtime.packages | object | 否 | 嵌套对象，字段见源码 |
| runtime.prelude | string | 是 |  |
| runtime.pyodide | string | 否 |  |
| runtime.python | string | 否 |  |
| sources | object | 否 |  |
| sources[^[A-Za-z][A-Za-z0-9_-]*$] | object | 是 | 嵌套对象，字段见源码 |
| summary | string | 是 |  |
| title | string | 否 |  |
| topics[] | string | 否 | topic id 只用小写字母和数字，以字母开头，例如 py17 |
| version | string | 否 | 课程版本写成 x.y.z |

## learning-topic

文件：<空间>/course/topics/<topic id>.yaml、<空间>/.repa/plugins/learning/courses/<摘要>/topics/<topic id>.yaml、随包课程的 topics/<topic id>.yaml。

负责的包：@repa/learning。

版本标记：无独立版本标记；与 learning-course 同在一份课程里。

schema：packages/learning/src/format/schema.ts#TopicSchema；SHA-256 前 16 位：ff63be80e82ebcfa。

| 字段 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| data | object | 是 |  |
| data[^[A-Za-z][A-Za-z0-9_-]*$] | object &#124; object | 是 | 嵌套对象，字段见源码 |
| encompassings[] | object | 是 |  |
| encompassings[].topic | string | 否 | topic id 只用小写字母和数字，以字母开头，例如 py17 |
| encompassings[].weight | number | 否 |  |
| id | string | 否 | topic id 只用小写字母和数字，以字母开头，例如 py17 |
| intro | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 | 嵌套对象，字段见源码 |
| kps[] | object | 否 |  |
| kps[].card | object | 是 | 嵌套对象，字段见源码 |
| kps[].example | object | 是 | 嵌套对象，字段见源码 |
| kps[].id | string | 否 | 知识点 id 写成 &lt;topic id&gt;.k&lt;数字&gt;，例如 py17.k1 |
| kps[].keyPrerequisites[] | string | 是 | topic id 只用小写字母和数字，以字母开头，例如 py17 |
| kps[].lesson | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 | 嵌套对象，字段见源码 |
| kps[].practice[] | object | 是 | 嵌套对象，字段见源码 |
| kps[].quiz[] | object | 是 | 嵌套对象，字段见源码 |
| kps[].review[] | object | 是 | 嵌套对象，字段见源码 |
| kps[].title | string | 否 |  |
| minutes | integer | 否 |  |
| notes | string | 是 |  |
| prerequisites[] | string | 否 | topic id 只用小写字母和数字，以字母开头，例如 py17 |
| sources[] | object | 否 |  |
| sources[].notice | string | 是 |  |
| sources[].source | string | 否 | 名字以字母开头，只用字母、数字、下划线和连字符 |
| sources[].url | string | 是 | 链接需要以 https:// 开头 |
| sources[].use | "reference" &#124; "adapt" &#124; "code" &#124; "quote" | 否 |  |
| sources[].where | string | 否 |  |
| status | "outline" &#124; "complete" | 否 |  |
| summary | string | 是 |  |
| title | string | 否 |  |
| verified[] | object | 是 |  |
| verified[].date | string | 否 | 日期写成 YYYY-MM-DD |
| verified[].model | string | 否 |  |
| verified[].question | string | 否 | 题目 id 写成 &lt;知识点 id&gt;.&lt;小写字母&gt;&lt;数字&gt;，例如 py17.k1.q1 |
| verified[].scope | "question-runtime-v1" | 是 |  |
| verified[].slots[] | string | 否 |  |
| verified[].version | string | 否 | 核对哈希写成 sha256:&lt;64 位十六进制&gt; |
| wrapup | string &#124; Array&lt;object &#124; object &#124; object&gt; | 是 | 嵌套对象，字段见源码 |
