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

test("对话只读到知识库之内这个文件夹和上级文件夹的 AGENTS.md；系统提示是学习助手；正在看的卡片附在消息里而不显示；AGENTS.md 改了下一条消息起生效", async (t) => {
  const server = await backend(t, {
    "AGENTS.md": "对所有学习的要求",
    "CSAPP/AGENTS.md": "CSAPP 的要求",
    "CSAPP/虚拟内存.md": "---\nsummary: 让进程以为独占地址空间\n---\n正文",
    "论文/AGENTS.md": "兄弟文件夹的要求",
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
  assert.doesNotMatch(context, /兄弟文件夹|外层|Pi 全局/u);
  assert.match(first.sections.repa_map ?? "", /- 虚拟内存：让进程以为独占地址空间/u);
  assert.match(first.sections.repa_mode ?? "", /当前模式：学习/u);
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
  // 开放题带一个空的 options，是 DeepSeek 实际给过的写法。
  server.script({ tool: "quiz", id: "call_quiz", args: { card: "页表", questions: [{ ...questions[0], options: [] }, questions[1]] } });
  await server.api("POST", `/api/sessions/${id}/prompt`, { text: "考考我" });
  await client.until(() => client.conversation.pending.length === 1, "题目卡片");
  assert.deepEqual(client.conversation.pending[0], { kind: "quiz", questions, card: "CSAPP/页表.md", id: "call_quiz" });

  // grade 要用 quiz 返回的练习 id，它在作答交回以后才出现在模型收到的工具结果里。
  const quizIdOf = (seen: Seen) => /练习 (\w+) 的作答/u.exec(JSON.stringify(seen.messages))?.[1] ?? "";
  server.script({ tool: "grade", id: "call_grade", args: (seen) => ({ quiz: quizIdOf(seen), result: "partial", note: "漏了省空间的原因" }) }, { text: "部分正确" });
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

  server.script(
    { tool: "read", id: "call_read", args: { path: "页表.md" } },
    { tool: "write", id: "call_rewrite", args: { path: "页表.md", content: "---\nsummary: 页表\n---\n整篇改写的正文\n" } },
    { text: "改好了" },
  );
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

test("纳入复习的卡片出现在今日；点复习新开一段复习对话，卡片和以前的练习附在第一条消息里，模式是复习；回到这个文件夹接上的仍是学习对话", async (t) => {
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
  assert.equal(review.json.mode, "复习");
  const reviewClient = await server.connect(String(review.json.id));
  await reviewClient.until(() => reviewClient.settled === 1, "复习的第一轮结束");
  const seen = server.seen.at(-1);
  assert.ok(seen);
  assert.match(lastUserText(seen), /复习「页表」/u);
  assert.match(lastUserText(seen), /页表的正文/u);
  assert.match(lastUserText(seen), /上次的题.*上次的答|上次没答好/su);
  assert.match(seen.sections.repa_mode ?? "", /当前模式：复习/u);

  const list = async (query: string) => ((await server.api("GET", `/api/sessions${query}`)).json.sessions as Array<{ id: string; kind: string }>).map((item) => [item.kind, item.id]);
  assert.deepEqual(await list("?folder=CSAPP&reviews=1"), [["review", review.json.id], ["learn", learning]]);
  assert.deepEqual(await list(""), [["learn", learning]]);
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

test("在论文那个文件夹对话时，地图里没有 CSAPP 的细节；检索能找到 CSAPP 里的卡片；重启以后接着原来的对话；对话还短时不压缩，够长时压缩后照常继续", async (t) => {
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
  assert.match(map, /【顶层的文件夹】.*CSAPP 1/u);
  const search = client.conversation.items.find((item) => item.type === "tool");
  assert.match(search?.type === "tool" ? search.output : "", /CSAPP\/注意力的局部性.md：访存的时间局部性/u);

  await server.restart();
  assert.equal(await open(server, "论文"), id);
  const other = await open(server, "CSAPP");
  const again = await server.connect(id);
  assert.deepEqual(again.conversation.items.map((item) => item.type), ["user", "tool", "assistant"]);

  // 最近约两万 token 的对话保留原样，再往前的才压成摘要，所以先再说一轮长的。
  server.script({ text: "又一轮" });
  await server.api("POST", `/api/sessions/${id}/prompt`, { text: `再看一段\n${"后来".repeat(60_000)}` });
  await again.until(() => again.settled === 1, "第二轮长消息");
  // 对话还短时 Pi 不压缩，接口照常回 200，说明没有压缩和原因。
  const early = await server.api("POST", `/api/sessions/${other}/compact`, {});
  assert.deepEqual({ status: early.status, compacted: early.json.compacted, hasReason: typeof early.json.reason === "string" }, { status: 200, compacted: false, hasReason: true });
  server.script({ text: "这是压缩后的摘要" });
  assert.deepEqual((await server.api("POST", `/api/sessions/${id}/compact`, {})).json, { compacted: true });
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
  // 记忆估计、逾期天数和下次到期取决于今天，只查类型。第 11-01 天学完，间隔 1 天，所以第二天到期。
  assert.deepEqual({ ...table, memory: typeof table?.memory, overdueDays: typeof table?.overdueDays }, {
    path: "A/页表.md", title: "页表", summary: "和 [[TLB]]、[[没有]] 一起看", moc: false, keep: true, folder: "A",
    requires: [{ target: "缓存", path: null }], links: [{ target: "TLB", path: "A/TLB.md" }, { target: "没有", path: null }],
    memory: "number", due: true, overdueDays: "number", nextDue: "2026-11-02", lastPracticed: "2026-11-01",
  });
});

test("Agent 读过卡片以后学习者在编辑器里又改了它：整篇 write 被拦下，读过当前内容以后才写入", async (t) => {
  const server = await backend(t, { "笔记.md": "第一版\n" });
  const id = await open(server, "");
  const client = await server.connect(id);
  const file = path.join(server.root, "笔记.md");
  server.script(
    { tool: "read", id: "call_read1", args: { path: "笔记.md" } },
    { tool: "write", id: "call_new", args: { path: "新卡片.md", content: "新建不用先读\n" } },
    { text: "读完了" },
  );
  await server.api("POST", `/api/sessions/${id}/prompt`, { text: "读一下" });
  await client.until(() => client.settled === 1, "读完");
  assert.equal(await readFile(path.join(server.root, "新卡片.md"), "utf8"), "新建不用先读\n");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(file, "第一版\n学习者刚写的一段。\n");
  server.script(
    { tool: "write", id: "call_stale", args: { path: "笔记.md", content: "凭旧印象重写\n" } },
    { tool: "read", id: "call_read2", args: { path: "笔记.md" } },
    { tool: "write", id: "call_fresh", args: { path: "笔记.md", content: "第一版\n学习者刚写的一段。\n补充\n" } },
    { text: "写好了" },
  );
  await server.api("POST", `/api/sessions/${id}/prompt`, { text: "重写" });
  await client.until(() => client.settled === 2, "重写结束");
  const stale = client.conversation.items.find((item) => item.type === "tool" && item.id === "call_stale");
  assert.equal(stale?.type === "tool" && stale.isError, true);
  assert.match(stale?.type === "tool" ? stale.output : "", /先用 read 读当前的内容/u);
  assert.equal(await readFile(file, "utf8"), "第一版\n学习者刚写的一段。\n补充\n");
});

test("thinking 级别由 Repa 记在 .repa/settings.json：换了以后成为新对话的默认；模型不支持时由 Pi 收窄，换回来又恢复；不写 Pi 全局目录", async (t) => {
  const server = await backend(t, {});
  const id = await open(server, "");
  const client = await server.connect(id);
  const info = () => client.conversation.session;
  assert.equal(info()?.thinking, "medium");
  assert.ok(info()?.thinkingLevels?.includes("high"));
  assert.equal((await server.api("POST", `/api/sessions/${id}/thinking`, { level: "high" })).status, 200);
  await client.until(() => info()?.thinking === "high", "换成 high");
  const settings = JSON.parse(await readFile(path.join(server.root, ".repa/settings.json"), "utf8")) as Record<string, unknown>;
  assert.equal(settings.thinking, "high");
  await server.api("POST", `/api/sessions/${id}/model`, { provider: "faux", id: "faux-plain" });
  await client.until(() => info()?.model === "faux/faux-plain", "换成不支持 thinking 的模型");
  assert.equal(info()?.thinking, "off");
  await server.api("POST", `/api/sessions/${id}/model`, { provider: "faux", id: "faux-1" });
  await client.until(() => info()?.model === "faux/faux-1", "换回来");
  assert.equal(info()?.thinking, "high");
  const fresh = await server.api("POST", "/api/sessions", { folder: "", fresh: true });
  assert.equal(fresh.json.thinking, "high");
  await assert.rejects(stat(path.join(path.dirname(server.root), "agent", "settings.json")));
});

test("今日按每天的张数给建议，今天练过的占名额；做完以后 done 为真，“再来几张”加大名额；设置里的张数、外观和键位原样存取", async (t) => {
  const today = new Date().toISOString().slice(0, 10);
  const graded = (id: string) => `${JSON.stringify({ v: 1, id: `g${id}`, t: `${today}T12:00:00+08:00`, kind: "grade", card: id, result: "pass", note: "对" })}\n`;
  const server = await backend(t, {
    "甲.md": "---\nid: aaaaaaa1\nkeep: true\n---\n正文", "乙.md": "---\nkeep: true\n---\n正文", "丙.md": "---\nkeep: true\n---\n正文", "丁.md": "---\nkeep: true\n---\n正文",
    ".repa/log.jsonl": graded("aaaaaaa1"),
  });
  const settings = await server.api("PUT", "/api/settings", { dailyLimit: 2, appearance: "dark", keys: { send: "Mod+Enter" } });
  assert.deepEqual({ dailyLimit: settings.json.dailyLimit, appearance: settings.json.appearance, keys: settings.json.keys }, { dailyLimit: 2, appearance: "dark", keys: { send: "Mod+Enter" } });
  const first = (await server.api("GET", "/api/today")).json;
  assert.deepEqual({ practiced: first.practiced, limit: first.limit, done: first.done, fresh: (first.fresh as unknown[]).length, freshTotal: first.freshTotal }, { practiced: 1, limit: 2, done: false, fresh: 1, freshTotal: 3 });
  await writeFile(path.join(server.root, ".repa/log.jsonl"), graded("aaaaaaa1") + graded("bbbbbbb2"));
  await server.api("POST", "/api/card/meta", { path: "乙.md", keep: true });
  await writeFile(path.join(server.root, "乙.md"), "---\nid: bbbbbbb2\nkeep: true\n---\n正文");
  const done = (await server.api("GET", "/api/today")).json;
  assert.deepEqual({ practiced: done.practiced, done: done.done, fresh: done.fresh }, { practiced: 2, done: true, fresh: [] });
  assert.equal(((await server.api("GET", "/api/today?extra=1")).json.fresh as unknown[]).length, 1);
  await server.api("PUT", "/api/settings", { dailyLimit: null });
  assert.equal(((await server.api("GET", "/api/today")).json.fresh as unknown[]).length, 2);
});

test("月历给出每天到期和练过的张数，给出日期时列出那天的卡片；改文件头的接口只动那一行，卡片带上下次到期的日子", async (t) => {
  const server = await backend(t, { "甲.md": "---\nsummary: 概括\n---\n正文\n" });
  await server.api("POST", "/api/card/meta", { path: "甲.md", review: "2026-12-03" });
  assert.equal(await readFile(path.join(server.root, "甲.md"), "utf8"), "---\nsummary: 概括\nreview: 2026-12-03\n---\n正文\n");
  assert.equal((await server.api("GET", `/api/card?path=${encodeURIComponent("甲.md")}`)).json.nextDue, "2026-12-03");
  const month = (await server.api("GET", "/api/calendar?month=2026-12")).json;
  const days = month.days as Array<{ date: string; due: number; practiced: number }>;
  assert.equal(days.length, 31);
  assert.deepEqual(days.find((day) => day.date === "2026-12-03"), { date: "2026-12-03", due: 1, practiced: 0 });
  const day = (await server.api("GET", "/api/calendar?date=2026-12-03")).json;
  assert.deepEqual((day.due as Array<{ path: string }>).map((item) => item.path), ["甲.md"]);
  assert.equal((await server.api("POST", "/api/card/meta", { path: "甲.md", review: "下周" })).status, 400);
  await server.api("POST", "/api/card/meta", { path: "甲.md", review: null });
  assert.equal(await readFile(path.join(server.root, "甲.md"), "utf8"), "---\nsummary: 概括\n---\n正文\n");
});

test("对话列表跨全部文件夹，可按关键词筛、按文件夹排；有题目卡片在等的对话标为正在回复、在等回应；引文随消息交给模型并显示在那条消息里，重启后还在", async (t) => {
  const server = await backend(t, { "CSAPP/页表.md": "正文", "论文/注意力.md": "正文" });
  const csapp = await open(server, "CSAPP");
  const paper = await open(server, "论文");
  const csappClient = await server.connect(csapp);
  const paperClient = await server.connect(paper);
  server.script({ text: "好" });
  await server.api("POST", `/api/sessions/${csapp}/prompt`, { text: "页表为什么要多级", viewing: "CSAPP/页表.md", quote: "页表项\n占空间" });
  await csappClient.until(() => csappClient.settled === 1, "第一段对话");
  assert.match(lastUserText(server.seen[0] ?? { sections: {}, messages: [] }), /学习者引用了这段话：\\n> 页表项\\n> 占空间/u);
  assert.deepEqual(csappClient.conversation.items[0], { type: "user", text: "页表为什么要多级", quote: "页表项\n占空间" });
  server.script({ tool: "quiz", id: "call_wait", args: { questions: [{ text: "注意力是什么？" }] } });
  await server.api("POST", `/api/sessions/${paper}/prompt`, { text: "考我注意力" });
  await paperClient.until(() => paperClient.conversation.pending.length === 1, "题目卡片在等");

  const list = async (query: string) => (await server.api("GET", `/api/sessions${query}`)).json.sessions as Array<{ id: string; folder: string; running: boolean; waiting: boolean }>;
  // 按文件夹排与文件夹树的次序相同：中文在英文之前。
  assert.deepEqual((await list("?sort=folder")).map((item) => item.folder), ["论文", "CSAPP"]);
  assert.deepEqual((await list("?q=多级")).map((item) => item.id), [csapp]);
  const waiting = (await list("")).find((item) => item.id === paper);
  assert.deepEqual({ running: waiting?.running, waiting: waiting?.waiting }, { running: true, waiting: true });
  await server.api("POST", "/api/pending/call_wait", { answers: null });

  await server.restart();
  await open(server, "CSAPP", { id: csapp });
  const again = await server.connect(csapp);
  assert.deepEqual(again.conversation.items[0], { type: "user", text: "页表为什么要多级", quote: "页表项\n占空间" });
});

test("全局的事件流推各段对话的状态：开始回复、题目卡片在等、作答以后、回复结束", async (t) => {
  const server = await backend(t, {});
  const id = await open(server, "");
  const watcher = await server.watch();
  await watcher.until(() => watcher.statuses.length === 1, "连上时的当前状态");
  assert.deepEqual(watcher.statuses[0], { id, folder: "", kind: "learn", running: false, waiting: false });
  server.script({ tool: "quiz", id: "call_q", args: { questions: [{ text: "题" }] } }, { text: "好" });
  await server.api("POST", `/api/sessions/${id}/prompt`, { text: "考我" });
  await watcher.until(() => watcher.statuses.some((status) => status.waiting), "在等作答");
  await server.api("POST", "/api/pending/call_q", { answers: ["答"] });
  await watcher.until(() => watcher.statuses.at(-1)?.running === false, "回复结束");
  assert.deepEqual(watcher.statuses.map((status) => [status.running, status.waiting]), [[false, false], [true, false], [true, true], [true, false], [false, false]]);
});

test("模式按名字读写，新建的模式也能切到；设置里带知识库的位置；文件夹的 AGENTS.md 带修改时间，被别处改过就拒绝保存", async (t) => {
  const server = await backend(t, { "CSAPP/AGENTS.md": "CSAPP 的要求\n" });
  assert.match(String((await server.api("GET", `/api/modes/${encodeURIComponent("学习")}`)).json.text), /讲完用 quiz/u);
  assert.equal((await server.api("PUT", `/api/modes/${encodeURIComponent("费曼")}`, { text: "让学习者讲给你听。\n" })).status, 200);
  assert.deepEqual((await server.api("GET", "/api/modes")).json.modes, ["复习", "学习", "整理", "费曼"].sort());
  assert.equal((await server.api("PUT", `/api/modes/${encodeURIComponent(".隐藏")}`, { text: "x" })).status, 400);
  assert.equal((await server.api("GET", `/api/modes/${encodeURIComponent("没有")}`)).status, 404);
  const id = await open(server, "CSAPP");
  const client = await server.connect(id);
  await server.api("POST", `/api/sessions/${id}/mode`, { mode: "费曼" });
  server.script({ text: "你讲讲" });
  await server.api("POST", `/api/sessions/${id}/prompt`, { text: "开始" });
  await client.until(() => client.settled === 1, "一轮结束");
  assert.match(server.seen[0]?.sections.repa_mode ?? "", /当前模式：费曼\n让学习者讲给你听。/u);

  assert.equal((await server.api("GET", "/api/settings")).json.root, server.root);
  const folder = (await server.api("GET", "/api/folder?path=CSAPP")).json.agents as { text: string; mtime: number };
  assert.equal(folder.text, "CSAPP 的要求\n");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(path.join(server.root, "CSAPP/AGENTS.md"), "编辑器里改过\n");
  assert.equal((await server.api("PUT", "/api/card", { path: "CSAPP/AGENTS.md", text: "我的新要求\n", mtime: folder.mtime })).status, 409);
  const latest = (await server.api("GET", "/api/folder?path=CSAPP")).json.agents as { mtime: number };
  assert.equal((await server.api("PUT", "/api/card", { path: "CSAPP/AGENTS.md", text: "我的新要求\n", mtime: latest.mtime })).status, 200);
});
