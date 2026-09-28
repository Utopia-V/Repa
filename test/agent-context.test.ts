import assert from "node:assert/strict";
import test from "node:test";
import {
  createSyntheticSourceInfo,
  estimateTokens,
  formatSkillsForPrompt,
  SessionManager,
  type BuildSystemPromptOptions,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import {
  assembleSystemPrompt,
  CONTEXT_MESSAGE_TYPE,
  contextSnapshot,
  makeContextMessage,
  projectContext,
  withModelContext,
} from "../src/agent/context.js";
import type { PromptSettings } from "../src/configuration/schema.js";
import type { ContextView } from "../src/content/schema.js";

const disabled: PromptSettings = {
  base: "",
  append: [],
  projectInstructions: false,
  skillCatalog: false,
  environment: false,
  learningContext: false,
  fileChanges: "on-demand",
};
const skill: Skill = {
  name: "learning-skill",
  description: "Inspect learning material.",
  filePath: "/skills/learning/SKILL.md",
  baseDir: "/skills/learning",
  sourceInfo: createSyntheticSourceInfo("/skills/learning/SKILL.md", {
    source: "test",
  }),
  disableModelInvocation: false,
};
const promptOptions: BuildSystemPromptOptions = {
  cwd: "/learning-space",
  customPrompt: "PI_CUSTOM_PROMPT",
  appendSystemPrompt: "PI_APPEND_PROMPT",
  selectedTools: ["read"],
  contextFiles: [
    { path: "/learning-space/AGENTS.md", content: "PROJECT_INSTRUCTIONS" },
    { path: "/learning-space/topic/AGENTS.md", content: "TOPIC_INSTRUCTIONS" },
  ],
  skills: [skill, { ...skill, name: "explicit-only", disableModelInvocation: true }],
};

function view(text: string, revision: string = text): ContextView {
  return {
    text,
    revision,
    sources: [{ ref: { spaceId: "space", id: "background" }, revision }],
  };
}

function appendContext(manager: SessionManager, snapshot: ContextView): string {
  const message = makeContextMessage(snapshot);
  assert.equal(message.role, "custom");
  return manager.appendCustomMessageEntry(
    message.customType,
    message.content,
    message.display,
    message.details,
  );
}

function appendUser(manager: SessionManager, text: string): string {
  return manager.appendMessage({ role: "user", content: text, timestamp: 1 });
}

test("基础提示与追加段由设置持有，显式空内容没有 Pi 默认回退", () => {
  assert.equal(assembleSystemPrompt(promptOptions, disabled), "");
  assert.equal(
    assembleSystemPrompt(promptOptions, {
      ...disabled,
      base: "基础提示\n",
      append: ["先追加", "", "再追加"],
    }),
    "基础提示\n\n\n先追加\n\n再追加",
  );
  assert.equal(
    assembleSystemPrompt(promptOptions, { ...disabled, append: ["只有追加"] }),
    "只有追加",
  );
});

test("项目说明、Skill 清单和环境分别受控，Skill 格式与可见性沿用 Pi", () => {
  const project = assembleSystemPrompt(promptOptions, {
    ...disabled,
    projectInstructions: true,
  });
  assert.match(project, /path="\/learning-space\/AGENTS.md"/u);
  assert(project.indexOf("PROJECT_INSTRUCTIONS") < project.indexOf("TOPIC_INSTRUCTIONS"));
  assert.doesNotMatch(project, /available_skills|Current working directory|PI_/u);

  const catalog = assembleSystemPrompt(promptOptions, { ...disabled, skillCatalog: true });
  assert.equal(catalog, formatSkillsForPrompt(promptOptions.skills!).trim());
  assert.doesNotMatch(catalog, /explicit-only|PROJECT_INSTRUCTIONS|Current working directory/u);
  assert.equal(
    assembleSystemPrompt({ ...promptOptions, selectedTools: ["write"] }, {
      ...disabled,
      skillCatalog: true,
    }),
    "",
  );
  assert.equal(
    assembleSystemPrompt(promptOptions, { ...disabled, environment: true }),
    "Current working directory: /learning-space",
  );
});

test("完整语境与来源保存在自定义消息中，空视图有效且时间不改变正文", () => {
  const original = view("  原文第一行\n第二行\n", "revision-one");
  const message = makeContextMessage(original, 10);
  assert.equal(message.role, "custom");
  assert.equal(message.customType, CONTEXT_MESSAGE_TYPE);
  assert.equal(message.display, false);
  assert.equal(message.timestamp, 10);
  assert.deepEqual(message.details, original);
  assert.match(String(message.content), /学习空间中持续维护的学习背景/u);
  assert(String(message.content).includes(original.text));
  assert(String(message.content).includes('"spaceId":"space"'));
  const later = makeContextMessage(original, 20);
  assert.equal(later.role, "custom");
  assert.equal(later.content, message.content);
  assert.deepEqual(contextSnapshot(message), original);

  const empty: ContextView = { text: "", revision: "empty", sources: [] };
  assert.deepEqual(contextSnapshot(makeContextMessage(empty, 0)), empty);
  assert.equal(contextSnapshot({ ...message, customType: "another-source" }), undefined);
  assert.equal(contextSnapshot({ ...message, details: { revision: "incomplete" } }), undefined);
  assert.equal(contextSnapshot({ ...message, content: "截断的原文" }), undefined);
});

test("正常历史保持顺序；关闭语境只过滤其自动消息并保留工具与其他自定义消息", () => {
  const manager = SessionManager.inMemory();
  appendUser(manager, "当前请求");
  appendContext(manager, view("学习背景"));
  manager.appendCustomMessageEntry("extension.notice", "其他扩展消息", true);
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "read-one", name: "read", arguments: { path: "note.md" } }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 2,
  });
  manager.appendMessage({
    role: "toolResult", toolCallId: "read-one", toolName: "read",
    content: [{ type: "text", text: "文档正文含先前背景" }], isError: false, timestamp: 3,
  });
  const messages = manager.buildSessionContext().messages;
  const entriesBefore = structuredClone(manager.getEntries());
  assert.deepEqual(projectContext(messages, manager, true), messages);
  assert.deepEqual(projectContext(messages, manager, false), [
    messages[0], ...messages.slice(2),
  ]);
  assert.deepEqual(manager.getEntries(), entriesBefore);
});

test("压缩只补回边界时最新的完整快照，位置稳定且重复投影不追加", () => {
  const manager = SessionManager.inMemory();
  appendContext(manager, view("更早背景"));
  appendUser(manager, "早期讨论");
  appendContext(manager, view("压缩时背景"));
  const snapshot = manager.buildSessionContext().messages.at(-1)!;
  const keptId = appendUser(manager, "保留的最近请求");
  appendUser(manager, "保留的补充说明");
  manager.appendCompaction("摘要中提到了旧背景", keptId, 1000);
  const entriesBefore = structuredClone(manager.getEntries());
  const messages = manager.buildSessionContext().messages;
  assert.deepEqual(messages.map((message) => message.role), ["compactionSummary", "user", "user"]);

  const projected = projectContext(messages, manager, true);
  assert.deepEqual(projected, [messages[0], snapshot, ...messages.slice(1)]);
  assert.deepEqual(projectContext(structuredClone(projected), manager, true), projected);
  assert.deepEqual(projectContext(manager.buildSessionContext().messages, manager, true), projected);
  assert.deepEqual(projectContext(projected, manager, false), messages);
  assert.deepEqual(messages, manager.buildSessionContext().messages);
  assert.deepEqual(manager.getEntries(), entriesBefore);
});

test("压缩后的新快照包括清空仍在后段生效，第二次压缩以新边界回填", () => {
  const manager = SessionManager.inMemory();
  appendContext(manager, view("旧背景"));
  const firstKept = appendUser(manager, "保留消息");
  manager.appendCompaction("第一次摘要", firstKept, 1000);
  const firstProjection = projectContext(manager.buildSessionContext().messages, manager, true);

  const empty: ContextView = { text: "", revision: "cleared", sources: [] };
  appendContext(manager, empty);
  const secondKept = appendUser(manager, "清空后的请求");
  const messages = manager.buildSessionContext().messages;
  const projected = projectContext(messages, manager, true);
  assert.deepEqual(projected.slice(0, firstProjection.length), firstProjection);
  assert.deepEqual(projected.slice(firstProjection.length), messages.slice(-2));
  assert.deepEqual(projected.flatMap((message) => contextSnapshot(message) ?? []), [view("旧背景"), empty]);
  assert.deepEqual(projectContext(projected, manager, true), projected);

  manager.appendCompaction("第二次摘要", secondKept, 1100);
  const secondProjection = projectContext(manager.buildSessionContext().messages, manager, true);
  assert.deepEqual(secondProjection.map((message) => message.role), ["compactionSummary", "custom", "user"]);
  assert.deepEqual(contextSnapshot(secondProjection[1]!), empty);
});

test("压缩时最新快照仍在保留段时沿用原位置", () => {
  const manager = SessionManager.inMemory();
  appendContext(manager, view("已退出的旧背景"));
  const keptId = appendUser(manager, "保留请求");
  appendContext(manager, view("保留的新背景"));
  manager.appendCompaction("摘要", keptId, 1000);
  const messages = manager.buildSessionContext().messages;
  assert.deepEqual(messages.map((message) => message.role), ["compactionSummary", "user", "custom"]);
  assert.deepEqual(projectContext(messages, manager, true), messages);
});

test("切分支只读取当前祖先，没有语境消息的分支与空历史不虚构快照", () => {
  const manager = SessionManager.inMemory();
  const root = appendUser(manager, "共享起点");
  appendContext(manager, view("分支 A 背景"));
  const keptA = appendUser(manager, "分支 A 请求");
  manager.appendCompaction("分支 A 摘要", keptA, 1000);
  const leafA = manager.getLeafId()!;

  manager.branch(root);
  manager.appendCustomEntry(CONTEXT_MESSAGE_TYPE, view("不进入模型的状态记录"));
  const keptB = appendUser(manager, "分支 B 请求");
  manager.appendCompaction("分支 B 摘要", keptB, 1000);
  const branchB = manager.buildSessionContext().messages;
  assert.deepEqual(projectContext(branchB, manager, true), branchB);

  // Pi 也允许 custom 消息经 appendMessage 进入普通消息条目。
  const message = makeContextMessage(view("分支 B 背景"), 5);
  assert.equal(message.role, "custom");
  manager.appendMessage(message);
  const newKeptB = appendUser(manager, "分支 B 后续请求");
  manager.appendCompaction("分支 B 后续摘要", newKeptB, 1200);
  const projectedB = projectContext(manager.buildSessionContext().messages, manager, true);
  assert.deepEqual(contextSnapshot(projectedB[1]!), view("分支 B 背景"));

  manager.branch(leafA);
  const projectedA = projectContext(manager.buildSessionContext().messages, manager, true);
  assert.deepEqual(contextSnapshot(projectedA[1]!), view("分支 A 背景"));
  manager.resetLeaf();
  assert.deepEqual(projectContext(manager.buildSessionContext().messages, manager, true), []);
});

test("模型投影保留消息来源并纳入 Pi 估算，来源开关不改写原始会话", () => {
  const manager = SessionManager.inMemory();
  const background = makeContextMessage(view("需要完整保留的背景".repeat(100)));
  const id = appendContext(manager, view("需要完整保留的背景".repeat(100)));
  const kept = appendUser(manager, "继续请求");
  manager.appendCompaction("摘要", kept, 1000);
  const raw = manager.buildSessionProjection();
  const history = structuredClone(manager.getEntries());
  let settings = { learningContext: true, fileChanges: "on-demand" as const };
  const modelSession = withModelContext(manager, () => settings);
  const projected = modelSession.buildSessionProjection();
  assert.deepEqual(projected.entries.flatMap((entry) => entry.messages), projected.messages);
  assert.equal(projected.entries[1]?.sourceEntry.id, id);
  assert.equal(projected.messages.reduce((sum, message) => sum + estimateTokens(message), 0),
    raw.messages.reduce((sum, message) => sum + estimateTokens(message), 0) + estimateTokens(background));
  assert.deepEqual(modelSession.buildSessionContext().messages, projected.messages);
  settings = { ...settings, learningContext: false };
  assert.deepEqual(modelSession.buildSessionProjection().messages, raw.messages);
  settings = { ...settings, learningContext: true };
  assert.deepEqual(modelSession.buildSessionProjection(), projected);
  assert.deepEqual(manager.getEntries(), history);
  modelSession.appendMessage({ role: "user", content: "委托写入", timestamp: 2 });
  assert.equal(manager.getLeafEntry()?.type, "message");
  assert.equal(modelSession.getSessionId(), manager.getSessionId());
});

test("压缩后的回填尊重 Pi 上下文编辑，不复活已省略或替换的完整快照", () => {
  const manager = SessionManager.inMemory();
  const snapshot = makeContextMessage(view("背景原文"));
  assert.equal(snapshot.role, "custom");
  const id = appendContext(manager, view("背景原文"));
  const kept = appendUser(manager, "保留请求");
  manager.appendCompaction("摘要", kept, 1000);
  const modelSession = withModelContext(manager, () => ({ learningContext: true, fileChanges: "on-demand" }));
  const snapshots = () => modelSession.buildSessionProjection().messages.flatMap((message) => contextSnapshot(message) ?? []);
  assert.equal(snapshots().length, 1);
  manager.appendContextEdit(id, null);
  assert.equal(snapshots().length, 0);
  manager.appendContextEdit(id, { content: snapshot.content });
  assert.equal(snapshots().length, 1);
  manager.appendContextEdit(id, { content: "经过替换的局部内容" });
  assert.equal(snapshots().length, 0);
});
