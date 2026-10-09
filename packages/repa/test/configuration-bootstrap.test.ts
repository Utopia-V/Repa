import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore } from "../src/configuration/store.js";
import { RepaFault } from "../src/errors.js";

const fault = (error: unknown) => error instanceof RepaFault && error.code === "configuration";

test("未发布空间getForSpace与正式分层读取相同，不调用resolveSpace且不改配置原件", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repa-configuration-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appDirectory = path.join(root, "app"), directory = path.join(root, "unpublished");
  const appFile = path.join(appDirectory, "repa-settings.json"), file = path.join(directory, ".repa", "settings.json");
  await mkdir(appDirectory);
  await mkdir(path.dirname(file), { recursive: true });
  const applicationBytes = JSON.stringify({ format: "repa.settings", version: 2, namespaces: { prompts: {
    base: { revision: "app-base", value: "应用提示" }, append: { revision: "app-append", value: ["应用补充"] },
  } } });
  const spaceBytes = JSON.stringify({ format: "repa.settings", version: 2, namespaces: { prompts: {
    base: { revision: "space-base", value: "" }, environment: { revision: "space-environment", value: false },
  } } });
  await writeFile(appFile, applicationBytes); await writeFile(file, spaceBytes);
  let resolutions = 0;
  const unpublished = new ConfigStore({ appDirectory, resolveSpace() { resolutions++; throw new Error("空间尚未发布"); } });
  const published = new ConfigStore({ appDirectory, resolveSpace: () => directory });
  const before = await published.get({ kind: "space", spaceId: "unpublished" }, "prompts");
  assert.deepEqual(await unpublished.getForSpace("unpublished", directory, "prompts"), before);
  assert.equal(resolutions, 0);
  const base = before.entries.find(entry => entry.key === "base");
  assert(base);
  assert.equal(base.revision, "space-base");
  assert.equal(base.effective, "");
  assert.deepEqual(base.source, { kind: "space", spaceId: "unpublished" });
  const append = before.entries.find(entry => entry.key === "append");
  assert(append);
  assert.deepEqual(append.source, { kind: "application" });
  assert.deepEqual(append.effective, ["应用补充"]);
  assert.equal(await readFile(appFile, "utf8"), applicationBytes);
  assert.equal(await readFile(file, "utf8"), spaceBytes);
  const invalidValue = JSON.parse(spaceBytes);
  invalidValue.namespaces.prompts.base.value = null;
  for (const bytes of ["{坏JSON\n", JSON.stringify(invalidValue)]) {
    await writeFile(file, bytes);
    await assert.rejects(unpublished.getForSpace("unpublished", directory, "prompts"), fault);
    assert.equal(resolutions, 0);
    assert.equal(await readFile(file, "utf8"), bytes);
    assert.equal(await readFile(appFile, "utf8"), applicationBytes);
  }
  await writeFile(file, spaceBytes);
  const invalidApplication = JSON.parse(applicationBytes);
  invalidApplication.namespaces.prompts.append.value = "不是列表";
  for (const bytes of ["{坏应用JSON\n", JSON.stringify(invalidApplication)]) {
    await writeFile(appFile, bytes);
    await assert.rejects(unpublished.getForSpace("unpublished", directory, "prompts"), fault);
    assert.equal(resolutions, 0);
    assert.equal(await readFile(appFile, "utf8"), bytes);
    assert.equal(await readFile(file, "utf8"), spaceBytes);
  }

});
