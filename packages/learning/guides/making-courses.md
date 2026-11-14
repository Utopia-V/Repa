# 把课件做成课

学习者把课件放进空间的 `materials/`，要你把它做成一门课。课写在空间的 `course/` 里，`course_check` 检查，`course_use` 让学习者用上。学习者的课、复习和测验只用最近一次 `course_use` 换用的那一版，写到一半的文件不会出现在里面。

课不是先整本做完再学。先很快地出整门课的轮廓，再只展开学习者快要学到的一小段；学习者学着前面的，后面的在后台接着展开。没学到的部分不花钱，轮廓里的错也便宜：发现时它后面还什么都没做。

## 顺序

1. **出轮廓，要快。** 用 `materials_list` 看有哪些课件、各有几页或几张，用 `materials_read` 只读每份开头的几页或几张（`from`、`to`），看目录、标题和章节划分，不细读全部材料。把整门课写成 `course.yaml` 加一批 `status: outline` 的 topic（写法见下面的“轮廓”），每个 topic 记下它在材料里的出处。`course_check` 通过以后运行 `course_use`，学习页上就有了整门课的轮廓。
2. **给学习者看轮廓**：分几部分、各讲什么、先后怎样。等他认可、删掉不学的、标出要紧的，再往下做；他要改的，改好再 `course_use`。
3. **只展开最前面的一到两节**：细读这几节出处里的材料，写成 `status: complete`，运行 `course_check`，按报出的问题逐处改正，直到通过，再运行 `course_use`。
4. **告诉学习者可以开始学了。** 后面的部分不必现在做：学习者学到已展开的部分只剩一节没学时，学习插件会在后台让 Agent 展开接下来的部分；学习者关掉了自动展开时，等他要求再做。第一段总由你在对话里展开，后台不会抢先做。学习者要先做某一部分时，照第 3 步展开那一部分。

`course_use` 时学习者若正在上课、复习或测验，而这一版改了展开过的 topic（不只是他正在学的，学过的也算），这一次不换用，回复会写明；只展开轮廓、增加部分时照常换用，他的任务不受影响。

`course_check` 和 `course_use` 的回复末尾写着学习者现在学的是哪一版、学过哪些 topic、后台是否正在展开哪几部分。后台正在展开时，不要同时改那几部分的文件。

做课不用 `bash`：改文件用 `edit` 和 `write`，要批量改也逐处改。命令要学习者逐条确认，而他看不懂一段脚本该不该放行。

## 轮廓会变

细读一段材料以后，常会发现原先的划分不对：两个部分其实是一回事，某一节该拆开，先后次序要调。

- **还没学过的部分可以随时改**：合并、拆分、调整次序和先修。轮廓里的知识点也只是估计，展开时按材料改。去掉一部分时从清单的 `topics` 里删掉它的 id 就够了，不在清单里的 topic 文件不读，`course_check` 只提醒。
- **学过的部分不推倒重排**：它的题目和学习记录照下面“规矩”里题目 id 的办法保留，要改正也只按那条规矩改。

## 后台展开

学习插件在后台交给你的任务写明要展开哪几部分、学习者学过哪些部分。这时没有人回答提问，也没有人能确认命令，所以不用 `bash` 和 `ask_user`，只用 `read`、`write`、`edit`、`ls`、`find`、`grep`、`materials_list`、`materials_read`、`course_check` 和 `course_use`。

1. 用 `read` 读 `course/course.yaml` 和要展开的 topic 文件，从它们的 `sources` 找到出处。
2. 用 `materials_read` 细读这几部分的出处，照“顺序”第 3 步写成 `status: complete`。轮廓要改的照“轮廓会变”改，已经展开的部分不动：学习者多半正在上课，这一版只要改了展开过的部分，`course_use` 就不换用。
3. 用 `course_check` 改到通过，最后运行 `course_use`。

做不完就停下，不要为了通过检查而删题，或把答案改成猜的。最后没有换用这几部分时，这一次展开记为没有成功；学习者再学完一节或明确要求时会再做。

## 文件

- `course/course.yaml`：课程清单，`topics` 按学习的先后列出。
- `course/topics/<topic id>.yaml`：每个 topic 一个文件，文件名就是 id，id 要列进清单的 `topics`。

`course/` 里别的文件不读，草稿、核对用的笔记可以放在别处。

## 一个完整的例子

同一目录下的 `example-course/` 是一门能通过检查、能上课的小课：`os01` 已经展开，`os02` 还是轮廓。写之前先读它的 `course.yaml`、`topics/os01.yaml` 和 `topics/os02.yaml`。清单是这样：

```yaml
id: os-memory          # 字母开头，字母、数字、下划线、连字符；定了就不再改
version: 1.0.0
title: 进程的基本概念
language: zh-CN
license: NOASSERTION
sources:
  slides:              # 来源的名字，topic 的 sources 用它引用
    title: 操作系统第二章课件
    file: materials/第二章 进程管理.pptx
    version: 学习者提供
    license: 学习者自用
    permits: [reference]
topics: [os01, os02]   # topic id 只用小写字母和数字，字母开头
```

不用 Python 的课不写 `runtime`。

## 出处

清单的 `sources` 登记用到的材料：学习者的课件写 `file`（空间里的路径，以 `materials/` 开头），网上的材料写 `url`（`https:` 链接），二者写一个。`title`、`version`、`license`、`permits` 都要写；学习者自己的课件照上面的例子写，`permits: [reference]` 表示只作取材参照、内容由你自己写。

topic 的 `sources` 写它取自哪份材料的哪里，`where` 写到页或张，例如 `- { source: slides, where: 第 12–15 张, use: reference }`。题目取自课件里的一道习题时，题目也可以写同样的 `sources`。学习者回顾时据此知道这段内容出自课件的哪里。

## 轮廓

`status: outline` 的 topic 只写这些，不进学习者的菜单：

```yaml
id: os02
title: 进程控制块
status: outline
minutes: 15
summary: 进程控制块里记了什么，系统怎样把它们组织起来。
prerequisites: [os01]
sources:
  - { source: slides, where: 第 9–14 张, use: reference }
kps:
  - { id: os02.k1, title: 进程控制块记录什么 }
  - { id: os02.k2, title: 进程控制块怎样组织 }
```

`summary` 是一句话的范围。一个 topic 约 15 至 20 分钟。

## topic 的要求

- `minutes` 在 5 到 60 之间；`prerequisites` 只列直接先修，指向清单里的 topic，不能成环。
- **展开了的 topic，先修也要展开。** 先修还是轮廓时，学习者永远学不到它，`course_check` 报 `prerequisite_outline`。所以按先修的次序展开。
- 每个 topic 2 至 4 个知识点 `kps`。知识点 id 写成 `<topic id>.k<数字>`，题目 id 写成 `<知识点 id>.<小写字母><数字>`，例如 `os01.k1.q1`。
- `status: complete` 的 topic，每个知识点都要有：`card`（`name` 不超过 24 字、一句话 `definition`、1 至 3 条 `conditions`、`example.from` 指向本知识点的例题或练习题），`lesson` 讲解，`example` 例题，至少 3 道 `practice`，至少 1 道 `review` 和 1 道 `quiz`。
- 讲解和题面用 Markdown。链接只能是 `https:` 或 `repa:concept/<知识点 id>`，不用 `![]()` 插图。

## 题目

一道题是 `body` 题面、`slots` 作答位和 `explanation` 解析。作答位用这几种：

| 作答位 | 写法 |
| --- | --- |
| 选择 | `type: choice`，`options` 每项 `{ id, content }`；单选 `key` 写一个选项 id，多选加 `multiple: true`、`key` 写 id 列表 |
| 填空 | `type: text`；文字答案加 `match: text`，`key` 写一个或几个可接受的写法；数值答案写 `format: integer` 或 `format: number`，`key` 写数 |
| 排序 | `type: order`，`items` 每项 `{ id, content }`，`key` 写正确顺序的 id 列表，要用上全部项 |

复习和测验题要由程序判分，所以只用上面这些有标准答案的作答位，不放开放作答。

每个作答位的答案要么由 `verify` 程序算出，要么列进这道题的 `manual`。

**数值答案一律写 `verify`，不用自己心算的结果。** 此前的一次试做里，自写的数值题手算答案五处全错，都是靠程序复算才发现的。答案是数的作答位（`format` 或 `match` 为 `integer`、`number`，或者按文字比较而答案全是数）列进 `manual` 时，`course_check` 报 `numeric_manual`；照抄题面里的常数也写成 `verify`，例如 `answers = {"threshold": 10}`。`verify` 是一段 Python，最后给 `answers` 赋值 `{作答位 id: 算出的答案}`，检查时在沙箱里运行，算出的答案要与 `key` 一致。例如：

```yaml
- id: os01.k1.q4
  body: 时间片是 20 ms，一个进程要运行 70 ms，它要被调度几次？
  slots:
    - { id: n, type: text, format: integer, key: 4 }
  explanation: 70 除以 20 向上取整是 4。
  verify: |
    import math
    answers = {"n": math.ceil(70 / 20)}
```

写了 `verify` 的课，清单要加下面这段 `runtime`，照抄，不改版本号：核对用的 Python 环境就是这一套，版本或包不符时检查不通过。

```yaml
runtime:
  pyodide: 314.0.7
  python: 3.14.2
  packages: { numpy: 2.4.6, pandas: 3.0.2 }
```

**要记住的内容用选择、填空、排序来考，作答位列进 `manual`**，例如 `manual: [state]`。课件里大约四成知识点是这一类。`manual` 的答案没有程序替你核对，`course_check` 会报出复习和测验题里有多少个，答案要你对照材料确认。

`kind` 是可选的题型标签，自己定，不影响出题和判分。

## 规矩

- **现成的习题只在题面完整、答案能核对时才用。** 课件和卷子里的题常缺条件、缺选项，答案本身也可能错；缺了就补全或改写，答案核对不了就另出。
- **题目 id 是学习记录引用的身份。** 换用过的题，内容实质变了就换一个新 id，旧 id 不再给别的题用。只改答案而题面不变时，学习者过去的作答会按新答案重判。删掉一道题，学习者对它的作答就不再算数。
- **复习和测验题换个情境考同一件事**，不要照抄练习题的题面和选项，学习者要能离开讲解独立作答。
- **选择题的错误选项写学习者真会选的错法**：常见的混淆、差一步的理解。一眼就能排除的选项等于没有出题。
- YAML 里，`true`、`false`、`null`、`001` 这类当文字用的值要加引号（选项 id 也是），含 `: ` 的文字整段加引号；不用锚点和别名。

## 检查

`course_check` 逐处列出问题：文件、行列、错误码和说明，多数说明写了怎样改；问题多时分页，末尾写明下一页的 `offset`。“提醒”不妨碍通过。课里有 `verify` 而核对没能运行时（这台机器建不了沙箱，或缺少离线包），检查不会通过，回复写明这些核对没有运行及原因。
