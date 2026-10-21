# 写课说明

这份说明给写课的 Agent 和社区作者：按这个格式写一个 topic，要满足什么，怎样自查。字段的完整定义在 [`src/format/schema.ts`](../src/format/schema.ts)，现成的例子是 [`py01`](python/topics/py01.yaml)（追踪与预测）、[`py12`](python/topics/py12.yaml)（写清需求，不用代码）和 [`py17`](python/topics/py17.yaml)（pandas 读表、小改代码）。

## 文件放在哪里

- `courses/<课程>/course.yaml`：课程清单，写课程 id、版本、判分运行时（含运行前导 `prelude`）、来源登记和 topic 列表。
- `courses/<课程>/topics/<topic id>.yaml`：每个 topic 一个文件，文件名就是 id。新增 topic 时，同时把 id 加进清单的 `topics`。

## 一个完整的 topic

一个 topic 是一节约 20 分钟的课（`minutes`），含 2–4 个知识点。只写了名称、知识点、先修和来源的骨架是 `status: outline`；内容写齐后改成 `status: complete`，这时检查会要求每个知识点都有：

| 字段 | 要求 |
| --- | --- |
| `card` | 概念卡：`name` 短名称（对话里提到时作链接文字），`definition` 一句话定义，`conditions` 1–3 条适用条件或常见混淆，`example.from` 指向本知识点的例题或练习题（原学习位置），`example.text` 是那个例子的简短回顾 |
| `lesson` | 讲解，Markdown |
| `example` | 例题，带完整解析；展示后不计学习证据 |
| `practice` | 至少 3 道练习 |
| `review`、`quiz` | 复习题池和测验题池，各至少 1 道，建议各 2 道 |

复习和测验题要脱离讲解独立作答，所以：

- 考同一个机制，但换题型、情境和数据，不要只换几个数字和名字，也不要沿用练习题的选项原文；
- 至少有一个由程序判分的作答位；不能放 `rubric`（由人或模型评）的开放作答题。

`intro`、`wrapup` 是开场和收束的话；`notes` 是写给作者的备注（范围、节奏、题型安排），学习者看不到。

讲解和题目都要自己写。外部材料登记在清单的 `sources`，topic 的 `sources` 写清用了哪一章哪一节、怎样用：`reference` 是只作取材参照、内容自行编写；`adapt`、`code`、`quote` 分别是改编文字、复用代码和短引用，必须写 `notice`，并且只能用在该材料许可允许的范围内。Python for Data Analysis 的正文只能 `reference`。

## 资格、补救与信用分开写

写一条先修时，先问“还没学过它，能不能开始这节课”。这个判断写进 topic 的 `prerequisites: [py01, py03]`，只列直接先修。它只决定学习资格，不说明做本课的题能复习到什么。

如果某个 KP 做不下去，还需要知道从哪里补起。把这个 KP 内容上最关键的先修 topic 写进 `keyPrerequisites`，例如 `py21.k2` 追踪中间列时，可以直接指向跳层的 `py01`。目标必须在先修祖先中；缺省或空列表表示没有另外指定跨 topic 补救。不同 KP 分别判断，不把一节课的关键先修复制给所有 KP。

信用要另外判断。topic 的 `encompassings` 写成 `[{topic: py01, weight: 0.5}]`，表示它覆盖另一个 topic 的关系；权重在 `[0,1]`，缺失或零权重不传信用。覆盖对象可以不是先修祖先，比如文字编号清理题实际执行了另一条支线里的转换操作。先修图和覆盖图分别检查引用、重复、自指和环，零权重的声明边也不能成环，所以取出正权重边后仍是 DAG。当前 Python 课的正权重统一取 0.5，是 Repa 尚待学习数据校准的假设，不是 MA 公开的数值。逐边依据与零权重疑点见[课程关系核对](python/relations-review.md)。

最后看每一道题实际做了什么。`measures` 只列直接考查的本 topic KP，省略时就是所在 KP。`uses` 列本题实际执行的其他子技能，可以为空，也可以指向非祖先 topic 的 KP；不要因为它是先修、出现在讲解类比里，或需求已经写在题面上，就给它信用。同一个 KP 不同时列进 `measures` 和 `uses`，两份列表各自也不能重复。覆盖权重与题目归属需要配合使用：覆盖边本身不证明每道题都执行了对方技能，后续学生模型只应对题目有效归属中有证据的部分传信用。

## id 与版本

- 知识点 id 写成 `<topic id>.k<数字>`，题目 id 写成 `<知识点 id>.<小写字母><数字>`。习惯上例题用 `e0`，练习用 `q1`、`q2`…，复习用 `r`，测验用 `x`。
- id 是稳定身份，题目换题池也不改 id。题目实质换了内容，就给新 id。发布后 id 不复用；拆分 KP 时新建 KP 和题目 id，并把旧 id 加进清单的 `retiredIds`。退役 topic 时也登记其 KP 与题目 id。当前课程尚未发布，退役列表从空开始，由作者在内容变更时维护。
- 题目版本由底座 `contentVersion` 算出，是题面、作答位（含答案和判分规则）、解析、测试、用到的数据，以及有效 `measures/uses` 的内容哈希。两份归属列表按集合排序；省略 `measures` 与显式写所在 KP 相同，省略 `uses` 与 `[]` 相同。改信用归属会换版本，换列表顺序不会。
- `kind`、只为检查而写的 `verify`、`manual` 和代码题的 `accepts`、`rejects` 不影响题目版本；topic 末尾的核对记录 `verified` 也不影响。不用手写题目版本。

## 内容怎样写

凡是题面、讲解、选项、解析的位置都可以直接写 Markdown：

- 从第一列开始的 ```` ```python ```` 代码块会成为单独的代码块；写成 ```` ```python startLine=1 ```` 显示行号，题目里就能说“第 3 行”。
- 提到学过的概念时写 `[布尔掩码](repa:concept/py17.k1)`，指向知识点 id。链接只能用 `https:` 和 `repa:concept/`，不用 `![]()` 插图。
- 交付时会打乱选项和排列块的顺序，并把它们的 id 换成不透明的，所以 id 可以带含义，方便写题和写反馈。正确选项不要总放在同一个位置，解析里按内容指称选项，不要说“第二个”。

## 题目怎样写

一道题是题面 `body` 加若干作答位 `slots`，再加解析 `explanation`。作答位是交互词汇的五种形状，答案写在作答位上：

| 作答位 | 用于 | 答案与判分 |
| --- | --- | --- |
| `choice` | 单选、多选、判断 | `key` 单选写一个选项 id，多选写 id 列表；多选的正确答案可能一项都不选时加 `minSelected: 0`。多选加 `scoring: options` 时每个选项的勾选状态各 1 分。选项可带 `feedback`，选错时给出 |
| `text` | 数值、短答、Python 显示内容、开放说明 | `key` 写一个或多个可接受的值。`format: integer` 时按整数比较（字符串答案如“尚未定义”按原文比较）；`match: text` 去掉首尾空白逐字比较，学生多加的一对引号不算错；`match: output` 按 Python 显示内容比较，`'a'` 与 `"a"` 相同，`True` 与 `1`、`6` 与 `6.0` 不同，字典按显示顺序比较，标准答案恰好是 `NOTHING`、`ERROR`、`FUNCTION` 时不分大小写；`match: nonempty` 只要求非空。`match` 为 text、output 时，`key` 和 `feedback` 的 `when` 都写成带引号的文字。数值带单位时加 `suffix`（如“分钟”“mL”），输入框后会标出单位，免得学习者把单位写进答案。开放作答写 `rubric` 而不写 `key`，只能放在例题和练习里 |
| `order` | 排序、选出并排序、Parsons | `items` 每块写 `content` 或一行 `code`；`partial: true` 允许留下不用的块；`key` 是标准排列，`alternatives` 是其他正确排列。要排缩进时加 `indent`（最大层级）和 `indents: {块 id: 层级}`，缩进按块计，并且要加 `tests` 按测试判。一块都不选按没答处理，所以正确答案可能为空时，改问行数 |
| `table` | 追踪表、逐行掩码、WWPD | `columns` 里给作答列加 `input`：`bool`（True/False）、`integer`、`text`，或完整写法 `{ type: text, format, quick, match }`；选择格写 `{ type: choice, options: [{ id: pass, label: 达标 }, …] }`；要填 `ERROR` 的格写 `{ type: text, match: output, quick: [ERROR] }`，`label` 是学习者看到的文字，单元格里写选项 id。在作答列里，单元格直接写的值就是这一格的答案；在其他列里，写的是固定显示的文字，要写成带引号的字符串。数值格没有容差：题面写明“保留两位小数”之类，`key` 就写成那个小数（`match: number` 按数值比较），或者把数据设计成能整除 |
| `code` | 小改代码、骨架加 doctest | `starter` 是作答框里的初始代码，`solution` 是参考答案，`accepts` 是其他应通过的写法，`rejects` 是常见错误写法（每份写 `why`），`tests` 是测试 |

题目用到的小表写在 topic 的 `data` 里：`kind: dataframe` 给出 `name`（变量名）、`index`、`columns`，题目写 `data: [T]` 时表格会显示在题面最前面，核对和测试也会准备好这个变量；不讲 pandas 的题加 `showIndex: false`。YAML 把 `1.0` 读成和 `1` 一样的数，写了小数的列要在 `dtypes` 里声明为 `float`（表格里也会显示成 `1.0`）；`001` 这样的编号要加引号。`kind: python` 是一段准备代码，`display` 是题面里给学生看的说明。

测试由 `data` 和 `setup` 准备输入，然后运行作答代码，再比较：

- `expect`：键是作答运行后求值的表达式，值是期望结果的表达式（在只有运行前导、data 和 setup 的全新环境里求值，所以 `pd`、`np` 可用）。写一项 `df: df` 就能检查原表没有被改。
- `doctest`：`>>> ` 后是语句，下一行是交互解释器应显示的内容；`>>>` 和 `...` 后面要有一个空格。
- `stdout`：作答打印的全部内容。
- `hidden: true` 的测试只告诉学生通过与否。至少留一个公开测试。

测试要能分出常见错误：`rejects` 里的每份错误写法，以及作答框里的 `starter`，都必须在某个测试上失败；`accepts` 里的写法必须通过全部测试。测试的数据不要恰好让错误写法也得出对的结果，例如表已经按编号排好时，多加一次排序也查不出来。

## 核对：每个答案都要独立算一遍

诊断、测验和复习用的题必须核对过；能用程序核对的，用程序独立算一遍，程序算不出的，让模型独立再解一遍。每道题的每个作答位只能是下面三种之一：

1. **`verify` 程序核对。** 一段在 Pyodide 里运行的 Python，结束时给 `answers` 赋值 `{作答位 id: 算出的答案}`。检查程序把算出的值当作一份作答，按作答位自己的判分规则去判，必须判对；`key` 里另写的每个可接受值也要与算出的答案一致。有多种正确排列的排列题无法这样核对，改用 `tests` 或列进 `manual`。
2. **`manual` 程序算不出的作答位。** 答案要靠语义判断、写不出核对程序的作答位（例如把自然语言要求填成字段），列进 `manual`。复习和测验题里的这些作答位用 `npm run course:confirm` 核对：只把学习者看得到的题面交给模型（默认 DeepSeek flash），不给答案和解析，让它按作答位的格式独立作答，再用作答位自己的判分规则比对。全部一致时，在 topic 文件末尾的 `verified` 段记下题目 id、核对范围版本 `scope: question-runtime-v1`、核对哈希、模型和日期；不一致时只列出差异，不记录，由人判断是题面有歧义、答案错了，还是模型错了。题面、答案、判分定义、用到的数据或课程 `runtime` 改变后，`course:check` 会要求重新核对；只改信用归属不使证明失效。无 `scope` 的旧记录保留，复用时还要按原算法重算一致，且课程运行环境与原基线一致。例题和练习里的 `manual` 不强制核对。
3. **测试负责。** 代码题、带 `tests` 的排列题和开放作答不用 verify。

`verify` 里可以用：

| 名字 | 含义 |
| --- | --- |
| `CODE` | 题面里全部 python 代码块拼成的程序；`BLOCKS` 是逐块的列表 |
| `OPTIONS` | `{作答位: {选项 id: 选项里的代码}}`，用来逐个运行代码选项。只收单选、多选选项里的围栏代码块（```` ```python ````）；写成行内代码的选项、排列题的块都不收 |
| `CELLS` | `{作答位: {行 id: {列 id: 文字}}}`，表格里固定显示的格，例如 WWPD 题写在固定格里的输入 |
| `run(code=CODE, **inputs)` | 在全新环境里运行，返回 `.out`（打印内容）、`.lines()`、`.error`（异常类型名或 None）、`.error_line`（异常停在代码的第几行；语法错误取它自己的行号，没有异常为 None）、`.vars`、`r["变量名"]`；`inputs` 是事先赋好的变量，不能取名 `code` |
| `trace(code=CODE, names=[...])` | 逐条运行顶层语句，返回每条执行后这些变量的值（没定义的不在字典里） |
| `repl(code=CODE)` | 像交互解释器那样逐条输入，返回每条的显示内容，沿用 `NOTHING`、`ERROR`、`FUNCTION` |
| `executed_lines(code=CODE)` | 运行代码，返回实际执行过的行号（升序，含函数体）；`def`、`else:` 这类本身没有字节码的行不会出现 |
| `calls(code=CODE, name="f")` | 运行代码，按调用先后返回函数 `f` 每次调用的记录：`.args`（形参收到的值）、`.locals`（函数结束时的局部变量）、`.returned`（返回值），`call["形参"]` 等同于 `call.args["形参"]` |
| `show(值)`、`as_shown(文字)`、`ERROR`、`NOTHING`、`FUNCTION` | 直接得到 `match: output` 作答要的显示内容：`show(None)` 是 `NOTHING`，`show(len)` 是 `FUNCTION`，`show([1, 'a'])` 是 `[1, 'a']`；`as_shown` 把一段已经是显示内容的文字标出来 |
| `pd`、`np`，以及题目 `data` 里的变量 | 直接可用：`pd`、`np` 来自课程清单 `runtime.prelude` |

算出的值写成作答的方式：普通作答里，字符串原样，其他值用 `repr`（`True` 成为 `"True"`，`4` 成为 `"4"`）；`match: output` 的作答里，字符串也取 `repr`（`'42'` 带引号），布尔值、None 和数直接给值，不要自己 `repr`；只有 `.out`、`.lines()`、`repl()`、`show()`、`as_shown()` 和 `ERROR`、`NOTHING`、`FUNCTION` 给出的显示文字原样使用。**对 `run().out` 做 `.strip()`、切片、拼接之后，结果退回普通字符串，会被再取一次 `repr`，核对就判不一致**：要逐行用 `.lines()`，要自己加工就用 `as_shown(...)` 重新标出来。选择题给选项 id，多选和排列题给 id 列表，表格给 `{行 id: {列 id: 值}}`，只写作答格。核对程序要独立推出答案，不要把标准答案再抄一遍；从选项里挑答案时，先求出全部符合条件的选项，确认恰好一个，例如 `fits = [...]; answers = {"line": fits[0] if len(fits) == 1 else fits}`。

## 判分运行时

核对与测试都在课程清单写明的运行时里运行：Pyodide 314.0.7，Python 3.14.2、pandas 3.0.2、NumPy 2.4.6，与学习者运行代码的环境相同。题目的输出、报错信息和 pandas 行为都以它为准，不能拿本机的 CPython 和 pandas 代替。

- **运行前导。** 清单 `runtime.prelude` 是一段 Python（本课是 `import pandas as pd` 和 `import numpy as np`）。每次运行题目代码、测试的 `setup`、`expect` 表达式和 `verify` 之前，都先在同一个命名空间里运行它，学习者在 Repa 里运行代码时用的也是同一份。所以题目里直接写 `pd`、`np`，不要再为它们加隐藏的 python 夹具。
- **题与题互不影响。** 每次运行都用全新的命名空间和空的工作目录，pandas 与 NumPy 的选项、`sys.path`、环境变量也恢复原样，上一次写出的文件、留下的变量不会带到下一次。读写文件的题，文件要由自己的 python 夹具写出，不要指望别的题留下的文件，也不必为此给每道题换文件名。

参考解、`accepts`、`rejects` 和 starter 各从干净解释器开始，按正式判分的顺序运行全部测试。前一份候选对模块的改动不会影响下一份候选。

容易出错的地方：

- pandas 3 的 Copy-on-Write：派生对象的修改不会回写原表，链式赋值不能更新原表。
- pandas 3 的文字列默认是 `str` 类型；`pd.DataFrame({"a": []}, index=[])` 的空列却是浮点。期望一张空表时写 `pd.DataFrame(columns=["a"])`。测试只比较列类型的大类（整数、浮点、布尔、文字或对象等）。
- Python 3.14 的报错信息与旧版本不同；题目问异常时问类型，不问整段信息。
- 超过一万个元素的值不比较，报“太大，无法比较”；测试里改为比较 `.head()`、`.shape` 这类更小的表达式。
- NumPy 2 起，pandas 取出的单个数在交互窗口里显示成 `np.int64(13)`。WWPD 只问 shape、列表、文字这类显示稳定的东西；问取值时用 `format: integer` 的文字格。
- `expect` 里标量也按类型比较，`6.0` 和 `6` 不同。
- 小表上 `sort_values` 的默认排序碰巧和稳定排序结果一样，并列的行保持原来的先后，但文档并不保证。问完整顺序的题，要么没有并列，要么给出次要排序键，要么写明 `kind="stable"`。“默认排序保不保证并列顺序”这类题不能靠运行一次的结果写标准答案：`verify` 只能按文档的约定推出，或者列进 `manual`。
- 缺失值和空串的作答：缺失写 `NaN`（对象列里的 None 写 `None`），空字符串写 `""`（两个双引号）。表格格子和文字框空着就是没答，所以空串必须有看得见的写法；需要时给格子加 `quick: [NaN, '""']`，让学习者一键填入。`match: output` 的格子按 Python 显示内容比较，空串写 `''`。

## 自查

在仓库根目录：

```sh
npm run course:runtime -- --from <已有离线包的目录>   # 第一次：准备离线 Pyodide 包；不给 --from 时联网下载
npm run course:check                                 # 结构、交叉规则、标准答案和 Pyodide 核对
npm run course:check -- --topic py17                 # 只核对正在写的 topic 的代码，结构仍查整门课
npm run course:check -- --no-run                     # 只查结构，不运行代码
npm run course:confirm -- --topic py12 --dry-run     # 看要发给模型的请求，不调用模型
npm run course:confirm -- --topic py12               # 模型核对复习和测验题里的 manual 作答位，会产生费用
```

完整 `course:check` 成功后，会在课程根目录生成随课程发布的 `expected.json`。它保存代码题测试的预计算期望值；改动题目、夹具、运行前导或运行环境后，需要重新运行完整核对。只检查结构或限定 topic 时不发布产物，也不手工修改其中的期望值。绑定与使用方式见[Python 执行边界](../../../docs/development/learning-flow.md#python-内部执行边界)。

`course:confirm` 经 Repa 底座的 Agent 运行时调用模型，凭据用 `~/.repa/agent/` 里已经登录的（`--agent-dir` 可改），不写进任何文件，也不改动那里的 `settings.json`。已有当前核对范围证明的题不再发请求；`--max-requests` 限制这次的请求数（默认 50，输出不合格式时重试一次也算在内），`--log` 把请求和模型的作答另存一份 JSONL（文件已存在时在发请求之前就报错，每道题有结果就写一行）。几个 `course:check`、`course:confirm` 可以在同一个 worktree 里同时运行。

发给模型的请求里，选项、排列块和表格选择格的 id 已经换成 a、b、c……，所以 id 可以带含义（例如 `faithful`）；选择格显示标签，多行代码选项原样保留，带 `startLine` 的代码块每行前有行号。只有一列要填的表格，模型可以答 `{行 id: 值}`。

代码核对需要 Linux 的 Landlock（ABI 4 以上）和 libseccomp，在别的系统上只能用 `--no-run`。检查通过之后，再自己读一遍：

- 解析是否讲清了为什么，而不只是重复答案；
- 复习和测验题是不是换了题型和情境、仍然考同一个机制；
- `course:confirm` 列出的不一致各是什么原因。模型答对只说明它从题面读出了同一个答案，题目是否考到了要考的东西，仍要自己看。

YAML 的几个坑：

- `001`、`true`、`10` 这类值要当文字时加引号，例如选项 id `"4"`；
- 含 `: ` 的内容（例如 Python 字典 `{"a": 1}`）整段加引号，一般用单引号；
- 以反引号开头的内容加引号，例如 `` "`sample_id`" ``；
- 多行的讲解、代码和核对程序用 `|` 块；
- 选项、块、行列的 id 写成 `null`、`true`、`false` 或数字时，YAML 会读成空值、布尔值或数，要加引号（`"null"`）；id 必须以字母或数字开头，`_merge` 这样以下划线开头的不合格式；
- flow 映射 `{ id: x, content: … }` 里的内容含英文逗号时要加引号（中文逗号不用）；代码题 `accepts`、`rejects` 里单行的代码含字典时同样整段加引号；
- 不用锚点和别名，需要共用的数据写成 `data`。

Python 开头两周的实际路线、逐 KP 库存与新增题对应见[开头路径题量核对](python/opening-item-supply.md)。lesson/review 与 quiz/retake 均按真实策略核对，候选库存与已完成核对的供给分别列出。
