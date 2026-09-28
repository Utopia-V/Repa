import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { RepaFault, type Run } from "../src/protocol.js";
import { RuntimeStore } from "../src/runtime-store.js";
import { readRunJournal } from "../src/run-journal.js";

function space(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "repa-journal-"));
  const directory = path.join(root, ".repa", "runtime");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "space.json"),
    JSON.stringify({ id: "journal-space" }),
  );
  const stores: RuntimeStore[] = [];
  t.after(() => {
    for (const store of stores) store.release();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    file: path.join(directory, "runs.jsonl"),
    open: () => {
      const store = new RuntimeStore(root, (error) => {
        throw error;
      });
      stores.push(store);
      return store;
    },
  };
}

// These are literal examples of the original persisted contract, not generated from today's wire schema.
const acceptedV0 = {
  id: "legacy-run",
  spaceId: "journal-space",
  sessionId: "saved-session",
  text: "保存旧请求的原文",
  createdAt: 10,
  status: "accepted",
  phase: "preparing",
};
const finishedV0 = {
  ...acceptedV0,
  status: "completed",
  phase: "idle",
  finishedAt: 20,
};
const line = (value: unknown) => JSON.stringify(value) + "\n";

test("旧版记录保留原始内容与结果，新追加记录使用独立的 v1 格式", (t) => {
  const f = space(t);
  const original = line(acceptedV0) + line(finishedV0);
  writeFileSync(f.file, original);
  const first = f.open();
  assert.deepEqual(first.runs.get("legacy-run"), finishedV0);
  assert.equal(readFileSync(f.file, "utf8"), original);
  const request: Run = {
    id: "new-run",
    spaceId: "journal-space",
    sessionId: "saved-session",
    text: "保存新请求",
    createdAt: 30,
    status: "accepted",
    phase: "preparing",
  };
  first.saveRun(request);
  first.saveRun({
    ...request,
    status: "failed",
    phase: "idle",
    finishedAt: 40,
    error: { code: "provider", message: "已记录的失败" },
  });
  first.release();
  const bytes = readFileSync(f.file, "utf8");
  assert(bytes.startsWith(original));
  const records = bytes
    .slice(original.length)
    .trimEnd()
    .split("\n")
    .map((value) => JSON.parse(value));
  assert.deepEqual(records[0], {
    format: "repa.run",
    version: 1,
    request: {
      id: "new-run",
      spaceId: "journal-space",
      sessionId: "saved-session",
      text: "保存新请求",
      createdAt: 30,
    },
  });
  assert.deepEqual(records[1].result, {
    status: "failed",
    finishedAt: 40,
    error: { code: "provider", message: "已记录的失败" },
  });
  assert(!Object.hasOwn(records[1], "phase"));
  const second = f.open();
  assert.equal(second.runs.get("legacy-run")?.status, "completed");
  assert.equal(second.runs.get("new-run")?.error?.message, "已记录的失败");
});

test("旧版未完成请求经恢复标记为中断，只清除尚未写完的末尾", (t) => {
  const f = space(t);
  const original = line(acceptedV0);
  writeFileSync(
    f.file,
    original + '{"format":"repa.run","version":1,"request":',
  );
  const store = f.open();
  const run = store.runs.get(acceptedV0.id)!;
  assert.equal(run.status, "interrupted");
  assert.equal(run.text, acceptedV0.text);
  assert.equal(run.createdAt, acceptedV0.createdAt);
  assert.equal(run.error?.code, "interrupted");
  const bytes = readFileSync(f.file, "utf8");
  assert(bytes.startsWith(original));
  const recovery = JSON.parse(bytes.slice(original.length));
  assert.equal(recovery.version, 1);
  assert.equal(recovery.result.status, "interrupted");
  assert.deepEqual(
    readRunJournal(f.file, "journal-space")[0]?.request,
    recovery.request,
  );
});

test("未知版本及完整的损坏记录会阻止恢复写入，并保留原文件", (t) => {
  const f = space(t);
  const future = { format: "repa.run", version: 99, request: { id: "future" } };
  const cases = [
    { suffix: line(future) + '{"partial":', code: "unsupported_run_format" },
    { suffix: JSON.stringify(future), code: "unsupported_run_format" },
    {
      suffix: line({
        format: "repa.run",
        version: 1,
        request: { id: "broken" },
      }),
      code: "invalid_run_record",
    },
    {
      suffix: line({ ...finishedV0, text: "同一标识下的另一份请求" }),
      code: "invalid_run_record",
    },
    { suffix: "{not-json}\n", code: "invalid_run_record" },
  ];
  for (const item of cases) {
    const bytes = line(acceptedV0) + item.suffix;
    writeFileSync(f.file, bytes);
    assert.throws(
      f.open,
      (error) => error instanceof RepaFault && error.code === item.code,
    );
    assert.equal(readFileSync(f.file, "utf8"), bytes);
  }
  writeFileSync(f.file, line(acceptedV0) + line(finishedV0));
  assert.equal(f.open().runs.get("legacy-run")?.status, "completed");
});
