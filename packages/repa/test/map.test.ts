import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { buildMap, loadState } from "../src/map.js";

async function kb(t: TestContext, files: Record<string, string>): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-map-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
  return root;
}

const line = (value: object) => `${JSON.stringify({ v: 1, ...value })}\n`;

test("地图只投影这一层、这一层的 MOC 列进来的卡片和它们的先修；快要忘的先修标出来，别的领域只出现在顶层目录", async (t) => {
  const root = await kb(t, {
    "CSAPP/第9章/页表.md": "---\nsummary: 把虚拟页映射到物理页的表\nrequires: [缓存]\n---\n正文",
    "CSAPP/第9章/TLB.md": "---\nsummary: 页表项的缓存\n---\n正文",
    "CSAPP/第9章/存储层次.md": "---\nmoc: true\n---\n[[局部性]]",
    "CSAPP/第9章/9.6 地址翻译/多级页表.md": "正文",
    "CSAPP/第6章/缓存.md": "---\nid: cache001\nkeep: true\n---\n正文",
    "hot100/局部性.md": "---\nsummary: 最近用过的很快会再用\n---\n正文",
    "论文/注意力.md": "---\nsummary: 不该出现在 CSAPP 的地图里\n---\n正文",
    ".repa/log.jsonl": [
      line({ id: "q1", t: "2026-11-20T10:00:00+08:00", kind: "quiz", card: "cache001", questions: [{ text: "题" }], answers: ["答"] }),
      line({ id: "g1", t: "2026-11-20T10:01:00+08:00", kind: "grade", quiz: "q1", result: "pass", note: "对" }),
      line({ id: "q2", t: "2026-11-25T10:00:00+08:00", kind: "quiz", folder: "CSAPP/第9章", questions: [{ text: "多级页表为什么省空间？" }], answers: ["不知道"] }),
      line({ id: "g2", t: "2026-11-25T10:01:00+08:00", kind: "grade", quiz: "q2", result: "partial", note: "漏了省空间的原因" }),
    ].join(""),
  });
  const state = await loadState(root, new Date("2026-11-26T10:00:00+08:00"));
  const { map, review } = buildMap(state, "CSAPP/第9章");
  assert.equal(map, [
    "【位置】知识库 / CSAPP / 第9章（上层：CSAPP 4 张；知识库 6 张）",
    "【这一层】2 张卡片",
    "- 页表：把虚拟页映射到物理页的表",
    "- TLB：页表项的缓存",
    "【专题地图页列进来的】",
    "- 存储层次 → 局部性（hot100）：最近用过的很快会再用",
    "【先修】",
    "- 缓存（CSAPP/第6章）：快忘了",
    "【下一层】9.6 地址翻译（1 张）",
    "【知识库的顶层】论文 1 · CSAPP 4 · hot100 1",
  ].join("\n"));
  assert.equal(review, "【最近没答好的练习】\n- 11-25 （不属于卡片）多级页表为什么省空间？，部分对：漏了省空间的原因");
  // 到期的复习按这一层及以下统计：缓存在第 6 章，不出现在第 9 章，但出现在 CSAPP。
  assert.match(buildMap(state, "CSAPP").review, /【到期的复习】缓存（逾期 \d+ 天）/u);
});

test("这一层超过 40 张卡片时只列最近改过的 40 张，并写明总数", async (t) => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 45; index += 1) files[`多/卡${index}.md`] = "正文";
  const root = await kb(t, files);
  const { map } = buildMap(await loadState(root), "多");
  assert.match(map, /【这一层】45 张卡片，下面是最近改过的 40 张/u);
  assert.equal(map.split("\n").filter((item) => item.startsWith("- 卡")).length, 40);
});
