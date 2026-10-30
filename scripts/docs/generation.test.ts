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

async function persistenceFixture(t: TestContext) {
  const f = await fixture(t);
  await f.copy("scripts/docs/persistence.json", "persistence/persistence.json");
  await f.copy("schema.ts", "persistence/schema.ts");
  await f.copy("changed.ts", "persistence/changed.ts");
  const schema = (await persistentSchemas(f.root))[0];
  assert(schema);
  const basis = "2026-10-29-initial.md";
  await f.write(`docs/persistence/changes/${basis}`, `fixture ${schema.digest}\n不升版本：测试格式的初始记录。\n`);
  await f.write("docs/persistence/digests.json", `${JSON.stringify({ fixture: { digest: schema.digest, basis } }, null, 2)}\n`);
  return { ...f, schema, basis, digestsFile: path.join(f.root, "docs/persistence/digests.json") };
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

test("schema 字段表只展开两层，更深的对象指向 schema 名或源码，联合只占一行，根对象不单列", () => {
  const deep = { deep: { type: "string" } };
  const table = schemaTable({
    type: "object",
    required: ["count", "kind"],
    properties: {
      count: { type: "integer" },
      kind: { anyOf: [{ const: "a" }, { const: "b" }], description: "类别" },
      items: {
        type: "array",
        description: "条目",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "原样保留 | 内容" },
            meta: { type: "object", properties: deep },
            named: { type: "object", $id: "Named", properties: deep },
            titled: { type: "object", title: "Titled", properties: deep },
          },
        },
      },
      value: { anyOf: [{ type: "object", properties: deep }, { type: "null" }] },
    },
  });
  assert.deepEqual(table.split("\n").slice(2), [
    "| count | integer | 否 |  |",
    "| items[] | object | 是 | 条目 |",
    "| items[].meta | object | 是 | 嵌套对象，字段见源码 |",
    "| items[].named | object | 是 | 字段见 Named |",
    "| items[].text | string | 是 | 原样保留 &#124; 内容 |",
    "| items[].titled | object | 是 | 字段见 Titled |",
    "| kind | \"a\" &#124; \"b\" | 否 | 类别 |",
    "| value | object &#124; null | 是 | 嵌套对象，字段见源码 |",
  ]);
});

test("根是对象数组时字段写成 $[].a，根是联合、null 或标量数组时用一行写出类型", () => {
  const rows = (schema: object) => schemaTable(schema).split("\n").slice(2);
  assert.deepEqual(rows({ type: "array", items: { type: "object", properties: { id: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["id"] } }), [
    "| $[].id | string | 否 |  |",
    "| $[].tags[] | string | 是 |  |",
  ]);
  assert.deepEqual(rows({ anyOf: [{ type: "object", properties: { id: { type: "string" } } }, { type: "null" }] }), ["| $ | object &#124; null | 否 | 嵌套对象，字段见源码 |"]);
  assert.deepEqual(rows({ type: "null" }), ["| $ | null | 否 |  |"]);
  assert.deepEqual(rows({ type: "array", items: { type: "string" } }), ["| $[] | string | 否 |  |"]);
  assert.deepEqual(rows({ type: "object", properties: {} }), []);
});

test("摘要递归排序对象键但保留数组顺序", () => {
  assert.deepEqual(canonical({ z: { y: 1, a: 2 }, a: [2, 1] }), { a: [2, 1], z: { a: 2, y: 1 } });
  assert.equal(digest({ type: "object", properties: { a: { type: "string" }, b: { type: "number" } } }), digest({ properties: { b: { type: "number" }, a: { type: "string" } }, type: "object" }));
  assert.notEqual(digest({ enum: [1, 2] }), digest({ enum: [2, 1] }));
});

test("schema 变化须匹配 id、摘要及版本理由后才能认可，并保存记录文件名", async (t) => {
  const f = await persistenceFixture(t);
  const accepted = await readFile(f.digestsFile, "utf8");
  assert.deepEqual(await checkPersistence(f.root), []);
  const manifest = (await readFile(path.join(f.root, "scripts/docs/persistence.json"), "utf8")).replace("schema.ts#", "changed.ts#");
  await f.write("scripts/docs/persistence.json", manifest);
  const changed = (await persistentSchemas(f.root))[0];
  assert(changed);
  assert.equal((await checkPersistence(f.root)).length, 1);
  assert.match((await checkPersistence(f.root))[0]?.message ?? "", /fixture 的 schema 变了/);
  await assert.rejects(generatePersistence(f.root, true), /schema 变了/);
  assert.equal(await readFile(f.digestsFile, "utf8"), accepted);
  for (const record of [`other ${changed.digest}\n不升版本：可选字段。\n`, "fixture 0000000000000000\n不升版本：可选字段。\n", `fixture ${changed.digest}\n不升版本\n`]) {
    await f.write("docs/persistence/changes/2026-10-30-note.md", record);
    await assert.rejects(generatePersistence(f.root, true), /schema 变了/);
  }
  await f.write("docs/persistence/changes/2026-10-30-note.md", `fixture ${changed.digest}\n不升版本：新增可选字段，旧版本仍可正确读取。\n`);
  const output = await generatePersistence(f.root, true);
  await writeGenerated(f.root, output);
  assert.deepEqual(JSON.parse(await readFile(f.digestsFile, "utf8")), {
    fixture: { digest: changed.digest, basis: "2026-10-30-note.md" },
  });
  assert.deepEqual(await checkPersistence(f.root), []);
  assert.deepEqual(await checkGenerated(f.root, [output]), []);
  await generatePersistence(f.root, true);
  assert.deepEqual(await checkPersistence(f.root), []);
});

test("摘要认可的记录缺失、首行不匹配或理由缺失时报错，恢复原记录后通过", async (t) => {
  const f = await persistenceFixture(t);
  const recordFile = path.join(f.root, "docs/persistence/changes", f.basis);
  const original = await readFile(recordFile, "utf8");
  const accepted = await readFile(f.digestsFile, "utf8");
  assert.deepEqual(await checkPersistence(f.root), []);
  await rm(recordFile);
  assert.match((await checkPersistence(f.root))[0]?.message ?? "", /依据.*不存在或无效/);
  await assert.rejects(generatePersistence(f.root, true), /依据.*不存在或无效/);
  for (const record of [
    `other ${f.schema.digest}\n不升版本：测试。\n`,
    "fixture 0000000000000000\n不升版本：测试。\n",
    `fixture ${f.schema.digest} \n不升版本：测试。\n`,
    `fixture ${f.schema.digest}\n不升版本\n`,
  ]) {
    await writeFile(recordFile, record);
    assert.equal((await checkPersistence(f.root)).length, 1);
    await assert.rejects(generatePersistence(f.root, true), /依据.*不存在或无效/);
  }
  assert.equal(await readFile(f.digestsFile, "utf8"), accepted);
  await writeFile(recordFile, original);
  assert.deepEqual(await checkPersistence(f.root), []);
});

test("手改摘要使其匹配新 schema 仍不能绕过原记录", async (t) => {
  const f = await persistenceFixture(t);
  const manifest = await readFile(path.join(f.root, "scripts/docs/persistence.json"), "utf8");
  await f.write("scripts/docs/persistence.json", manifest.replace("schema.ts#", "changed.ts#"));
  const changed = (await persistentSchemas(f.root))[0];
  assert(changed);
  await f.write("docs/persistence/digests.json", JSON.stringify({ fixture: { digest: changed.digest, basis: f.basis } }));
  assert.match((await checkPersistence(f.root))[0]?.message ?? "", /依据.*不存在或无效/);
  await assert.rejects(generatePersistence(f.root, true), /依据.*不存在或无效/);
});

test("baseline 只认可现有初始格式的原摘要，手改摘要或新增 id 不能冒充基线", async (t) => {
  const f = await fixture(t);
  await f.copy("schema.ts", "persistence/baseline.ts");
  await f.copy("scripts/docs/persistence.json", "persistence/persistence.json");
  const manifest = await readFile(path.join(f.root, "scripts/docs/persistence.json"), "utf8");
  await f.write("scripts/docs/persistence.json", manifest.replace('"fixture"', '"space-format"'));
  const initial = (await persistentSchemas(f.root))[0];
  assert(initial);
  assert.equal(initial.digest, "557283bfb3e5b4a7");
  await f.write("docs/persistence/digests.json", JSON.stringify({ "space-format": { digest: initial.digest, basis: "baseline" } }));
  assert.deepEqual(await checkPersistence(f.root), []);
  await generatePersistence(f.root, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, "docs/persistence/digests.json"), "utf8")), {
    "space-format": { digest: initial.digest, basis: "baseline" },
  });
  await f.copy("changed.ts", "persistence/changed.ts");
  await f.write("scripts/docs/persistence.json", manifest.replace('"fixture"', '"space-format"').replace("schema.ts#", "changed.ts#"));
  const changed = (await persistentSchemas(f.root))[0];
  assert(changed);
  await f.write("docs/persistence/digests.json", JSON.stringify({ "space-format": { digest: changed.digest, basis: "baseline" } }));
  assert.match((await checkPersistence(f.root))[0]?.message ?? "", /baseline 须与该格式首次入库的摘要相同/);
  await assert.rejects(generatePersistence(f.root, true), /baseline/);
  await f.write("scripts/docs/persistence.json", manifest);
  await f.write("docs/persistence/digests.json", JSON.stringify({ fixture: { digest: initial.digest, basis: "baseline" } }));
  assert.match((await checkPersistence(f.root))[0]?.message ?? "", /baseline/);
  await assert.rejects(generatePersistence(f.root, true), /baseline/);
});

test("摘要文件缺失时检查和生成均提示从 git 恢复，恢复后正常运行", async (t) => {
  const f = await persistenceFixture(t);
  const accepted = await readFile(f.digestsFile, "utf8");
  await rm(f.digestsFile);
  await assert.rejects(checkPersistence(f.root), /从 git 恢复 docs\/persistence\/digests.json/);
  await assert.rejects(generatePersistence(f.root, true), /从 git 恢复 docs\/persistence\/digests.json/);
  await assert.rejects(generatePersistence(f.root), /从 git 恢复 docs\/persistence\/digests.json/);
  await assert.rejects(readFile(f.digestsFile), { code: "ENOENT" });
  await writeFile(f.digestsFile, accepted);
  await generatePersistence(f.root, true);
  assert.deepEqual(await checkPersistence(f.root), []);
  assert.equal(await readFile(f.digestsFile, "utf8"), accepted);
});

test("新增持久格式必须用记录认可，不能从空摘要清单自动建立基线", async (t) => {
  const f = await persistenceFixture(t);
  await f.write("docs/persistence/digests.json", "{}\n");
  await rm(path.join(f.root, "docs/persistence/changes", f.basis));
  assert.equal((await checkPersistence(f.root)).length, 1);
  await assert.rejects(generatePersistence(f.root, true), /schema 变了/);
  assert.equal(await readFile(f.digestsFile, "utf8"), "{}\n");
  await f.write(`docs/persistence/changes/${f.basis}`, `fixture ${f.schema.digest}\n升版本：引入独立的版本标记。\n`);
  await generatePersistence(f.root, true);
  assert.deepEqual(await checkPersistence(f.root), []);
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

test("目录超过 40 KB 时生成失败且不写文件，检查报同样的篇幅问题；按 UTF-8 字节计，正好 40 KB 通过", async (t) => {
  const f = await fixture(t);
  await f.copy("packages/base/src/protocol.ts", "generated/large-protocol.ts");
  const output = await generateProtocol(f.root);
  const size = Math.ceil(Buffer.byteLength(output.text) / 1024);
  assert(size > 40);
  const message = `生成后 ${size} KB，超过 40 KB 上限：目录要能被整篇读完，改为更紧凑的写法`;
  await assert.rejects(writeGenerated(f.root, output), { message: `docs/generated/protocol.md ${message}` });
  await assert.rejects(readFile(path.join(f.root, output.file)), { code: "ENOENT" });
  assert.deepEqual(await checkGenerated(f.root, [output]), [{ file: "docs/generated/protocol.md", line: 1, check: "生成目录", message }]);
  const exact = { file: "docs/generated/exact.md", text: "a".repeat(40 * 1024), count: 1 };
  await writeGenerated(f.root, exact);
  assert.deepEqual(await checkGenerated(f.root, [exact]), []);
  // 13654 个汉字不到 1.4 万字符，UTF-8 编码后是 40962 字节。
  const wide = { file: "docs/generated/wide.md", text: "目".repeat(13_654), count: 1 };
  assert.equal((await checkGenerated(f.root, [wide]))[0]?.message, "生成后 41 KB，超过 40 KB 上限：目录要能被整篇读完，改为更紧凑的写法");
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
