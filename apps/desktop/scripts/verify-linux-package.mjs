import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const deb = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("用法：node verify-linux-package.mjs <Repa.deb>");

function simplePdf() {
  const stream = "BT /F1 12 Tf 20 100 Td (repa-pdf-ready) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return `${pdf}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

const temporary = await mkdtemp(path.join(os.tmpdir(), "repa-deb-check-"));
let child;
let client;
let web;
let displayApp;
let displayBridge;
try {
  const installation = path.join(temporary, "installation");
  const control = path.join(temporary, "control");
  const { stdout: depends } = await exec("dpkg-deb", ["--field", deb, "Depends"]);
  assert(depends.includes("ripgrep") && depends.includes("poppler-utils") && depends.includes("apparmor"), "deb 必须声明材料工具和 AppArmor 依赖");
  await exec("dpkg-deb", ["-e", deb, control]);
  assert((await readFile(path.join(control, "postinst"), "utf8")).includes("/etc/apparmor.d/repa-desktop-linux-sandbox"));
  assert((await readFile(path.join(control, "postrm"), "utf8")).includes("/etc/apparmor.d/repa-desktop-linux-sandbox"));
  await exec("dpkg-deb", ["-x", deb, installation]);
  const installed = path.join(installation, "opt/Repa");
  const application = path.join(installed, "resources/app");
  const executable = path.join(installed, "repa");
  const cli = path.join(application, "node_modules/@repa/learning/dist/cli.js");
  const helper = path.join(application, "node_modules/repa/resources/sandbox/linux-x64/codex-linux-sandbox");
  const bwrap = path.join(application, "node_modules/repa/resources/sandbox/linux-x64/codex-resources/bwrap");
  const worker = path.join(application, "node_modules/@repa/materials/dist/parser-worker.js");
  const renderer = path.join(application, "out/renderer/index.html");
  const helperProfile = path.join(installed, "resources/helper-apparmor");
  for (const file of [executable, cli, helper, bwrap, worker, renderer, helperProfile]) await access(file);
  assert((await readFile(helperProfile, "utf8")).includes("/opt/Repa/resources/app/node_modules/repa/resources/sandbox/linux-x64/codex-linux-sandbox"));
  assert((await readFile(helperProfile, "utf8")).includes("profile repa-desktop-linux-sandbox"));
  assert((await stat(helper)).mode & 0o111, "沙箱 helper 在安装包中必须可执行");
  const textFile = path.join(temporary, "search.txt");
  const pdfFile = path.join(temporary, "sample.pdf");
  await writeFile(textFile, "repa-rg-ready\n");
  await writeFile(pdfFile, simplePdf());
  assert((await exec("rg", ["--fixed-strings", "repa-rg-ready", textFile])).stdout.includes("repa-rg-ready"));
  assert((await exec("pdfinfo", [pdfFile])).stdout.includes("Pages:           1"));
  assert((await exec("pdftotext", [pdfFile, "-"])).stdout.includes("repa-pdf-ready"));
  const environment = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    XDG_CONFIG_HOME: path.join(temporary, "config"),
    REPA_LOG_LEVEL: "info",
  };
  const { stdout: runtime } = await exec(executable, ["-e", "console.log(JSON.stringify({node:process.versions.node,sqlite:!!require('node:sqlite').DatabaseSync}))"], { env: environment });
  const runtimeInfo = JSON.parse(runtime);
  assert.equal(runtimeInfo.sqlite, true);
  assert(Number(runtimeInfo.node.split(".")[0]) >= 24);

  const connectionFile = path.join(temporary, "connection.json");
  const agentDirectory = path.join(temporary, "agent");
  const backendStartedAt = performance.now();
  child = spawn(executable, [cli, "serve", "--connection-file", connectionFile, "--agent-dir", agentDirectory, "--exit-when-detached"], {
    cwd: application,
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (message) => { errors += message; });
  const deadline = Date.now() + 15_000;
  let endpoint;
  while (!endpoint) {
    try {
      endpoint = JSON.parse(await readFile(connectionFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      assert.equal(child.exitCode, null, errors);
      assert(Date.now() < deadline, `安装包后端启动超时：${errors}`);
      await delay(25);
    }
  }
  const backendReadyMs = Math.round(performance.now() - backendStartedAt);
  assert.equal(endpoint.pid, child.pid);
  // 从 deb 解出的资源目录动态导入客户端，不能让工作区 node_modules 掩盖缺失依赖。
  const { RepaClient } = await import(new URL(`file://${application}/node_modules/repa/dist/client.js`));
  client = await RepaClient.connect(endpoint);
  const space = await client.call("space.open", { path: path.join(temporary, "space") });
  const applicationScope = { kind: "application" };
  const spacesSettings = await client.call("settings.get", { scope: applicationScope, namespace: "spaces" });
  const parent = spacesSettings.entries.find(entry => entry.key === "parentDirectory");
  assert(parent);
  await client.call("settings.set", {
    scope: applicationScope, namespace: "spaces", key: "parentDirectory", value: temporary, base: parent.revision,
  });
  const createdSpace = await client.call("space.create", { hint: "安装包空间进入检查" });
  assert.notEqual(createdSpace.id, space.id);
  assert((await client.call("space.browse", { path: temporary })).entries.some(entry => entry.path === createdSpace.path));
  assert((await client.call("space.recent", {})).some(entry => entry.path === createdSpace.path && entry.available));
  const scope = { kind: "space", spaceId: space.id };
  const packages = await client.call("package.list", { scope });
  assert.equal(packages.length, 5);
  assert(packages.every((item) => item.status === "ready" && item.installedPath.startsWith(application)));
  const described = await client.call("capability.describe", { scope });
  assert.deepEqual(described.issues, []);
  for (const id of ["repa.context.get", "repa.material.extract", "repa.planning.check", "repa.review.create"]) {
    assert(described.capabilities.some((item) => item.contract.id === id), id);
  }
  const status = await readFile(`/proc/${endpoint.pid}/status`, "utf8");
  const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status);
  assert(rss, "无法取得默认能力初始化后的后端 RSS");
  const backendRssAfterCapabilitiesKiB = Number(rss[1]);
  const session = await client.call("session.create", { spaceId: space.id });
  const preview = await client.call("prompts.preview", { spaceId: space.id, sessionId: session.sessionId });
  for (const name of ["learn-with-feedback", "plan-learning", "organize-learning"]) assert(preview.prompt.system.includes(name));
  const created = await client.call("capability.invoke", { scope, requestId: randomUUID(), contract: { id: "repa.review.create", version: "1" }, input: { operationId: randomUUID(), prompt: "安装布局复习检查" } });
  assert.equal(created.kind, "inline");
  assert.equal(created.result.item.prompt, "安装布局复习检查");
  const retrieved = await client.call("capability.invoke", { scope, requestId: randomUUID(), contract: { id: "repa.review.get", version: "1" }, input: { itemId: created.result.item.id } });
  assert.equal(retrieved.kind, "inline");
  assert.equal(retrieved.result.id, created.result.item.id);
  const listed = await client.call("capability.invoke", { scope, requestId: randomUUID(), contract: { id: "repa.review.list", version: "1" }, input: {} });
  assert.equal(listed.kind, "inline");
  assert(listed.result.items.some((item) => item.id === created.result.item.id));

  const html = Buffer.from(`<html><head><title>安装包材料</title></head><body><article><h1>安装包 HTML</h1><p>${"真实材料正文应在包内解析。".repeat(45)}</p></article><script>fetch('/tracking')</script><img src="/tracking"></body></html>`);
  const uploaded = await client.uploadResource(space.id, html, "text/html");
  const file = { kind: "file", spaceId: space.id, location: { kind: "relative", path: "article.html" } };
  await client.call("content.write", { target: file, operationId: randomUUID(), base: { kind: "absent" }, value: { kind: "resource", resource: uploaded.resource } });
  const associated = await client.call("content.associate", { spaceId: space.id, location: file.location, role: "material", operationId: randomUUID() });
  const ref = associated.contents[0]?.ref;
  assert(ref);
  const index = { kind: "file", spaceId: space.id, location: { kind: "relative", path: "index.md" } };
  await client.call("content.write", {
    target: index, operationId: randomUUID(), base: { kind: "absent" },
    value: { kind: "text", text: `[安装包材料](repa:material/${ref.id})\n` },
  });
  const relations = await client.call("content.relations", { spaceId: space.id, path: "index.md" });
  assert.equal(relations.truncated, false);
  assert.deepEqual(relations.unavailable, []);
  assert.equal(relations.relations.length, 1);
  assert.equal(relations.relations[0].target.kind, "local");
  assert.deepEqual(relations.relations[0].target.ref, ref);
  const completed = async (accepted) => {
    assert.equal(accepted.kind, "background");
    const deadline = Date.now() + 15_000;
    for (;;) {
      const request = await client.call("request.get", { spaceId: space.id, requestId: accepted.request.requestId });
      if (["completed", "failed", "cancelled", "interrupted"].includes(request.status)) {
        assert.equal(request.status, "completed", JSON.stringify(request));
        assert.equal(request.result?.value.kind, "inline");
        return request.result.value.data;
      }
      assert(Date.now() < deadline, `安装包材料处理超时：${JSON.stringify(request)}`);
      await delay(20);
    }
  };
  const extraction = await completed(await client.call("capability.invoke", { scope, requestId: randomUUID(),
    contract: { id: "repa.material.extract", version: "1" }, input: { target: { kind: "content", ref } } }));
  assert.equal(extraction.value.kind, "inline");
  assert.equal(extraction.value.data.status, "ready");
  assert.equal(extraction.value.data.reader.name, "readability");
  assert(extraction.value.data.segments.some((segment) => segment.text.includes("真实材料正文")));
  assert.deepEqual(Buffer.from(await (await client.resource(extraction.resources[0])).arrayBuffer()), html);

  let tracking = 0;
  web = http.createServer((request, response) => {
    if (request.url === "/start") {
      response.writeHead(302, { location: "/article.html" });
      response.end();
    } else if (request.url === "/article.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
    } else {
      tracking++;
      response.writeHead(404);
      response.end();
    }
  });
  web.listen(0, "127.0.0.1");
  await once(web, "listening");
  const address = web.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/start`;
  const fetched = await completed(await client.call("capability.invoke", { scope, requestId: randomUUID(),
    contract: { id: "repa.material.fetch", version: "1" }, input: { url } }));
  assert.equal(fetched.value.kind, "inline");
  assert.equal(fetched.value.data.source.requestedUrl, url);
  assert.equal(fetched.value.data.source.finalUrl, `http://127.0.0.1:${address.port}/article.html`);
  assert.equal(fetched.value.data.extraction.status, "ready");
  assert(fetched.value.data.extraction.segments.some((segment) => segment.text.includes("真实材料正文")));
  assert.deepEqual(Buffer.from(await (await client.resource(fetched.resources[fetched.value.data.originalResourceIndex])).arrayBuffer()), html);
  assert.equal(tracking, 0);

  const installedRequire = createRequire(path.join(application, "package.json"));
  const display = await import(pathToFileURL(path.join(application, "node_modules/repa/dist/display.js")));
  const { App } = await import(pathToFileURL(installedRequire.resolve("@modelcontextprotocol/ext-apps")));
  const { InMemoryTransport } = await import(pathToFileURL(installedRequire.resolve("@modelcontextprotocol/client")));
  const experiment = "<!doctype html><html><body>安装包固定实验</body></html>";
  await writeFile(path.join(temporary, "space/experiment.html"), experiment);
  await client.call("content.associate", { spaceId: space.id, location: { kind: "relative", path: "experiment.html" },
    role: "document", operationId: randomUUID() });
  const displayInstance = await client.call("display.open", {
    spaceId: space.id,
    instanceId: randomUUID(),
    source: { kind: "content", target: { kind: "file", spaceId: space.id, location: { kind: "relative", path: "experiment.html" } } },
    saveNewResult: { path: "result.json", inputSchema: { type: "object", properties: { amplitude: { type: "number" } }, required: ["amplitude"], additionalProperties: false } },
  });
  displayBridge = display.createDisplayBridge(client, displayInstance);
  displayApp = new App({ name: "安装包实验页", version: "1.0.0" }, {}, { autoResize: false });
  const [hostTransport, pageTransport] = InMemoryTransport.createLinkedPair();
  await displayBridge.connect(hostTransport);
  await displayApp.connect(pageTransport);
  const resources = await displayApp.listServerResources({});
  const source = resources.resources.find((item) => item.name === displayInstance.artifact.value.resource.id);
  assert(source);
  const read = await displayApp.readServerResource({ uri: source.uri });
  assert(read.contents[0] && "blob" in read.contents[0]);
  assert.equal(Buffer.from(read.contents[0].blob, "base64").toString("utf8"), experiment);
  const saveRequestId = randomUUID();
  await displayApp.callServerTool({ name: display.SAVE_NEW_RESULT, arguments: { requestId: saveRequestId, input: { amplitude: 2 } } });
  const saveDeadline = Date.now() + 15_000;
  for (;;) {
    const request = await client.call("request.get", { spaceId: space.id, requestId: saveRequestId });
    if (!["accepted", "running", "cancelling"].includes(request.status)) {
      assert.equal(request.status, "completed", JSON.stringify(request));
      break;
    }
    assert(Date.now() < saveDeadline, `安装包展示保存超时：${JSON.stringify(request)}`);
    await delay(20);
  }
  const saved = JSON.parse(await readFile(path.join(temporary, "space/result.json"), "utf8"));
  assert.equal(saved.value.data.source.instanceId, displayInstance.instanceId);
  assert.deepEqual(saved.value.data.input, { amplitude: 2 });
  assert.equal(saved.value.data.artifact.value.resource.id, displayInstance.artifact.value.resource.id);
  await client.call("display.close", { spaceId: space.id, instanceId: displayInstance.instanceId });
  await displayApp.close();
  displayApp = undefined;
  await displayBridge.close();
  displayBridge = undefined;
  await client.close();
  client = undefined;
  await once(child, "exit");
  child = undefined;
  const diagnostics = errors.split("\n").flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  assert(diagnostics.some(record => record.event === "server.started"));
  assert(diagnostics.some(record => record.event === "processing.completed" && record.requestId === saveRequestId));
  assert(!errors.includes(endpoint.token));
  const database = path.join(temporary, "space/.repa/plugins/repa-review/reviews.sqlite");
  await access(database);
  const check = path.join(application, "verify.mjs");
  await writeFile(check, `
    import assert from "node:assert/strict";
    import { spawnSync } from "node:child_process";
    import { readFile } from "node:fs/promises";
    import { DatabaseSync } from "node:sqlite";
    import { parse } from "./node_modules/@repa/materials/dist/parser.js";
    import { prepareCommand } from "./node_modules/repa/dist/execution/sandbox.js";
    const display = await import("./node_modules/repa/dist/display.js");
    assert.equal(typeof display.AppBridge, "function");
    const db = new DatabaseSync(${JSON.stringify(database)}, { readOnly: true });
    assert.equal(db.prepare("SELECT count(*) AS count FROM items").get().count, 1);
    db.close();
    const result = await parse("text", new TextEncoder().encode("安装包 worker 测试"), {}, new AbortController().signal);
    assert.equal(result.status, "ready");
    assert(result.segments.some((segment) => segment.text.includes("安装包 worker 测试")));
    const command = await prepareCommand({ command: "printf sandbox-ready", cwd: ${JSON.stringify(path.join(temporary, "space"))},
      policy: { mode: "restricted", readPaths: [], writePaths: [], network: false }, protectedPaths: [] });
    const sandbox = spawnSync(command.executable, command.args, { env: command.env, encoding: "utf8", timeout: 5000 });
    await command.cleanup?.();
    console.log(JSON.stringify({ sqlite: true, worker: true, displayBridge: true, sandbox: sandbox.status === 0 && sandbox.stdout === "sandbox-ready"
      ? { status: "ready" } : { status: "unavailable", exitCode: sandbox.status, signal: sandbox.signal,
        diagnostic: sandbox.stderr.slice(0, 1200) }, appArmorProfile: (await readFile("/proc/self/attr/current", "utf8")).trim() }));
  `);
  const { stdout: native } = await exec(executable, [check], { cwd: application, env: environment });
  console.log(JSON.stringify({ deb, installedLayout: "opt/Repa", runtime: runtimeInfo, packages: packages.length, capabilities: described.capabilities.length,
    backendReadyMs, backendRssAfterCapabilitiesKiB, ripgrep: true, poppler: true, html: true, urlMaterial: true, resource: true,
    spaceEntry: true, contentRelations: true, diagnostics: true,
    review: true, displayBridge: true, displayResource: true, displaySave: true, ...JSON.parse(native) }, null, 2));
} finally {
  await displayApp?.close();
  await displayBridge?.close();
  await client?.close();
  if (web) {
    web.closeAllConnections();
    await new Promise((resolve, reject) => web.close((error) => error ? reject(error) : resolve()));
  }
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  await rm(temporary, { recursive: true, force: true });
}
