import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { checkSchema, displayPath, parseYamlFile, Report, SourceFile } from "./diagnostics.js";
import { CourseSchema, TopicSchema, type Course, type Topic } from "./schema.js";

/** 一个通过 schema 的 topic 及其源文件；源文件保留语法树，问题可以定位到行列。 */
export interface LoadedTopic {
  topic: Topic;
  file: SourceFile;
}

/** loadCourse 读出的课程：清单、清单的源文件，以及读出的 topic。 */
export interface LoadedCourse {
  root: string;
  course: Course;
  file: SourceFile;
  /** 按清单顺序排列，只含成功读出并通过 schema 的 topic。 */
  topics: LoadedTopic[];
}

export const COURSE_FILE = "course.yaml";
export const TOPICS_DIRECTORY = "topics";

async function readSource(file: string, base: string, report: Report, missingCode: string, missingMessage: string): Promise<SourceFile | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    // 只有文件不存在算作内容问题；权限、损坏等读取失败照常抛出。
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    report.diagnostics.push({ severity: "error", code: missingCode, message: missingMessage, file: displayPath(base, file) });
    return undefined;
  }
  return new SourceFile(file, displayPath(base, file), text);
}

/**
 * 读取一门课程：course.yaml 加 topics/ 下每个 topic 一个 YAML 文件。
 * 发现的问题都记在 report 里；清单本身读不出或不合格式时返回 undefined。base 决定问题里显示的相对路径。
 */
export async function loadCourse(root: string, report: Report, base = process.cwd()): Promise<LoadedCourse | undefined> {
  const courseFile = await readSource(path.join(root, COURSE_FILE), base, report, "course_missing", `找不到课程清单 ${COURSE_FILE}`);
  if (!courseFile) return undefined;
  const courseValue = parseYamlFile(courseFile, report);
  if (courseValue === undefined || !checkSchema(CourseSchema, courseValue, courseFile, report)) return undefined;
  const course = courseValue as Course;

  const topics: LoadedTopic[] = [];
  const listed = new Set<string>();
  for (const [index, id] of course.topics.entries()) {
    if (listed.has(id)) {
      report.error("duplicate_topic", `topic ${id} 在清单里出现了两次`, courseFile, ["topics", index]);
      continue;
    }
    listed.add(id);
    const file = await readSource(
      path.join(root, TOPICS_DIRECTORY, `${id}.yaml`), base, report,
      "topic_missing", `清单列出了 ${id}，但找不到 ${TOPICS_DIRECTORY}/${id}.yaml`,
    );
    if (!file) continue;
    const value = parseYamlFile(file, report);
    if (value === undefined || !checkSchema(TopicSchema, value, file, report)) continue;
    const topic = value as Topic;
    if (topic.id !== id) {
      report.error("topic_id_mismatch", `文件名是 ${id}.yaml，但 id 写的是 ${topic.id}`, file, ["id"]);
      continue;
    }
    topics.push({ topic, file });
  }

  let entries: string[] = [];
  try {
    entries = await readdir(path.join(root, TOPICS_DIRECTORY));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".yaml")) continue;
    if (!listed.has(entry.slice(0, -".yaml".length))) {
      report.diagnostics.push({
        severity: "error", code: "topic_unlisted",
        message: `${entry} 不在课程清单里；新增 topic 时把 id 加进 ${COURSE_FILE} 的 topics`,
        file: displayPath(base, path.join(root, TOPICS_DIRECTORY, entry)),
      });
    }
  }
  return { root, course, file: courseFile, topics };
}
