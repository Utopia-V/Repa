import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { applyExceptions } from "./checks.js";
import { exportComments } from "./compiler.js";
import { Repository } from "./context.js";
import { generateHostApi } from "./gen-host-api.js";
import { generatePackages } from "./gen-packages.js";
import { generateProtocol } from "./gen-protocol.js";
import { generateTools } from "./gen-tools.js";
import { canonical, checkPersistence, digest, generatePersistence, persistentSchemas } from "./gen-persistence.js";
import { checkGenerated, writeGenerated } from "./generation.js";
import { schemaTable } from "./schema-table.js";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-docs-generation-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function write(file: string, text: string) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  async function copy(file: string, source: string) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await cp(path.join(import.meta.dirname, "fixtures", source), path.join(root, file));
  }
  return { root, write, copy };
}

test("包地图按例外选择首段，目录逐字节一致时通过，缺失、代码变化或文件多一个字节时报错", async (t) => {
  const f = await fixture(t);
  await f.write("packages/demo/package.json", '{"name":"@repa/demo"}');
  await f.write("packages/legacy/package.json", '{"name":"@repa/legacy"}');
  await f.write("scripts/docs/exceptions.json", '{"包 README 骨架":{"packages/legacy/README.md":"待重写"}}');
  await f.copy("packages/demo/README.md", "generated/README.md");
  await f.copy("packages/legacy/README.md", "generated/legacy.md");
  const output = await generatePackages(f.root);
  assert.equal(output.count, 2);
  assert.match(output.text, /保存空间文件。/);
  assert.match(output.text, /读取历史状态。/);
  assert.doesNotMatch(output.text, /第二句|其余说明/);
  assert.equal((await checkGenerated(f.root, [output])).length, 1);
  await writeGenerated(f.root, output);
  assert.deepEqual(await checkGenerated(f.root, [output]), []);
  await f.write(output.file, `${output.text} `);
  assert.equal((await checkGenerated(f.root, [output]))[0]?.message, "目录过时，运行 npm run docs:gen");
  await writeGenerated(f.root, output);
  await f.write("packages/demo/README.md", "# 示例\n\n## 概述\n\n修改了包用途。\n");
  assert.equal((await checkGenerated(f.root, [await generatePackages(f.root)])).length, 1);
});

test("插件目录从 TypeScript 成员与说明生成，成员变化使盘上目录过时", async (t) => {
  const f = await fixture(t);
  await f.copy("packages/base/src/plugin.ts", "generated/plugin.ts");
  const output = await generateHostApi(f.root);
  assert.equal(output.count, 4);
  assert.match(output.text, /发出事件。/);
  await writeGenerated(f.root, output);
  assert.deepEqual(await checkGenerated(f.root, [output]), []);
  const file = "packages/base/src/plugin.ts";
  await f.write(file, (await readFile(path.join(f.root, file), "utf8")).replace("emit(value", "publish(value"));
  assert.equal((await checkGenerated(f.root, [await generateHostApi(f.root)])).length, 1);
});

test("所有 exports 入口查原声明的非空说明，命名与星号转导出不要求重复注释", async (t) => {
  const f = await fixture(t);
  for (const name of ["package.json", "index.ts", "extra.ts", "original.ts"]) {
    await f.copy(`packages/base/${name === "package.json" ? name : `src/${name}`}`, `exports/${name}`);
  }
  await f.copy("packages/external.ts", "exports/external.ts");
  const files = ["packages/base/package.json", "packages/base/src/index.ts", "packages/base/src/extra.ts", "packages/base/src/original.ts", "packages/external.ts"];
  const issues = await exportComments(new Repository(f.root, files));
  assert.deepEqual(issues.map((issue) => issue.message.split(" ")[0]).sort(), ["Empty", "MissingClass", "MissingType", "local", "missing", "secondEntry", "tagsOnly"].sort());
  assert(issues.every((issue) => issue.file.startsWith("packages/base/src/")));
  assert.equal(issues.find((issue) => issue.message.startsWith("missing "))?.line, 3);
});

test("学习包的目录级注释例外带理由生效，补齐后例外过时", () => {
  const issue = { file: "packages/learning/src/index.ts", line: 1, check: "导出说明注释", message: "缺少注释" };
  const settings = { exclusions: [], budgets: [], bannedTerms: [], exceptions: { 导出说明注释: { "packages/learning/src": "学习插件重做时补" } } };
  assert.deepEqual(applyExceptions([issue], settings, [issue.file]), []);
  assert.equal(applyExceptions([], settings, [issue.file])[0]?.message, "例外已过时，请删掉这条");
});

test("schema 字段表保留嵌套参数、结果类型、可选性和 description", () => {
  const table = schemaTable({ type: "object", properties: { items: { type: "array", items: { type: "object", properties: { text: { type: "string", description: "原样保留 | 内容" } } } }, count: { type: "integer" } }, required: ["count"] });
  assert.match(table, /\| count \| integer \| 否 \|/);
  assert.match(table, /\| items \| Array&lt;object&gt; \| 是 \|/);
  assert.match(table, /\| items\[\].text \| string \| 是 \| 原样保留 &#124; 内容 \|/);
});

test("摘要递归排序对象键但保留数组顺序", () => {
  assert.deepEqual(canonical({ z: { y: 1, a: 2 }, a: [2, 1] }), { a: [2, 1], z: { a: 2, y: 1 } });
  assert.equal(digest({ type: "object", properties: { a: { type: "string" }, b: { type: "number" } } }), digest({ properties: { b: { type: "number" }, a: { type: "string" } }, type: "object" }));
  assert.notEqual(digest({ enum: [1, 2] }), digest({ enum: [2, 1] }));
});

test("首次生成建立摘要，schema 变化须匹配 id、摘要及版本理由后才能认可", async (t) => {
  const f = await fixture(t);
  await f.copy("scripts/docs/persistence.json", "persistence/persistence.json");
  await f.copy("schema.ts", "persistence/schema.ts");
  await f.copy("changed.ts", "persistence/changed.ts");
  const baseline = await generatePersistence(f.root, true);
  await writeGenerated(f.root, baseline);
  const digestsFile = path.join(f.root, "docs/persistence/digests.json");
  const accepted = await readFile(digestsFile, "utf8");
  assert.deepEqual(await checkPersistence(f.root), []);
  const manifest = (await readFile(path.join(f.root, "scripts/docs/persistence.json"), "utf8")).replace("schema.ts#", "changed.ts#");
  await f.write("scripts/docs/persistence.json", manifest);
  const changed = (await persistentSchemas(f.root))[0];
  assert(changed);
  assert.equal((await checkPersistence(f.root)).length, 1);
  assert.match((await checkPersistence(f.root))[0]?.message ?? "", /fixture 的 schema 变了/);
  await assert.rejects(generatePersistence(f.root, true), /schema 变了/);
  assert.equal(await readFile(digestsFile, "utf8"), accepted);
  for (const record of [`other ${changed.digest}\n不升版本：可选字段。\n`, "fixture 0000000000000000\n不升版本：可选字段。\n", `fixture ${changed.digest}\n不升版本\n`]) {
    await f.write("docs/persistence/changes/2026-10-30-note.md", record);
    await assert.rejects(generatePersistence(f.root, true), /schema 变了/);
  }
  await f.write("docs/persistence/changes/2026-10-30-note.md", `fixture ${changed.digest}\n不升版本：新增可选字段，旧版本仍可正确读取。\n`);
  const output = await generatePersistence(f.root, true);
  await writeGenerated(f.root, output);
  assert.equal((JSON.parse(await readFile(digestsFile, "utf8")) as Record<string, string>).fixture, changed.digest);
  assert.deepEqual(await checkPersistence(f.root), []);
  assert.deepEqual(await checkGenerated(f.root, [output]), []);
});

test("协议目录按名称排序并列出方法参数、结果及通知，参数变化使目录过时", async (t) => {
  const f = await fixture(t);
  await f.copy("packages/base/src/protocol.ts", "generated/protocol.ts");
  const output = await generateProtocol(f.root);
  assert.equal(output.count, 3);
  assert(output.text.indexOf("方法：a.set") < output.text.indexOf("方法：z.get"));
  assert.match(output.text, /\| title \| string \| 否 \| 标题 \|/);
  assert.match(output.text, /\| note \| string \| 是 \|/);
  assert.match(output.text, /\| saved \| boolean \| 否 \| 是否保存 \|/);
  assert.match(output.text, /通知：b.changed/);
  assert(output.text.indexOf("方法：a.set") < output.text.indexOf("通知：b.changed"));
  assert(output.text.indexOf("通知：b.changed") < output.text.indexOf("方法：z.get"));
  await writeGenerated(f.root, output);
  assert.deepEqual(await checkGenerated(f.root, [output]), []);
  const changed = await fixture(t);
  await changed.write("packages/base/src/protocol.ts", (await readFile(path.join(f.root, "packages/base/src/protocol.ts"), "utf8")).replace("title:", "heading:"));
  assert.equal((await checkGenerated(f.root, [await generateProtocol(changed.root)])).length, 1);
});

test("工具目录在离线临时宿主打开学习和示例插件，包含底座实际声明且多次生成一致", async (t) => {
  const f = await fixture(t);
  const output = await generateTools();
  for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls", "ask_user", "subagent", "learning_read", "learning_search", "learning_task", "save_note"]) {
    assert(output.text.includes(`## ${name}\n`));
  }
  assert.match(output.text, /来源：learning。/);
  assert.match(output.text, /来源：notes。/);
  await writeGenerated(f.root, output);
  assert.deepEqual(await checkGenerated(f.root, [await generateTools()]), []);
});
