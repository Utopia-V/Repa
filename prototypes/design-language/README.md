# 设计语言原型

这里是 Repa 设计语言“复”的候选稿和可以操作的原型。内容是整门 Python 课的真实内容，后端是模拟的，判分用字符串比较，代码不运行，日期、记忆和辅导的回答都是演示。界面文字均为占位，定稿按 [#101](https://github.com/Utopia-V/Repa/issues/101) 由人书写。

| 文件 | 内容 |
| --- | --- |
| [LANGUAGE.md](LANGUAGE.md) | 语言本身：版面、单元、字、色、距、动、状态、模式 |
| [CHECKLIST.md](CHECKLIST.md) | 换了主体也成立的要求、学习者每一刻要什么、知识库各视图的任务，带出处和逐条结果 |
| [CRAFT.md](CRAFT.md) | 细节规范的逐条核对 |
| `repa.html`、`product/` | 产品原型 |
| `app.html`、`matrix.html`、`explore.html`、`index.html`、`specimen.html`、`forms.html`、`themes/` | 探索稿：8 种框架、9 种皮肤、19 种图形，保留备查 |

## 运行

在仓库根目录启动静态服务，再用浏览器打开：

```sh
python3 -m http.server 5180 --directory prototypes/design-language
```

| 地址 | 看到什么 |
| --- | --- |
| `http://127.0.0.1:5180/repa.html` | 第一天 |
| `http://127.0.0.1:5180/repa.html?later=1` | 学了几周 |
| `http://127.0.0.1:5180/repa.html?later=1&dark=1` | 深色 |
| `http://127.0.0.1:5180/repa.html?later=1#/k/py02.k1` | 知识库的页面 |
| `http://127.0.0.1:5180/repa.html?later=1#/map/py12` | 全图 |
| `http://127.0.0.1:5180/repa.html?later=1&go=wrong#/learn` | 答错 |

`go` 经真实操作走到某个状态，取值见 `product/repa.js` 末尾的 `demo`。

可以这样试：在地图上指一格再点开；上一节课，故意答错一题，再问一句；做到一半点左上角“今天”再回来；按 `/` 搜一个学过的词；在知识库里按键盘走目录树。

## 来源与许可

`core/full.js` 由 `tools/export_course.py` 从 `packages/learning/courses/python` 导出，`core/items.js`、`course.js` 也出自这门课，许可同 [课程的 LICENSE](../../packages/learning/courses/python/LICENSE)。重新导出：

```sh
uv run --no-project --with pyyaml python prototypes/design-language/tools/export_course.py
```

`fonts/latin/` 是 IBM Plex 的子集，许可见 [LICENSE.txt](fonts/latin/LICENSE.txt)。
