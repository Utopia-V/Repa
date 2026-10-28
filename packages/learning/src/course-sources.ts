import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { RepaFault } from "@repa/base";
import type { Host } from "@repa/base/plugin";
import { identifier, object, parse } from "@repa/base/protocol";
import { ExpectedSchema, expectedBinding, type Expected } from "./python-execution.js";
import { slotTests, topicQuestions } from "./check/items.js";
import { loadCourse } from "./format/load.js";
import { Report } from "./format/diagnostics.js";
import { TopicSchema, type Topic } from "./format/schema.js";

const OverlaySchema = object({ courseId: identifier, basedOn: identifier, topic: TopicSchema });
export type CourseSource = { kind: "bundled"; directory: string } | { kind: "overlay"; file: string };
export interface ResolvedCourse {
  course: NonNullable<Awaited<ReturnType<typeof loadCourse>>>["course"];
  topics: Topic[];
  expected?: Record<string, Expected>;
  origins: Record<string, { source: string; basedOn: string }>;
}
export async function loadCourseSources(sources: CourseSource[], files: Host["files"]): Promise<ResolvedCourse> {
  let resolved: ResolvedCourse | undefined;
  const replaced = new Set<string>();
  for (const source of sources) {
    if (source.kind === "bundled") {
      if (resolved) throw new RepaFault("ambiguous_course_source", "课程只能有一个明确的上游来源");
      const report = new Report();
      const loaded = await loadCourse(source.directory, report);
      if (!loaded || report.errorCount > 0) throw new RepaFault("invalid_course", "课程加载失败", report.diagnostics);
      let expected: Record<string, Expected> = {};
      try {
        expected = parse(
          Type.Record(Type.String(), ExpectedSchema),
          JSON.parse(await readFile(path.join(source.directory, "expected.json"), "utf8")),
        );
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
      resolved = {
        expected,
        course: loaded.course,
        topics: loaded.topics.map(({ topic }) => topic),
        origins: Object.fromEntries(
          loaded.topics.map(({ topic }) => [topic.id, { source: source.directory, basedOn: loaded.course.version }]),
        ),
      };
    } else {
      const overlay = parse(OverlaySchema, JSON.parse(await files.read(source.file)));
      if (!resolved || overlay.courseId !== resolved.course.id || overlay.basedOn !== resolved.course.version) {
        throw new RepaFault("course_version_conflict", "覆盖层必须指明匹配的课程上游版本");
      }
      const index = resolved.topics.findIndex((topic) => topic.id === overlay.topic.id);
      if (index < 0 || replaced.has(overlay.topic.id)) throw new RepaFault("ambiguous_course_source", "覆盖 topic 不存在或有多个覆盖来源");
      resolved.topics[index] = overlay.topic;
      resolved.origins[overlay.topic.id] = { source: source.file, basedOn: overlay.basedOn };
      replaced.add(overlay.topic.id);
    }
  }
  if (!resolved) throw new RepaFault("invalid_course", "缺少随包课程来源");
  for (const topic of resolved.topics) {
    for (const { question } of topicQuestions(topic)) {
      const expected = resolved.expected?.[question.id];
      const complete = question.slots.every((slot) =>
        slotTests(slot).every((test, index) => {
          const values = expected?.values[slot.id]?.[index];
          return values && Object.keys(test.expect ?? {}).every((expression) => expression in values);
        }),
      );
      if (
        !complete ||
        expected?.binding !== (await expectedBinding(question, topic, resolved.course.runtime))
      ) {
        delete resolved.expected?.[question.id];
      }
    }
  }
  return resolved;
}
