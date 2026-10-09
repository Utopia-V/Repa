# 插件包与共享能力

这部分负责找到插件包、读取它提供的入口，并在取得信任后加载需要的部分。能力具体怎样调用、怎样使用空间数据，见[共享能力说明](capabilities.md)。

## 设计思路

写一个复习插件时，你可能会把后端代码、界面组件和给 Agent 使用的 Skill 放在同一个包里。它们需要一起安装、更新，但你应该把它们交给不同的宿主加载。

安装这一部分可以直接使用 Pi 的包管理器。它已经能够管理包来源、版本和安装位置，Repa 复用这套实现。包安装好以后，还需要告诉各个宿主应该加载什么。

这些信息放在包的声明里。原有的 `pi` 字段说明有哪些 Pi 资源，`repa` 字段说明后台、安装级贡献、快照和前端入口。`pi` 中的资源交给 Pi 加载；Repa 读取 `repa`，按各入口的责任加载代码，并向客户端提供前端入口。每个包只填写实际提供的内容，纯 Skill 包沿用 Pi 的格式即可。

读取声明时不用执行这些入口。Repa 先展示包的来源、入口和兼容情况，用户据此决定是否信任这个包。取得信任后，Repa 再按用户的启用选择加载相应代码。目前后端已经按这个方式接入，前端的实际加载还需要由客户端实现。

## 实现细节

### 包来源与目录发现

[`PluginPackages`](../../packages/repa/src/plugins/packages.ts) 使用 Pi 0.87.1 的 `DefaultPackageManager` 查找包，再读取包声明和文件状态。来源记录和安装位置都由 Pi 管理，查询时不导入任何包入口，包括安装级贡献模块。

包目录返回以下信息：

- 来源和作用域：个人安装为 `user`，项目安装为 `project`，随应用提供的包为 `bundled`。
- 包名、版本、安装位置，以及是否提供 Pi 资源。
- 后台、安装级贡献、快照和前端入口各自的 API 范围、文件位置与可用状态。
- 缺失或不兼容的具体原因。

一个包可能有多个入口，需要分别判断它们是否可用。例如前端入口版本不兼容，同包的后台仍可能正常工作。目录中的 `ready` 只表示对应文件和声明可用；是否执行，还取决于信任和启用配置。

查目录时不应顺带安装软件，而 Pi 的 `resolve` 默认可能安装缺失的包。因此，查询显式使用 `resolve(() => "skip")` 跳过安装。尚未安装的包，以及没有所需版本的包，都在目录中标为缺失，等待用户决定是否安装。

包入口采用 [Issue #16 第 6 节](https://github.com/Utopia-V/repa/issues/16) 的 `package.json` 元数据：

```json
{
  "name": "@example/repa-experiment",
  "version": "1.0.0",
  "pi": { "extensions": ["./agent.js"], "skills": ["./skills"] },
  "repa": {
    "manifestVersion": 1,
    "backend": { "entry": "./backend.js", "api": "^1.0.0" },
    "contributions": { "entry": "./contributions.js", "api": "^1.0.0" },
    "frontends": [
      { "environment": "web", "entry": "./web.js", "api": "^1.0.0" }
    ]
  }
}
```

只填写包实际提供的入口。Repa 用 TypeBox 检查声明，用 `semver` 核对各入口是否兼容宿主 API `1.0.0`。入口文件必须位于包内，不能通过相对路径或符号链接指向包外。查询结果提供解析后的文件位置，实际加载由对应宿主完成；当前前端部分只提供这份清单。

### 后台装配与设置

需要分清楚：包是否存在、是否获准执行、是否启用，是三个不同的问题。包目录说明本机找到了什么，信任配置决定哪些代码可以执行，启用配置决定当前使用哪些能力。

`plugins` 命名空间使用四项设置：

| 设置 | 含义 |
| --- | --- |
| `backends` | 指定后台插件的固定身份及包来源 |
| `disabled` | 关闭哪些已登记插件或随应用提供的能力 |
| `trusted` | 允许执行哪些包，只能在应用侧设置 |
| `implementations` | 为某个公共能力接口选择实际实现 |

应用和空间可以分别设置 `backends`、`disabled` 和 `implementations`。空间带来的配置可以声明需要什么包，但不能自行授予本机代码执行信任。官方学习产品用 `repa-learning` 表示组合总开关，各项能力也有自己的注册标识。底座按传入的登记与配置工作，不预装这项组合；产品装配见[默认组合](official-learning.md)。

`PluginRuntime` 根据这些设置选择入口，检查来源和信任后，导入已启用的后台工厂。工厂先声明能力，等第一次调用时再通过 `openSpace` 打开数据库等空间资源。禁用插件时会停止相关工作、关闭资源，已保存的设置和业务数据保留。

应用代码也可以直接登记能力：已有工厂使用 `ApplicationOptions.plugins`；已安装的包目录使用 `ApplicationOptions.bundledPackages`，填写 `{ id, directory, enabled }`。包列表既可以是固定数组，也可以是同步函数 `(configuration: PluginSettings) => readonly BundledPluginRegistration[]`，由产品按本次配置选择贡献。后一种方式仍读取同一份包声明，纯 Skill 包只加载 Skill。目录返回 `bundled` 来源及 `registrationId`，关闭后也能找到它的数据快照入口。

官方组合从实际分发依赖中定位包，信任绑定到这份代码的位置。项目中即使出现同名包，也不会因此取得官方信任。随应用提供的资源使用独立的 Pi 内存设置解析，个人和项目的安装配置保持原样。具体构建取舍见[默认组合说明](official-learning.md#装配责任与构建顺序)。

预览和实际运行都通过 `selectBackendEntry` 选择入口，使用相同的判断规则。同名包存在多个来源时，需要用完整的 `source + scope` 指定。来源含糊或已经关闭的入口不会显示为已启用。预览到选出入口为止，不执行后台工厂。

### 产品装配与提示默认值

直接建立 `RepaApplication` 或调用 `startRepaServer` 时，底座的后台登记和随应用包列表都为空，基础提示也为空。产品把实际需要的插件、包和默认提示交给应用，而不要求通用底座了解其领域。

`ApplicationOptions.promptDefaults` 接收当前 `PluginSettings`，同步返回 `Partial<PromptSettings>`。例如产品可以根据组合开关选择基础提示：

```ts
promptDefaults: configuration => ({
  base: configuration.disabled.includes("novel-product") ? "" : "围绕当前小说设定继续创作。",
}),
```

Application 校验返回的字段和值，再替换设置视图中 `source: "default"` 的有效值，同时显示新的默认定义。应用、空间和会话已保存的覆盖保持原样；空字符串、空列表和 `false` 也是明确的覆盖。重置覆盖后，才重新使用产品此时提供的默认值。

官方学习产品通过 `@repa/learning` 的 `learningApplicationOptions`、`createLearningApplication` 和 `startLearningServer` 完成这项装配。其他领域可以提供自己的入口，通用底座继续使用同一组应用选项。

### 安装级背景与持久格式

当小说插件需要把设定带入下一次会话时，它可以继续使用已有能力查询读取当前设定，再把结果转换为背景消息。你把这项贡献放在 `BackendPluginRegistration.backgrounds` 中，与同一插件的工厂一起登记：

```ts
const registration: BackendPluginRegistration = {
  id: "novel",
  enabled: true,
  factory: createNovelPlugin,
  formats: [novelFormat],
  backgrounds: [{
    codec: novelCodec,
    selection: { contract: { id: "example.novel.preview", version: "1" }, implementationId: "local" },
    input: { kind: "current" },
    prepare: prepareNovelBackground,
    preview: {
      implementationId: "local",
      read: async content => prepareNovelBackground(await readNovelView(content)),
    },
  }],
};
```

`selection` 选择已有的空间 `query` 能力及默认实现；`plugins.implementations` 可以覆盖这项选择。`input` 使用该能力的公共输入 schema，不经过模型工具的参数适配。Application 在实际运行中调用这项查询，因此来源中包含本次空间、会话、请求和运行身份，取消信号与窄服务也沿用能力调用入口。`prompts.backgrounds` 中与 `codec.id` 同名的显式条目选择是否注入该来源；没有条目时沿用贡献的 `enabled(settings)`，没有该函数时默认启用。这个函数提供来源的默认选择，不承担权限判断；插件登记未启用或被 `plugins.disabled` 关闭时，来源始终关闭。`prepare` 解释结果，返回完整消息、修订和预览文本；`codec` 则识别插件过去保存的消息。消息的业务含义由插件持有，底座复用同一套背景投影、分支和压缩处理。

静态预览需要单独声明 `preview`。其 `read` 只读取当前内容，不建立后台实例；只有当前选择与声明的 `implementationId` 一致，预览才展示结果。选择了其他实现或没有声明时，来源显示为动态，实际运行再准备。预览因此可以展示已知内容，而不为查看提示执行后台工厂。

`formats` 提供同一插件对内容清单字段、引用和文件的解释，交给 `ContentStore.formats` 使用。安装级声明一直保留：禁用插件后，查询与注入停止，历史 codec 仍可过滤已有自动消息，格式仍参与空间复制、备份和引用重映射。重新启用时读取原来的当前数据，而不是重新初始化一份状态。背景来源 ID、历史消息类型、格式 ID 和格式字段均要求唯一。

独立分发时，把相同的背景与格式放到 `repa.contributions` 指定的模块中。该模块默认导出 `PluginContributions` 对象，不是后台工厂：

```ts
import type { PluginContributions } from "repa/plugin";
import { novelBackground, novelFormat } from "./definitions.js";

export default {
  backgrounds: [novelBackground],
  formats: [novelFormat],
} satisfies PluginContributions;
```

包通过 `plugins.backends` 取得固定插件身份和唯一来源，或者由产品在 `bundledPackages` 中登记。贡献入口只从这些已登记且受信任的来源加载，不从所有已安装包中自动收集。模块导入仍会执行其顶层代码，因此同样需要本机代码执行信任；“轻量”要求它只提供声明，不在导入时启动后台、打开业务数据库或执行长事务。只使用 ContentStore 的插件也可以提供贡献，不要求先创建 `.repa/plugins/<id>` 数据目录。

每个空间打开时，应用先读取该空间的有效配置、解析贡献来源，再用这份格式集合恢复内容；恢复完成后才发布空间。不同空间可以选择不同来源，同名包有歧义时要求明确来源与作用域。贡献入口的路径和 API 状态与后台、快照分别检查，加载失败记入能力目录的 `issues`，对应格式保持不可用；重复的背景或格式 owner 则拒绝整个装配，避免按加载顺序决定数据含义。

静态预览和实际运行使用同一份安装声明。打开空间、读取包目录或预览背景都不需要执行后台工厂；能力目录、调用或运行需要实际后台定义时，才执行后台工厂，空间资源继续按实际使用打开。官方学习注册继续通过直接登记使用这条共同管道，默认组合由 `@repa/learning` 的产品入口提供。

### 安装声明的配置与失效

已打开空间持有固定的格式解释。关闭后台或改变能力实现选择时，只要解析后的声明来源仍相同，运行实例会重新装配，格式与历史 codec 继续保留。这里比较的是实际来源和入口，而不是设置字段名：产品的 `bundledPackages(configuration)` 也可能因开关变化返回另一份代码目录。

如果配置增删或更换了声明来源，或者撤回了它的执行信任，该空间需要重启后端才能重新装配。应用先停止新的背景使用，等待已经开始的准备和预览收尾；旧异步结果不再作为当前背景返回。内容则使用自己的保存队列作为边界：此前已经受理的保存和复制完成以后，旧格式失效，后续依赖它的 metadata、引用校验和复制返回 `plugin_restart_required`。固定 schema 下的普通正文读取和资源回收继续可用，设置与包目录也仍可查询和修正。

这种处理不在一次事务中混用两份解释器，也不试图回滚已受理的保存。来源变化只阻止受影响空间的旧声明继续使用；个人安装的包代码变更仍沿应用范围要求重启。空间正在生成快照时，受影响范围的插件设置和包准备返回 `space_busy`，完成后再执行。开始打开空间与这些设置、准备操作使用同一受理顺序，避免一份旧声明在撤权后才完成发布。

如果设置已经保存而后续装配失败，应用保留实际设置、发送设置变更通知，并使受影响的旧声明失效。此时按错误重新读取配置、修正后重启；失败不会被解释成设置已经回滚。

固定的是安装声明，不是 Pi 的全部资源目录。Skill 和提示资源仍在预览或运行装配时重新发现。上述排空和失效由管理 API 协调；如果绕过它直接修改后台、贡献或快照的来源、入口及代码，需要自行重启后端。应用不监视这些手动修改，也不把它们当作已经完成的代码交接。

### 禁用后的持久数据快照

插件关闭后，数据仍然需要备份。如果快照只能由运行中的后台提供，就得为了备份重新启用插件。因此，有持久数据的包可以单独声明 `repa.snapshot`：

```json
{
  "repa": {
    "manifestVersion": 1,
    "backend": { "entry": "./backend.js", "api": "^1.0.0" },
    "snapshot": { "entry": "./snapshot.js", "api": "^1.0.0" }
  }
}
```

这个模块默认导出 `(pluginId: string) => SpaceSnapshotParticipant`。备份或复制时，Repa 只需加载快照模块，由它识别数据版本、生成一致快照，并处理副本中的引用，插件后台可以保持关闭。应用直接登记工厂时，通过 `BackendPluginRegistration.snapshot` 提供同样的入口；已经启用的插件也可以通过 `BackendPlugin.snapshot` 参加快照。

为了支持这种备份方式，有状态插件需要多维护一个可以独立加载的模块，并在修改数据格式时同步修改它。Repa 因而只需协调空间备份，各插件怎样保存数据、怎样得到一致的副本，都由了解这些格式的插件代码处理。没有持久数据的插件不用提供快照入口。

快照、后台和前端入口分别检查 API 兼容性。快照入口不兼容会影响备份，但不会使本来可用的后台或前端入口一并失效。

### Pi 资源选择

Pi 0.87.1 解析本地包时，如果找不到 `pi` 声明和约定的资源目录，可能把整个目录当作 Extension 加载。一个只提供 Repa 后台的包也会遇到这种情况，因此需要在交给 Pi 之前过滤资源，明确告诉它这个包没有 Pi 入口。这处适配要随 Pi 升级核对。

`projectPiPackages` 根据本次启用和信任选择，生成给 Loader 使用的内存配置。未安装或声明无效的包暂不加载；只有 Repa 入口的包明确关闭四类 Pi 资源：

```json
{
  "source": "./repa-frontend-only",
  "extensions": [],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

普通 Pi 包和混合包保留原有资源过滤，包括项目配置的 `autoload:false` 差量选择。原始安装设置保持不变，过滤只影响本次实际加载。

`discoverPluginResources` 同时供运行和预览使用。项目整体尚未取得信任时，只读取其包来源；由应用明确授权的包可以加载，项目自行声明的其他扩展仍保持关闭。静态预览读取已有 Skill 和能确定的提示，扩展执行后才能产生的内容标为动态。

过滤后的包列表通过 `SettingsManager.fromStorage()` 写入 global/project 两份内存设置，因为 PackageManager 会从这里读取来源。仅调用 `applyOverrides({ packages })` 改不到它读取的原始设置。

其他入口也不能代替这次过滤。`extensionsOverride` 执行时，扩展已经加载；`noExtensions` 等开关不会阻止此前的包解析；`additionalExtensionPaths` 用于显式加载指定入口。升级时需要按这些入口的实际调用顺序核对，而不能只看选项名称。

这些判断依据 [Pi 0.87.1 PackageManager](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/core/package-manager.ts) 与 [ResourceLoader](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/core/resource-loader.ts)。升级时重点检查包解析的数据来源、缺包处理和扩展加载顺序；若上游能够直接区分 Repa 包并支持相同的加载控制，再收缩这层适配。

### 安装、更新与移除

`package.list({ scope })` 返回包目录，包括随应用提供的包。`package.install/update/remove` 接收同一作用域和 `requestId`；安装、移除需要指定 `source`，更新可以省略来源以更新该作用域的包。操作返回后台请求，进度和结果通过 `request.get` 查询，成功结果包含刷新后的目录和 `restartRequired: true`。

`PluginPackages` 委托 SDK 完成操作，然后等待 `SettingsManager.flush()` 保存配置，检查保存结果，再返回目录。应用范围操作管理 `user` 安装，空间范围操作管理 `project` 安装；`bundled` 包由应用自身分发，不通过这三个操作更新。执行器只取得所选作用域的包列表，更新一个空间时不会连带更新个人安装。

本地来源在 SDK 设置中相对设置目录保存，操作输入则相对当前工作目录解释。Repa 根据已发现的安装位置转换路径，使更新和移除作用于原包；原目录已经丢失时，也可以移除它的来源配置。

负责持久化的 `SettingsManager` 读写完整设置，交给包执行器的则是本次获准使用的部分。例如，用户可以明确允许管理某个项目的包，而不信任项目中的 `npmCommand` 等执行配置。这些配置不会交给 SDK；操作结束后，也只保存所选作用域的包字段，保留其他设置。

改包前，Application 先封锁受影响范围的新装配，取消相关工作，等待调用、背景预览和格式队列结束并关闭实例，再执行 SDK 包管理。某个后台打开失败时，也会等待其他正在打开的后台并关闭成功实例，之后统一报告失败；失败不会让迟到的旧装配脱离这条收尾链。同一个 user 或 project 安装根内的操作串行执行，避免包目录和 SDK 设置相互覆盖；下载与安装不占用应用的通用受理队列。因此，你在一个空间安装包时，仍可在另一个空间开始会话或安装它自己的包。

Pi 0.87.1 没有安装、更新操作的中途取消入口。已经进入 SDK 操作后，`request.cancel` 不能停止或撤销这次安装，应用退出也要等它完成并检查保存结果。上游若补充取消支持，再核对中止后文件与配置的实际状态并接入。

包文件更新后，Node 进程中的模块缓存可能还是旧版本，其中又包含对其他模块的引用。重新创建一个 `PluginRuntime` 并不能清掉这些缓存。因此，当前选择更新后重启后端，由新进程加载更新后的代码。这意味着更新期间要结束相关工作，不能在运行中直接切换版本。

Application 在进入包变更准备时就标记受影响范围需要重启，防止收尾期间重新装配旧宿主。进入准备后取消或失败仍保留这项要求；尚在队列中等待的操作被取消时，不改变装配状态。

持久数据放在应用或空间的数据目录中，与安装目录分开。卸载 local 来源只移除配置，保留用户的包目录；npm/git 包的代码由 SDK 管理，学习记录和既有结果继续保留。

### 信任的实际范围

后台插件加载后就在 Repa 进程中运行，拥有宿主进程的权限。信任一个插件，意味着允许它以这些权限执行代码。包声明和输入输出检查用于确认接口是否符合约定，命令服务的沙箱也只约束经该服务启动的命令。

安装包时还可能执行安装脚本。目录查询会跳过缺包安装，只读取声明和资源位置，保留原安装设置及包内容。不过，为查找旧版全局 npm 安装位置，Pi 在查询过程中仍可能调用已配置的 npm 命令。

## 未完成项与待验证项

| 项目 | 当前状态与影响 | 后续工作 |
| --- | --- | --- |
| 前端入口的实际加载与使用 | 待前端接入。后端已返回入口位置、执行环境、API 范围和可用状态，官方界面尚未消费这些入口 | 由 [#10](https://github.com/Utopia-V/repa/issues/10)实现组件加载及生命周期，再用真实组件验证启停与接口匹配 |

代码更新后的进程重启是当前明确选择的策略。安装期间无法中止则是当前 Pi API 的限制，处理方式与升级核对要求见上节。

## 验证入口

[`plugin-packages.test.ts`](../../packages/repa/test/plugin-packages.test.ts) 使用临时目录、锁定的 Pi SDK 和设置文件，覆盖以下行为：

- 查找包和入口，报告缺失版本、API 不兼容及路径问题，查询时跳过安装和入口执行。
- 为纯 Repa 包过滤 Pi 资源，并把混合包和项目差量选择接入 Pi Loader。
- 在项目尚未整体受信任时，按用户明确授权管理其中的包。
- 保存本地包配置，通过本地 Git 仓库更新所选作用域的包，并保留插件业务数据。
- 配置无法保存时，返回失败。

在后端包目录运行：

```sh
node --import tsx --import ./test/environment.ts --test test/plugin-packages.test.ts
```

[plugin-resources.test.ts](../../packages/repa/test/plugin-resources.test.ts) 验证应用侧信任、项目资源过滤和预览；[plugin-api.test.ts](../../packages/repa/test/plugin-api.test.ts) 通过公开客户端验证包管理、结果持久化、请求记录的独占访问及重启要求，也检查跨空间会话与包安装、同范围串行以及排空退出。测试在 Linux、Node 24.19 与 Pi 0.87.1 上进行，使用临时本地包和 Git 仓库。

[plugin-backgrounds.test.ts](../../packages/repa/test/plugin-backgrounds.test.ts) 使用小说设定夹具，通过公共应用接口与真实 Pi 的 faux provider 验证两个领域同时提供背景、独立关闭、重启及新会话接续、准备失败和取消。静态与动态预览检查后台工厂调用次数，禁用后复制检查格式引用重映射；既有背景测试继续覆盖压缩、计量与分支。

[plugin-contributions.test.ts](../../packages/repa/test/plugin-contributions.test.ts) 核对真实轻量模块的选择、信任、禁用保留、独立状态、坏声明及 owner 冲突；[content-format-lifecycle.test.ts](../../packages/repa/test/content-format-lifecycle.test.ts) 检查固定格式、队列失效边界、普通读取与业务重传。动态包的公开接口接续由 [plugin-installation-api.test.ts](../../packages/repa/test/plugin-installation-api.test.ts) 覆盖，后台与背景的失效收尾另由对应生命周期测试核对。

[plugin-installation-process.test.ts](../../packages/repa/test/plugin-installation-process.test.ts) 使用编译后的公共入口启动独立 Node 后端，经过真实 Pi 本地包更新准备，确认旧工作排空、旧格式停止调用，以及退出旧进程后新进程实际读取另一版传递依赖。依赖文件由测试受控修改，SDK 操作负责触发准备与重启流程；这项测试不声称验证了远端下载或所有包管理器的更新行为。[plugin-installation-coordination.test.ts](../../packages/repa/test/plugin-installation-coordination.test.ts) 另核对快照维护窗口与多空间刷新失败后的统一失效。
