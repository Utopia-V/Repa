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
