import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { backend, lastUserText, type Seen } from "./fixture.js";

async function open(server: Awaited<ReturnType<typeof backend>>, folder: string, extra: Record<string, unknown> = {}) {
  const { status, json } = await server.api("POST", "/api/sessions", { folder, ...extra });
  assert.equal(status, 200, JSON.stringify(json));
  return String(json.id);
}

test("只接受来自自己页面的请求：Host 不是本机地址、Origin 是别的网页、写入不是 JSON 都拒绝", async (t) => {
  const server = await backend(t, {});
  assert.equal(await server.raw({ Origin: "http://evil.example" }), 403);
  assert.equal(await server.raw({ Host: "evil.example" }), 403);
  assert.equal(await server.raw({}), 200);
  assert.equal((await server.api("POST", "/api/folder", undefined, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await server.api("GET", "/api/tree")).status, 200);
});

test("对话只读到知识库之内这一层和上层的 AGENTS.md；系统提示是学习助手；正在看的卡片附在消息里而不显示；AGENTS.md 改了下一条消息起生效", async (t) => {
  const server = await backend(t, {
    "AGENTS.md": "对所有学习的要求",
    "CSAPP/AGENTS.md": "CSAPP 的要求",
    "CSAPP/虚拟内存.md": "---\nsummary: 让进程以为独占地址空间\n---\n正文",
    "论文/AGENTS.md": "兄弟层的要求",
  });
  const id = await open(server, "CSAPP");
  const client = await server.connect(id);
  server.script({ text: "好" });
  assert.equal((await server.api("POST", `/api/sessions/${id}/prompt`, { text: "这里第二段没看懂", viewing: "CSAPP/虚拟内存.md" })).status, 200);
  await client.until(() => client.settled === 1, "第一轮结束");
  const first = server.seen[0];
  assert.ok(first);
  assert.match(first.sections.preamble ?? "", /^你是学习者的学习助手/u);
  const context = first.sections.project_context ?? "";
  assert.match(context, /对所有学习的要求/u);
  assert.match(context, /CSAPP 的要求/u);
  assert.doesNotMatch(context, /兄弟层|外层|Pi 全局/u);
  assert.match(first.sections.repa_map ?? "", /- 虚拟内存：让进程以为独占地址空间/u);
  assert.match(first.sections.repa_mode ?? "", /当前模式：讨论学习/u);
  assert.match(lastUserText(first), /学习者正在看：CSAPP\/虚拟内存.md/u);
  assert.deepEqual(client.conversation.items.map((item) => item.type), ["user", "assistant"]);

  const shown = await server.api("GET", `/api/sessions/${id}/context`);
  assert.deepEqual(shown.json.agentsFiles, ["AGENTS.md", "CSAPP/AGENTS.md"]);
  assert.deepEqual(shown.json.attachments, ["学习者正在看：CSAPP/虚拟内存.md"]);
  assert.equal(typeof (shown.json.usage as { percent: number }).percent, "number");

  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(path.join(server.root, "CSAPP/AGENTS.md"), "CSAPP 的新要求");
  server.script({ text: "收到" });
  await server.api("POST", `/api/sessions/${id}/prompt`, { text: "继续" });
  await client.until(() => client.settled === 2, "第二轮结束");
  assert.match(server.seen[1]?.sections.project_context ?? "", /CSAPP 的新要求/u);
});

test("Agent 整理出一张卡片，学习者改写正文后它补一个例子：改动有逐行差异、可以撤回，学习者写的段落原样保留", async (t) => {
  const server = await backend(t, { "CSAPP/.keep": "" });
  const id = await open(server, "CSAPP");
  const client = await server.connect(id);
  server.script(
    { tool: "write", id: "call_new", args: { path: "页表.md", content: "---\nsummary: 把虚拟页映射到物理页的表\n---\nAgent 的第一版。\n" } },
    { text: "整理好了" },
  );
  await server.api("POST", `/api/sessions/${id}/prompt`, { text: "整理成卡片" });
  await client.until(() => client.settled === 1, "整理结束");
  const tool = client.conversation.items.find((item) => item.type === "tool");
  assert.equal(tool?.type === "tool" ? tool.change : undefined, "CSAPP/页表.md");
  const card = await server.api("GET", `/api/card?path=${encodeURIComponent("CSAPP/页表.md")}`);
  assert.equal(card.json.summary, "把虚拟页映射到物理页的表");
  const created = await server.api("GET", `/api/change?path=${encodeURIComponent("CSAPP/页表.md")}&tool=call_new`);
  assert.equal(created.json.created, true);

  const mine = "---\nsummary: 把虚拟页映射到物理页的表\n---\n我自己的话：页表记下每个虚拟页在哪。\r\n";
  assert.equal((await server.api("PUT", "/api/card", { path: "CSAPP/页表.md", text: mine, mtime: card.json.mtime })).status, 200);
  server.script(
    { tool: "edit", id: "call_example", args: { path: "页表.md", edits: [{ oldText: "在哪。\n", newText: "在哪。\n\n例子：4 KB 的页。\n" }] } },
    { text: "补好了" },
  );
  await server.api("POST", `/api/sessions/${id}/prompt`, { text: "补一个例子" });
  await client.until(() => client.settled === 2, "补例子结束");
  const file = path.join(server.root, "CSAPP/页表.md");
  // Pi 的 edit 按文件原有的换行写入，学习者用的 CRLF 不被改掉。
  const added = "\r\n例子：4 KB 的页。\r\n";
  assert.equal(await readFile(file, "utf8"), `${mine}${added}`);
  const change = await server.api("GET", `/api/change?path=${encodeURIComponent("CSAPP/页表.md")}&tool=call_example`);
  const diff = change.json.diff as Array<{ value: string; added?: boolean; removed?: boolean }>;
  assert.deepEqual(diff.filter((part) => part.added || part.removed).map((part) => [part.added ? "+" : "-", part.value]), [["+", added]]);
  const reverted = await server.api("POST", "/api/revert", { path: "CSAPP/页表.md", version: change.json.version });
  assert.equal(await readFile(file, "utf8"), mine);
  await server.api("POST", "/api/revert", { path: "CSAPP/页表.md", version: reverted.json.saved });
  assert.equal(await readFile(file, "utf8"), `${mine}${added}`);
});

test("Agent 出题：题目卡片有开放题和单选题，作答交回 Agent，判定记入练习记录并显示在卡片下面；整篇改写丢了 id 时程序写回，记录还在", async (t) => {
  const server = await backend(t, { "CSAPP/页表.md": "---\nsummary: 页表\n---\n正文\n" });
  const id = await open(server, "CSAPP");
  const client = await server.connect(id);
  const questions = [{ text: "多级页表为什么省空间？" }, { text: "TLB 缓存的是什么？", options: ["物理页", "页表项", "磁盘块"] }];
  server.script({ tool: "quiz", id: "call_quiz", args: { card: "页表", questions } });
  await server.api("POST", `/api/sessions/${id}/prompt`, { text: "考考我" });
  await client.until(() => client.conversation.pending.length === 1, "题目卡片");
  assert.deepEqual(client.conversation.pending[0], { kind: "quiz", questions, card: "CSAPP/页表.md", id: "call_quiz" });

  // grade 要用 quiz 返回的练习 id，它在作答交回以后才出现在模型收到的工具结果里。
  const quizIdOf = (seen: Seen) => /练习 (\w+) 的作答/u.exec(JSON.stringify(seen.messages))?.[1] ?? "";
  server.script({ tool: "grade", id: "call_grade", args: (seen) => ({ quiz: quizIdOf(seen), result: "partial", note: "漏了省空间的原因" }) }, { text: "部分对" });
  await server.api("POST", "/api/pending/call_quiz", { answers: ["不用的部分不分配", "页表项"] });
  await client.until(() => client.settled === 1, "判定结束");
  const quizItem = client.conversation.items.find((item) => item.type === "tool" && item.name === "quiz");
  assert.match(quizItem?.type === "tool" ? quizItem.output : "", /1\. 不用的部分不分配\n2\. 页表项/u);
  const card = await server.api("GET", `/api/card?path=${encodeURIComponent("CSAPP/页表.md")}`);
  const practices = card.json.practices as Array<Record<string, unknown>>;
  assert.equal(practices.length, 1);
  assert.deepEqual({ questions: practices[0]?.questions, answers: practices[0]?.answers, result: practices[0]?.result, note: practices[0]?.note }, {
    questions, answers: ["不用的部分不分配", "页表项"], result: "partial", note: "漏了省空间的原因",
  });
  const cardId = String(card.json.text).match(/^id: (\w+)$/mu)?.[1];
  assert.ok(cardId);

  server.script({ tool: "write", id: "call_rewrite", args: { path: "页表.md", content: "---\nsummary: 页表\n---\n整篇改写的正文\n" } }, { text: "改好了" });
  await server.api("POST", `/api/sessions/${id}/prompt`, { text: "整篇重写" });
  await client.until(() => client.settled === 2, "改写结束");
  const text = await readFile(path.join(server.root, "CSAPP/页表.md"), "utf8");
  assert.equal(text, `---\nid: ${cardId}\nsummary: 页表\n---\n整篇改写的正文\n`);
  assert.equal(((await server.api("GET", `/api/card?path=${encodeURIComponent("CSAPP/页表.md")}`)).json.practices as unknown[]).length, 1);
  assert.match(JSON.stringify(server.seen.at(-1)?.messages.at(-1)), /已恢复为/u);
});

test("题目卡片可以不答直接关掉，在输入框里直接回话也一样，交回的都是“没有作答”", async (t) => {
  const server = await backend(t, {});
  const id = await open(server, "");
  const client = await server.connect(id);
  server.script({ tool: "quiz", id: "call_q1", args: { questions: [{ text: "还没有卡片的概念？" }] } }, { text: "好" });
  await server.api("POST", `/api/sessions/${id}/prompt`, { text: "考我" });
  await client.until(() => client.conversation.pending.length === 1, "题目卡片");
  await server.api("POST", "/api/pending/call_q1", { answers: null });
  await client.until(() => client.settled === 1, "关掉以后结束");
  server.script({ tool: "quiz", id: "call_q2", args: { questions: [{ text: "再来一题" }] } }, { text: "那先讲" }, { text: "好" });
  await server.api("POST", `/api/sessions/${id}/prompt`, { text: "再考" });
  await client.until(() => client.conversation.pending.length === 1, "第二张题目卡片");
  await server.api("POST", `/api/sessions/${id}/prompt`, { text: "先别考了" });
  await client.until(() => client.settled === 2, "直接回话以后结束");
  const outputs = client.conversation.items.flatMap((item) => (item.type === "tool" ? [item.output] : []));
  assert.equal(outputs.length, 2);
  for (const output of outputs) assert.match(output, /学习者没有作答/u);
  const log = (await readFile(path.join(server.root, ".repa/log.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(log.map((entry) => [entry.kind, entry.folder, entry.answers]), [["quiz", "", null], ["quiz", "", null]]);
});

test("保持的卡片出现在首页；点复习新开一段复习对话，卡片和以前的练习附在第一条消息里，模式是抽查复习；回到这一层接上的仍是学习对话", async (t) => {
  const server = await backend(t, {
    "CSAPP/页表.md": "---\nid: pt000001\nkeep: true\n---\n页表的正文\n",
    "CSAPP/TLB.md": `---\nreview: ${new Date().toISOString().slice(0, 10)}\n---\nTLB 的正文\n`,
    ".repa/log.jsonl": `${JSON.stringify({ v: 1, id: "q0", t: "2026-11-01T10:00:00+08:00", kind: "quiz", card: "pt000001", questions: [{ text: "上次的题" }], answers: ["上次的答"] })}\n`
      + `${JSON.stringify({ v: 1, id: "g0", t: "2026-11-01T10:01:00+08:00", kind: "grade", quiz: "q0", result: "fail", note: "上次没答好" })}\n`,
  });
  const learning = await open(server, "CSAPP");
  const learningClient = await server.connect(learning);
  server.script({ text: "讨论中" });
  await server.api("POST", `/api/sessions/${learning}/prompt`, { text: "讨论" });
  await learningClient.until(() => learningClient.settled === 1, "讨论结束");

  const today = await server.api("GET", "/api/today");
  assert.deepEqual((today.json.due as Array<{ path: string }>).map((item) => item.path), ["CSAPP/TLB.md"]);
  assert.deepEqual((today.json.fresh as Array<{ path: string }>).map((item) => item.path), ["CSAPP/页表.md"]);
  assert.deepEqual(today.json.recent, ["CSAPP"]);

  server.script({ text: "第一题：页表项里有什么？" });
  const review = await server.api("POST", "/api/sessions", { review: "CSAPP/页表.md" });
  assert.equal(review.json.kind, "review");
  assert.equal(review.json.mode, "抽查复习");
  const reviewClient = await server.connect(String(review.json.id));
  await reviewClient.until(() => reviewClient.settled === 1, "复习的第一轮结束");
  const seen = server.seen.at(-1);
  assert.ok(seen);
  assert.match(lastUserText(seen), /复习「页表」/u);
  assert.match(lastUserText(seen), /页表的正文/u);
  assert.match(lastUserText(seen), /上次的题.*上次的答|上次没答好/su);
  assert.match(seen.sections.repa_mode ?? "", /抽查复习/u);

  const lists = await server.api("GET", "/api/sessions?folder=CSAPP");
  assert.deepEqual((lists.json.learn as Array<{ id: string }>).map((item) => item.id), [learning]);
  assert.deepEqual((lists.json.reviews as Array<{ id: string }>).map((item) => item.id), [review.json.id]);
  assert.equal(await open(server, "CSAPP"), learning);
  assert.deepEqual((await server.api("GET", "/api/today")).json.recent, ["CSAPP"]);
});

test("打开“运行命令先确认”以后，命令先出现确认卡片；拒绝时命令不运行，理由交回给 Agent", async (t) => {
  const server = await backend(t, {});
  await server.api("PUT", "/api/settings", { confirmCommands: true });
  const id = await open(server, "");
  const client = await server.connect(id);
  server.script({ tool: "bash", id: "call_bash", args: { command: "touch made-by-agent" } }, { text: "那换一种做法" });
  await server.api("POST", `/api/sessions/${id}/prompt`, { text: "建个文件" });
  await client.until(() => client.conversation.pending.length === 1, "确认卡片");
  assert.deepEqual(client.conversation.pending[0], { kind: "confirm", tool: "bash", target: "touch made-by-agent", id: "call_bash" });
  await server.api("POST", "/api/pending/call_bash", { approve: false, reason: "用 write 建" });
  await client.until(() => client.settled === 1, "拒绝以后结束");
  await assert.rejects(stat(path.join(server.root, "made-by-agent")));
  assert.match(JSON.stringify(server.seen.at(-1)?.messages.at(-1)), /学习者没有同意，理由是：用 write 建/u);
});

test("在论文那一层对话时，地图里没有 CSAPP 的细节；检索能找到 CSAPP 里的卡片；重启以后接着原来的对话；手动压缩后照常继续", async (t) => {
  const server = await backend(t, {
    "CSAPP/注意力的局部性.md": "---\nsummary: 访存的时间局部性\n---\n正文",
    "论文/Transformer.md": "---\nsummary: 注意力机制\n---\n正文",
  });
  const id = await open(server, "论文");
  const client = await server.connect(id);
  server.script({ tool: "kb_search", id: "call_search", args: { query: "局部性" } }, { text: "找到了" });
  // 压缩只在对话足够长时才有东西可压，所以这条消息带一大段材料。
  await server.api("POST", `/api/sessions/${id}/prompt`, { text: `和局部性有什么关系\n${"材料".repeat(60_000)}` });
  await client.until(() => client.settled === 1, "检索结束");
  const map = server.seen[0]?.sections.repa_map ?? "";
  assert.match(map, /Transformer/u);
  assert.doesNotMatch(map, /访存的时间局部性/u);
  assert.match(map, /【知识库的顶层】.*CSAPP 1/u);
  const search = client.conversation.items.find((item) => item.type === "tool");
  assert.match(search?.type === "tool" ? search.output : "", /CSAPP\/注意力的局部性.md：访存的时间局部性/u);

  await server.restart();
  assert.equal(await open(server, "论文"), id);
  const again = await server.connect(id);
  assert.deepEqual(again.conversation.items.map((item) => item.type), ["user", "tool", "assistant"]);

  // 最近约两万 token 的对话保留原样，再往前的才压成摘要，所以先再说一轮长的。
  server.script({ text: "又一轮" });
  await server.api("POST", `/api/sessions/${id}/prompt`, { text: `再看一段\n${"后来".repeat(60_000)}` });
  await again.until(() => again.settled === 1, "第二轮长消息");
  server.script({ text: "这是压缩后的摘要" });
  assert.equal((await server.api("POST", `/api/sessions/${id}/compact`, {})).status, 200);
  await again.until(() => again.conversation.items.some((item) => item.type === "compaction"), "压缩");
  server.script({ text: "接着说" });
  await server.api("POST", `/api/sessions/${id}/prompt`, { text: "继续" });
  await again.until(() => again.settled === 2, "压缩后的一轮");
  const after = JSON.stringify(server.seen.at(-1)?.messages);
  assert.match(after, /这是压缩后的摘要/u);
  assert.doesNotMatch(after, /材料材料/u);
});

test("全部卡片的元数据：路径、标题、summary、keep、先修、正文里的链接、记忆估计和是否到期", async (t) => {
  const server = await backend(t, {
    "A/页表.md": "---\nid: pt000001\nkeep: true\nrequires: [缓存]\n---\n和 [[TLB]]、[[没有]] 一起看",
    "A/TLB.md": "正文",
    ".repa/log.jsonl": `${JSON.stringify({ v: 1, id: "g0", t: "2026-11-01T10:01:00+08:00", kind: "grade", card: "pt000001", result: "pass", note: "对" })}\n`,
  });
  const cards = (await server.api("GET", "/api/cards")).json.cards as Array<Record<string, unknown>>;
  const table = cards.find((card) => card.path === "A/页表.md");
  assert.deepEqual({ ...table, memory: typeof table?.memory }, {
    path: "A/页表.md", title: "页表", summary: "和 [[TLB]]、[[没有]] 一起看", moc: false, keep: true, folder: "A",
    requires: [{ target: "缓存", path: null }], links: [{ target: "TLB", path: "A/TLB.md" }, { target: "没有", path: null }], memory: "number", due: true,
  });
});
