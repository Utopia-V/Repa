import { RepaFault } from "@repa/base";
import type { Host } from "@repa/base/plugin";
import { identifier, object, parse } from "@repa/base/protocol";
import { loadCourse } from "./format/load.js";
import { Report } from "./format/diagnostics.js";
import { TopicSchema, type Topic } from "./format/schema.js";

const OverlaySchema = object({ courseId: identifier, basedOn: identifier, topic: TopicSchema });
/** 课程来源：随包课程的目录，或替换单个 topic 的覆盖文件（经 host.files 读取）。 */
export type CourseSource = { kind: "bundled"; directory: string } | { kind: "overlay"; file: string };
/** 合并来源以后的课程：清单、各 topic，以及每个 topic 取自哪个来源、基于哪个课程版本。 */
export interface ResolvedCourse {
  course: NonNullable<Awaited<ReturnType<typeof loadCourse>>>["course"];
  topics: Topic[];
  origins: Record<string, { source: string; basedOn: string }>;
}
/** 按顺序合并课程来源：先读唯一的随包课程，再用覆盖文件逐个替换同 id 的 topic。覆盖文件必须指明相同的课程 id 和上游版本，否则报错。 */
export async function loadCourseSources(sources: CourseSource[], files: Host["files"]): Promise<ResolvedCourse> {
  let resolved: ResolvedCourse | undefined;
  const replaced = new Set<string>();
  for (const source of sources) {
    if (source.kind === "bundled") {
      if (resolved) throw new RepaFault("ambiguous_course_source", "课程只能有一个明确的上游来源");
      const report = new Report();
      const loaded = await loadCourse(source.directory, report);
      if (!loaded || report.errorCount > 0) throw new RepaFault("invalid_course", "课程加载失败", report.diagnostics);
      resolved = {
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
  return resolved;
}
