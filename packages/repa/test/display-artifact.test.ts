import assert from "node:assert/strict";
import test from "node:test";
import { displayResultArtifact } from "../src/display/artifact.js";
import type { DisplayResult } from "../src/display/schema.js";

test("展示结果投影只映射原空间的标准引用，不改原件、历史来源或页面参数", () => {
  const resource = { spaceId: "original", id: "a".repeat(64), mediaType: "text/html" };
  const foreign = { spaceId: "foreign", id: "b".repeat(64), mediaType: "text/plain" };
  const result: DisplayResult = {
    format: { id: "repa.display-result", version: "1" },
    value: { kind: "inline", data: {
      source: { kind: "display", hostId: "host", spaceId: "original", instanceId: "instance" },
      artifact: {
        format: { id: "repa.display-html", version: "1" }, value: { kind: "resource", resource },
        sources: [
          { target: { kind: "content", ref: { spaceId: "original", id: "content" } }, revision: "content-revision" },
          { target: { kind: "file", spaceId: "original", location: { kind: "relative", path: "question.json" } }, revision: "file-revision" },
          { target: { kind: "content", ref: { spaceId: "foreign", id: "external" } }, revision: "foreign-revision" },
        ],
        resources: [resource, foreign],
      },
      initialData: { spaceId: "original" }, input: { spaceId: "original" },
    } },
    sources: [], resources: [resource],
  };
  const before = structuredClone(result);
  const artifact = displayResultArtifact(result, "copy");
  assert.equal(artifact.value.resource.spaceId, "copy");
  assert.deepEqual(artifact.resources.map(ref => ref.spaceId), ["copy", "foreign"]);
  assert.deepEqual(artifact.sources.map(source => source.target.kind === "content"
    ? source.target.ref.spaceId : source.target.spaceId), ["copy", "copy", "foreign"]);
  assert.deepEqual(result, before);
  assert.deepEqual(displayResultArtifact(result, "original"), result.value.data.artifact);
});
