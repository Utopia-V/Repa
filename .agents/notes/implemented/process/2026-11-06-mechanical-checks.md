# 能机械判断的规则交给检查

状态：已落地

## 问题

Repa 的代码规范原先全部是文字，`repa-code-style` 最后一句甚至写明不引入 linter。代码大多由 Agent 编写，而 Agent 会照着仓库里已有的写法写，好的坏的都照抄；文字规则只在 Agent 读到并且认为适用时才起作用。规则越多、代码库越大，文字就越守不住，偏离要等审查或者出了问题才被发现，那时可能已经被复制到好几处。

审查也因此负担过重：审查者要逐条核对文字规则，作者与审查者为同一类问题来回多轮，而这类问题本来可以由程序在一秒内指出。

## 决定

凡是能机械判断的规则，都做成检查，在 `npm test` 最先运行的 `npm run lint` 中执行，报错信息直接写明该怎么改；判断性的约定才留在文字里。

现有的检查：

- **ESLint**（`eslint.config.mjs`，只用 ESLint 与 typescript-eslint 自带的规则，报错写成改法）：
  - 源码与测试都不用 `any`、`@ts-ignore`、`@ts-nocheck`；`@ts-expect-error` 须写明原因。
  - 源码不用非空断言。这条防的是用 `!` 代替边界校验，所以只管源码；测试里的 `!` 表达“这里必有值”，不在此列。
  - `apps/web/src` 只经 `@repa/base/client` 与 `@repa/base/protocol` 接入底座，不引入 Node 内置模块。
- **浏览器边界脚本**（`scripts/checks/browser-boundary.ts`）：入口是 `@repa/base/client`，加上 `apps/web/src` 实际引用的每个 `@repa/*` 子路径（如 `@repa/learning/protocol`、`@repa/materials/protocol`、`@repa/python-runner/browser`）。脚本按各包 `package.json` 的 `exports` 找到源码，沿相对导入和包之间的引用走遍它们依赖的全部模块，报出引入 Node 内置模块、Pi 或后端存储依赖的文件和行号；纯类型的导入编译后会被擦掉，不计在内。ESLint 只看单个文件，这条规则管的是整条依赖链，所以单独写成脚本。入口取自页面的实际引用，不另维护一份清单：页面若改引某个包的后端入口，那个入口里的 Node 依赖就在它所在的文件处报出。
- **界面文字检查**（`scripts/checks/ui-strings.ts`）：界面文字只放在字符串文件里，组件不写字面量，见[界面文字与基础组件的约定](../architecture/2026-11-06-ui-strings-and-components.md)。

此后的做法：

- 同一种错误在审查或使用中出现第二次，先问能不能写成检查，再考虑写进文字。
- 规则一旦由检查保证，就从文字里删掉，理由留在检查的报错信息和注释里，不让两处各保留一份。
- 审查不报检查已经管的事，改为依据 `REVIEW.md` 判断什么阻止合并。

凡是要求所有人的 Agent 遵守的规则，写进仓库的 `AGENTS.md` 或做成检查；维护者个人的 `CLAUDE.md` 和 Agent 的记忆，另一位开发者的 Agent 和审查者都看不到。

## 考虑过的其他做法

继续只用文字。成本最低，但它正是原先的问题：规则写得越多越没人读完，违反要等审查或事后才发现。

自写 ESLint 插件或引入依赖图工具。这些规则用 ESLint 自带的 `no-restricted-syntax`、`no-restricted-imports` 就能表达，依赖链只需一个小脚本；等真有自带规则表达不了的需求时再写插件。

在 ESLint 里为学习、课件、Python 三个包各列一份“页面可以引用的子路径”。浏览器边界脚本从页面的实际引用出发，已经能报出引错的入口，再列一份清单只会与 `package.json` 的 `exports` 不一致。

## 影响

- 新增 `eslint` 与 `typescript-eslint` 两个开发依赖，`npm test` 多花几秒。
- 规则写得太死会拦下合理的写法，所以每条规则都要能说出它防的是什么问题；说不出就不该加。
- 浏览器边界脚本用正则识别导入，遇到罕见的写法可能漏报，漏报时再补。它认定工作区包的 `exports` 指向 `dist/X.js`、源码在 `src/X.ts`；包换了构建布局时要随之改。
