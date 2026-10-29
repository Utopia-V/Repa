import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { applyExceptions, CHECK_NAMES, runChecks, type CheckName } from "./checks.js";
import { charCount, inScope, Repository, readSettings, type Settings } from "./context.js";

const fixtureRoot = path.resolve(import.meta.dirname, "fixtures");
const projectRoot = path.resolve(import.meta.dirname, "../..");

function settings(): Settings {
  return { exclusions: [], budgets: [], bannedTerms: [], exceptions: {} };
}

async function fixture(t: TestContext, files: Record<string, string>): Promise<Repository> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-docs-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, input] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await cp(path.join(fixtureRoot, input), path.join(root, file));
  }
  return new Repository(root, Object.keys(files));
}

async function check(repo: Repository, name: CheckName, config = settings()) {
  return (await runChecks(repo, config)).filter((issue) => issue.check === name);
}

const linkTargets = {
  "docs/target.md": "links/target.md",
  "docs/target file(1).md": "links/target.md",
  "docs/image.svg": "links/image.svg",
};

test("链接解析标题、重复标题、显式锚点、引用、图片和 GFM 表格，跳过代码与外部链接", async (t) => {
  const repo = await fixture(t, { "docs/input.md": "links/pass.md", ...linkTargets });
  assert.deepEqual(await check(repo, "链接"), []);
});

test("断链、缺失图片、错误锚点和引用目标报告原文行号", async (t) => {
  const repo = await fixture(t, { "docs/input.md": "links/fail.md", ...linkTargets });
  const issues = await check(repo, "链接");
  assert.deepEqual(issues.map((issue) => issue.line), [3, 5, 7, 11]);
});

const pathTargets = {
  "packages/demo/src/existing.ts": "paths/pass.ts",
  "apps/demo/src/existing.ts": "paths/pass.ts",
  "docs/existing.md": "budgets/pass.md",
  ".agents/existing.md": "budgets/pass.md",
  "scripts/existing.ts": "paths/pass.ts",
};

test("仓库路径允许行号、锚点和占位符，注释解析不把字符串当注释", async (t) => {
  const repo = await fixture(t, { "README.md": "paths/pass.md", ...pathTargets });
  assert.deepEqual(await check(repo, "路径"), []);
});

test("五类缺失仓库路径及两个源码目录的注释路径都会报错", async (t) => {
  const repo = await fixture(t, {
    "README.md": "paths/fail.md",
    "packages/demo/src/index.ts": "paths/fail.ts",
    "apps/demo/src/index.ts": "paths/fail.ts",
  });
  const issues = await check(repo, "路径");
  assert.equal(issues.length, 9);
  assert.deepEqual(issues.filter((issue) => issue.file.endsWith(".ts")).map((issue) => issue.line), [1, 2, 1, 2]);
});

test("设计记录中的旧路径跳过，源码正文不会被当作路径注释", async (t) => {
  const repo = await fixture(t, {
    ".agents/notes/proposed/process/2026-10-30-paths.md": "paths/fail.md",
    "packages/demo/src/index.ts": "paths/pass.ts",
    "docs/existing.md": "budgets/pass.md",
    ".agents/existing.md": "budgets/pass.md",
  });
  assert.deepEqual(await check(repo, "路径"), []);
});

for (const [name, directory, failureCount] of [
  ["不写提交哈希", "hashes", 2],
  ["一段一行", "paragraphs", 3],
] as const) {
  test(`${name}的通过夹具不报错`, async (t) => {
    const repo = await fixture(t, { "README.md": `${directory}/pass.md` });
    assert.deepEqual(await check(repo, name), []);
  });
  test(`${name}的失败夹具指出全部问题`, async (t) => {
    const repo = await fixture(t, { "README.md": `${directory}/fail.md` });
    assert.equal((await check(repo, name)).length, failureCount);
  });
}

test("篇幅按非空白 Unicode 字符计数，等于上限时通过", async (t) => {
  const repo = await fixture(t, { "AGENTS.md": "budgets/pass.md" });
  const config = settings();
  config.budgets = [{ path: "AGENTS.md", maxChars: 6, reason: "夹具上限" }];
  assert.equal(charCount("# 规则\n\n短文。\n"), 6);
  assert.equal(charCount("a 😀\n中"), 3);
  assert.deepEqual(await check(repo, "篇幅上限", config), []);
});

test("篇幅超限报指定处置说明，缺少预算也会报错", async (t) => {
  const repo = await fixture(t, { "AGENTS.md": "budgets/fail.md" });
  const config = settings();
  config.budgets = [{ path: "AGENTS.md", maxChars: 6, reason: "夹具上限" }];
  assert.match((await check(repo, "篇幅上限", config))[0]?.message ?? "", /先把内容挪到它该在的地方，再压缩，最后才提上限并写明理由/);
  assert.equal((await check(repo, "篇幅上限")).length, 1);
});

for (const success of [true, false]) {
  test(`停用词在文档、包与应用的 TS 和 Svelte 中${success ? "放行新词" : "忽略大小写报错"}`, async (t) => {
    const kind = success ? "pass" : "fail";
    const repo = await fixture(t, {
      "README.md": `banned/${kind}.md`,
      "packages/demo/src/index.ts": `banned/${kind}.ts`,
      "packages/demo/src/view.svelte": `banned/${kind}.svelte`,
      "apps/demo/src/index.ts": `banned/${kind}.ts`,
      "apps/demo/src/view.svelte": `banned/${kind}.svelte`,
    });
    const config = settings();
    config.bannedTerms = [{ term: "old-name", replacement: "current-name", reason: "统一名称" }];
    assert.equal((await check(repo, "停用词", config)).length, success ? 0 : 5);
    assert.deepEqual(await check(repo, "停用词"), []);
  });
}

test("包 README 支持中间增加接口节和无模型注入说明", async (t) => {
  const repo = await fixture(t, { "packages/demo/README.md": "readmes/pass.md" });
  assert.deepEqual(await check(repo, "包 README 骨架"), []);
});

test("README 骨架顺序错误、缺少模型影响和限制时分别报错，应用 README 不查", async (t) => {
  const repo = await fixture(t, {
    "packages/demo/README.md": "readmes/fail.md",
    "apps/demo/README.md": "readmes/fail.md",
  });
  const issues = await check(repo, "包 README 骨架");
  assert.equal(issues.length, 3);
  assert.ok(issues.every((issue) => issue.file === "packages/demo/README.md"));
});

test("README 校验概述长度、token 和缓存说明，允许目前没有加理由", async (t) => {
  const repo = await fixture(t, { "packages/demo/README.md": "readmes/pass.md" });
  const original = await repo.text("packages/demo/README.md");
  const content = original.replace("无：只在宿主内保存数据，不注入模型上下文。", "模型看到固定工具声明，约 100 token；提示缓存前缀保持稳定。")
    .replace("- 多进程写入暂缓。", "目前没有：包只封装已稳定的纯计算入口。");
  await writeFile(path.join(repo.root, "packages/demo/README.md"), content);
  assert.deepEqual(await check(new Repository(repo.root, repo.files), "包 README 骨架"), []);
  await writeFile(path.join(repo.root, "packages/demo/README.md"), content.replace("保存示例。", "长".repeat(121)));
  assert.equal((await check(new Repository(repo.root, repo.files), "包 README 骨架")).length, 1);
});

const notePath = ".agents/notes/proposed/process/2026-10-30-example.md";

test("提案夹具满足路径、状态和固定小节", async (t) => {
  const repo = await fixture(t, { [notePath]: "notes/pass.md" });
  assert.deepEqual(await check(repo, "设计记录格式"), []);
});

test("提案状态错误、首节错误和缺少小节分别报告", async (t) => {
  const repo = await fixture(t, { [notePath]: "notes/fail.md" });
  assert.equal((await check(repo, "设计记录格式")).length, 5);
});

test("设计记录拒绝索引和不规范文件名，根 README 跳过", async (t) => {
  const repo = await fixture(t, {
    ".agents/notes/README.md": "notes/fail.md",
    ".agents/notes/proposed/README.md": "notes/pass.md",
    ".agents/notes/proposed/process/2026-10-30-Topic.md": "notes/pass.md",
  });
  const issues = await check(repo, "设计记录格式");
  assert.equal(issues.filter((issue) => issue.message.startsWith("路径须为")).length, 2);
  assert.ok(issues.every((issue) => issue.file !== ".agents/notes/README.md"));
});

test("已落地和已否决的记录各按自己的状态与章节检查", async (t) => {
  const repo = await fixture(t, {});
  const implemented = ".agents/notes/implemented/data/2026-10-30-example.md";
  const rejected = ".agents/notes/rejected/feature/2026-10-30-example.md";
  for (const [file, text] of [
    [implemented, "# 决定\n\n状态：已落地\n\n## 问题\n\n## 决定\n\n## 考虑过的其他做法\n\n## 影响\n"],
    [rejected, "# 决定\n\n状态：已否决：代价过高\n\n## 问题\n"],
  ]) {
    if (!file || !text) throw new Error("夹具缺少路径或正文");
    await mkdir(path.dirname(path.join(repo.root, file)), { recursive: true });
    await writeFile(path.join(repo.root, file), text);
  }
  assert.deepEqual(await check(new Repository(repo.root, [implemented, rejected]), "设计记录格式"), []);
  await writeFile(path.join(repo.root, rejected), "# 决定\n\n状态：已否决：\n\n## 问题\n");
  assert.equal((await check(new Repository(repo.root, [rejected]), "设计记录格式")).length, 1);
});

test("有效例外只豁免同一文件的指定检查，修好后报告例外已过时", async (t) => {
  const repo = await fixture(t, { "README.md": "hashes/fail.md" });
  const config = settings();
  config.exceptions = { 不写提交哈希: { "README.md": "夹具中的历史引用" } };
  assert.deepEqual(applyExceptions(await runChecks(repo, config), config, repo.files), []);
  const fixed = await fixture(t, { "README.md": "hashes/pass.md" });
  const issues = applyExceptions(await runChecks(fixed, config), config, fixed.files);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.message, "例外已过时，请删掉这条");
  const unrelated = { file: "README.md", line: 2, check: "链接", message: "目标不存在" };
  assert.ok(applyExceptions([unrelated], config, repo.files).includes(unrelated));
});

test("删除文件、排除文件和失效检查名的例外都会过时", () => {
  const config = settings();
  config.exceptions = { 链接: { "gone.md": "已删除", "excluded.md": "已排除" }, 旧检查: { "README.md": "旧规则" } };
  assert.equal(applyExceptions([], config, ["excluded.md", "README.md"]).length, 3);
});

test("排除清单覆盖隐藏目录，Repa Skill 重新纳入且第三方参考仍排除", async () => {
  const config = await readSettings(new Repository(projectRoot, []));
  for (const file of [
    "docs/research/frozen.md", "docs/adr/old.md", ".agents/skills/third-party/SKILL.md",
    ".agents/skills/repa-docs-style/references/ruanyifeng/SOURCE.md",
    "apps/web/src/components/ui/README.md", "scripts/docs/fixtures/links/fail.md",
  ]) assert.equal(inScope(file, config.exclusions), false, file);
  for (const file of [
    ".agents/skills/repa-docs-style/SKILL.md", ".agents/skills/repa-code-style/SKILL.md", "docs/development/README.md",
  ]) assert.equal(inScope(file, config.exclusions), true, file);
});

test("入口只查 git 跟踪文件，失败非零并输出文件行号，修复后退出成功", async (t) => {
  const repo = await fixture(t, { "README.md": "hashes/fail.md", "untracked.md": "links/fail.md" });
  await cp(import.meta.dirname, path.join(repo.root, "scripts/docs"), { recursive: true, filter: (source) => !source.includes("fixtures") });
  await symlink(path.join(projectRoot, "node_modules"), path.join(repo.root, "node_modules"), "dir");
  execFileSync("git", ["init", "--quiet"], { cwd: repo.root });
  execFileSync("git", ["add", "README.md"], { cwd: repo.root });
  await writeFile(path.join(repo.root, "scripts/docs/exceptions.json"), "{}\n");
  const invoke = () => spawnSync(process.execPath, ["--import", "tsx", path.join(repo.root, "scripts/docs/check.ts")], {
    cwd: projectRoot, encoding: "utf8",
  });
  const failure = invoke();
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /README.md:3 不写提交哈希 /);
  assert.doesNotMatch(failure.stderr, /untracked/);
  await cp(path.join(fixtureRoot, "hashes/pass.md"), path.join(repo.root, "README.md"));
  const success = invoke();
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /文档检查全部通过/);
  assert.equal(CHECK_NAMES.length, 11);
});

test("HTML 的 data-id 不冒充 id，目录锚点作为链接问题报告", async (t) => {
  const repo = await fixture(t, {});
  await mkdir(path.join(repo.root, "docs"));
  await writeFile(path.join(repo.root, "README.md"), "# 链接\n\n[伪锚点](docs/target.md#fake)、[目录](docs/#anchor)。\n");
  await writeFile(path.join(repo.root, "docs/target.md"), "<a data-id=\"fake\" title=\"id='fake'\"></a>\n");
  const issues = await check(new Repository(repo.root, ["README.md", "docs/target.md"]), "链接");
  assert.equal(issues.length, 2);
  assert.match(issues[0]?.message ?? "", /锚点不存在/);
  assert.match(issues[1]?.message ?? "", /锚点目标应为文件/);
});

test("被删除但尚未暂存的文件不读取，引用它的文档仍指出断链", async (t) => {
  const repo = await fixture(t, { "README.md": "links/fail.md", "target.md": "links/target.md" });
  execFileSync("git", ["init", "--quiet"], { cwd: repo.root });
  execFileSync("git", ["add", "."], { cwd: repo.root });
  await rm(path.join(repo.root, "target.md"));
  const tracked = Repository.tracked(repo.root);
  assert.deepEqual(tracked.files, ["README.md"]);
  assert.ok((await check(tracked, "链接")).some((issue) => issue.message.includes("target.md")));
});

test("持久格式记录的前两行是元数据，其余正文仍按一段一行检查", async (t) => {
  const repo = await fixture(t, { "docs/persistence/changes/2026-10-30-fields.md": "paragraphs/persistence.md" });
  assert.deepEqual((await check(repo, "一段一行")).map((issue) => issue.line), [4]);
});
