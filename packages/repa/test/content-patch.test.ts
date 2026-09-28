import assert from "node:assert/strict";
import test from "node:test";
import { applyTextPatch, parsePatch, type PatchChunk } from "../src/content/patch.js";

function chunks(body: string): PatchChunk[] {
  const [action] = parsePatch(`*** Begin Patch\n*** Update File: notes.md\n${body}\n*** End Patch`);
  assert.equal(action?.kind, "update");
  return (action as Extract<ReturnType<typeof parsePatch>[number], { kind: "update" }>).chunks;
}

test("解析多文件补丁、移动、锚点和明确上下文，保留路径原文", () => {
  assert.deepEqual(parsePatch([
    "*** Begin Patch",
    "*** Add File: 新 笔记.md ",
    "+第一行",
    "+",
    "*** Add File: empty.txt",
    "*** Delete File: old.txt",
    "*** Update File: from.md",
    "*** Move to: to.md ",
    "@@ 章节",
    " 保留",
    "-旧",
    "+新",
    "+补充",
    " 结尾",
    "*** End of File",
    "*** Update File: rename-only.md",
    "*** Move to: renamed.md",
    "*** End Patch",
    "",
  ].join("\r\n")), [
    { kind: "add", path: "新 笔记.md ", content: "第一行\n\n" },
    { kind: "add", path: "empty.txt", content: "" },
    { kind: "delete", path: "old.txt" },
    {
      kind: "update",
      path: "from.md",
      moveTo: "to.md ",
      chunks: [{
        oldLines: ["保留", "旧", "结尾"],
        newLines: ["保留", "新", "补充", "结尾"],
        contextLines: [[0, 0], [2, 3]],
        anchor: "章节",
        eof: true,
      }],
    },
    { kind: "update", path: "rename-only.md", moveTo: "renamed.md", chunks: [] },
  ]);
});

test("宽松定位只影响比较，未修改上下文保留 Unicode、空白和逐行换行", () => {
  const original = "前言①Ａ\r\n  “保留”\u00a0—\t \r旧行\n结尾e\u0301";
  const patch = chunks('@@\n "保留" -\n-旧行\n+新行\n 结尾e\u0301');
  assert.equal(applyTextPatch(original, patch), "前言①Ａ\r\n  “保留”\u00a0—\t \r新行\n结尾e\u0301");
  assert.equal(
    applyTextPatch("“旧”—①Ａ\r\n末行", chunks('@@\n-"旧"-①Ａ\n+"新"-①Ａ')),
    '"新"-①Ａ\r\n末行',
  );
  assert.throws(() => applyTextPatch("Ａ", chunks("@@\n-A\n+B")), /匹配失败/);
});

test("新增行沿用所在区域换行，修改末行保留原来缺少末尾换行的状态", () => {
  assert.equal(
    applyTextPatch("a\r\nb\rc\nlast", chunks("@@\n-b\n+b1\n+b2\n@@\n-last\n+LAST")),
    "a\r\nb1\rb2\rc\nLAST",
  );
  assert.equal(applyTextPatch("a\r\nb\rc\nlast", []), "a\r\nb\rc\nlast");
});

test("重复块和重复锚点报告歧义，采用最严格的唯一匹配", () => {
  assert.throws(
    () => applyTextPatch("head\nsame\ntail\nsame\n", chunks("@@\n-same\n+new")),
    /歧义.*第 2 行.*第 4 行/,
  );
  assert.throws(
    () => applyTextPatch("same \nsame\t\n", chunks("@@\n-same\n+new")),
    /歧义/,
  );
  assert.equal(
    applyTextPatch(" same \nsame\n", chunks("@@\n-same\n+new")),
    " same \nnew\n",
  );
  assert.equal(
    applyTextPatch("first\nsame\nsecond\nsame\n", chunks("@@ second\n-same\n+new")),
    "first\nsame\nsecond\nnew\n",
  );
  assert.throws(
    () => applyTextPatch("section\na\nsection\nb\n", chunks("@@ section\n-b\n+B")),
    /锚点匹配存在歧义/,
  );
});

test("多个编辑块对同一原文定位，允许共享上下文并拒绝重叠改写", () => {
  assert.equal(
    applyTextPatch("a\nb\nc\nd\n", chunks("@@\n a\n-b\n+B\n c\n@@\n a\n b\n-c\n+C\n d")),
    "a\nB\nC\nd\n",
  );
  assert.throws(
    () => applyTextPatch("a\nb\nc\n", chunks("@@\n-b\n+B\n@@\n-b\n+other")),
    /重叠/,
  );
  assert.throws(
    () => applyTextPatch("a\nb\nc\n", chunks("@@\n-c\n+C\n@@\n-b\n+B")),
    /匹配失败/,
  );
});

test("空文件、首尾增删和显式空行按实际修改保留边界", () => {
  const cases = [
    { original: "", body: "@@\n+first", expected: "first\n" },
    { original: "last", body: "@@\n+first\n last", expected: "first\nlast" },
    { original: "first", body: "@@\n first\n+last", expected: "first\nlast" },
    { original: "first", body: "@@\n+last", expected: "first\nlast" },
    { original: "first\r\n", body: "@@\n+last", expected: "first\r\nlast\r\n" },
    { original: "a\nb", body: "@@\n a\n-b", expected: "a\n" },
    { original: "a\n", body: "@@\n-a", expected: "" },
    { original: "a", body: "@@\n-a", expected: "" },
    { original: "a", body: "@@\n-a\n+", expected: "\n" },
    { original: "a", body: "@@\n a\n+", expected: "a\n\n" },
    { original: "a\n\n", body: "@@\n a\n-\n*** End of File", expected: "a\n" },
    { original: "a\nb", body: "@@ a\n+middle", expected: "a\nmiddle\nb" },
  ];
  for (const { original, body, expected } of cases) {
    assert.equal(applyTextPatch(original, chunks(body)), expected, JSON.stringify({ original, body }));
  }
});

test("EOF 只匹配文件末尾，不把不存在的空行当作终止符跳过", () => {
  assert.equal(
    applyTextPatch("same\nmiddle\nsame\n", chunks("@@\n-same\n+last\n*** End of File")),
    "same\nmiddle\nlast\n",
  );
  assert.throws(
    () => applyTextPatch("same\nmiddle\nlast\n", chunks("@@\n-same\n+new\n*** End of File")),
    /文件末尾/,
  );
  assert.throws(
    () => applyTextPatch("a\n", chunks("@@\n-a\n-\n+new")),
    /匹配失败/,
  );
});

test("损坏的补丁明确失败，正文中的补丁标记仍可作为上下文", () => {
  assert.throws(() => parsePatch("*** Begin Patch\n*** Add File: a\n+x"), /必须/);
  assert.throws(() => chunks("@@"), /编辑块不能为空/);
  assert.throws(() => chunks("@@\n-old\n+new\n*** End of File\n+later"), /必须以 @@ 开始/);
  assert.throws(() => chunks("@@\ninvalid"), /编辑行必须/);
  assert.equal(
    applyTextPatch("*** End Patch\nold\n", chunks("@@\n *** End Patch\n-old\n+new")),
    "*** End Patch\nnew\n",
  );
});
