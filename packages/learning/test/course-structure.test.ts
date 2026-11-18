import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { Host } from "@repa/base/plugin";
import { CourseIndex, needsModel } from "../src/course-index.js";
import { loadCourseSources } from "../src/course-sources.js";
import { courseStructure, StructureIndex } from "../src/course-structure.js";

const PYTHON = fileURLToPath(new URL("../courses/python/", import.meta.url));
// 随包课程只从目录读，用不到宿主的文件接口。
const resolved = await loadCourseSources([{ kind: "bundled", directory: PYTHON }], {} as Host["files"]);

test("随包课程的结构写成 JSON 再读回，建出的查找表与学生模型的图和原来相同", () => {
  const data = courseStructure(resolved);
  const direct = new StructureIndex(data);
  const restored = new StructureIndex(JSON.parse(JSON.stringify(data)) as typeof data);
  assert.deepEqual(restored.data, data);
  assert.deepEqual(restored.topics, direct.topics);
  assert.deepEqual(restored.questions, direct.questions);
  assert.deepEqual(restored.quizTopics, direct.quizTopics);
  assert.deepEqual(restored.graph, direct.graph);
});

test("结构给出的题目归属、题池、开放题与课程内容一致，测验 topic 是有测验题的 topic", () => {
  const content = new CourseIndex(resolved);
  const structure = new StructureIndex(courseStructure(resolved));
  assert.equal(structure.questions.size, content.questions.size);
  for (const [id, entry] of content.questions) {
    assert.deepEqual(structure.questions.get(id), {
      topicId: entry.topic.id, kpId: entry.kp.id, pool: entry.pool, open: entry.pool === "practice" && needsModel(entry.question),
    });
  }
  const quiz = new Set([...content.questions.values()].filter((entry) => entry.pool === "quiz").map((entry) => entry.topic.id));
  assert.deepEqual(structure.quizTopics, quiz);
  assert.deepEqual(structure.order.map((topic) => topic.id), resolved.topics.map((topic) => topic.id));
});
