/**
 * 做课的记录与设置：哪些会话在做这门课（花费按它们汇总），最近一次后台展开，以及要不要自动展开。
 * 两份都是插件数据目录里的小 JSON，先写临时文件再改名。正在进行的展开只在内存里：应用关掉时它被取消，记录随之写明。
 */

import path from "node:path";
import { readFile } from "node:fs/promises";

import { writeJson } from "@repa/base";
import { identifier, object, parse } from "@repa/base/protocol";
import { Type, type Static } from "typebox";

import { COURSE_GUIDE } from "./course-tools.js";
import type { ResolvedCourse } from "./course-sources.js";
import { ExpansionFailureSchema, type LearningSettings } from "./protocol.js";
import { SPACE_COURSE } from "./space-course.js";

/** 数据目录里的做课记录。 */
export const BUILDING_FILE = "building.json";
/** 数据目录里的学习插件设置。 */
export const SETTINGS_FILE = "settings.json";

/** 后台展开每次展开几部分。写课说明里一段是一到两节；两节在学习者上完一节的时间里做得完，又不多花没学到的部分。Repa 的假设。 */
export const EXPANSION_SIZE = 2;

const time = Type.Integer({ minimum: 0 });
/**
 * building.json：sessions 是做过这门课的会话；last 是最近一次后台展开：要展开的部分、开始时学习者学过几个 topic（自动展开每个学过数只试一次）、
 * 会话、结束时间与没有成功的原因。没有 endedAt 就是上次应用关掉时它还在进行。
 */
export const BuildingRecordSchema = object({
  sessions: Type.Array(identifier),
  last: Type.Optional(object({
    topicIds: Type.Array(identifier),
    learned: Type.Integer({ minimum: 0 }),
    startedAt: time,
    sessionId: Type.Optional(identifier),
    endedAt: Type.Optional(time),
    failure: Type.Optional(object({ code: ExpansionFailureSchema.properties.code, message: Type.Optional(Type.String()) })),
  })),
});
/** 做课记录。 */
export type BuildingRecord = Static<typeof BuildingRecordSchema>;
/** settings.json：学习插件的设置。缺省自动展开。 */
export const SettingsFileSchema = object({ autoExpand: Type.Boolean() });

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** 读出做课记录与设置；没有文件时是空记录与缺省设置。 */
export async function openBuilding(dataDir: string): Promise<{ record: BuildingRecord; settings: LearningSettings }> {
  const record = await readJson(path.join(dataDir, BUILDING_FILE));
  const settings = await readJson(path.join(dataDir, SETTINGS_FILE));
  return {
    record: record === undefined ? { sessions: [] } : parse(BuildingRecordSchema, record),
    settings: settings === undefined ? { autoExpand: true } : parse(SettingsFileSchema, settings),
  };
}

export function saveRecord(dataDir: string, record: BuildingRecord): Promise<void> {
  return writeJson(path.join(dataDir, BUILDING_FILE), record);
}

export function saveSettings(dataDir: string, settings: LearningSettings): Promise<void> {
  return writeJson(path.join(dataDir, SETTINGS_FILE), settings);
}

/** 课里还是轮廓的部分，按课程清单的顺序。 */
export function outlineTopics(course: ResolvedCourse): string[] {
  return course.course.topics.filter((id) => course.topics.find((topic) => topic.id === id)?.status === "outline");
}

/** 课里已经展开的部分。 */
export function completeTopics(course: ResolvedCourse): string[] {
  return course.topics.filter((topic) => topic.status === "complete").map((topic) => topic.id);
}

/**
 * 交给后台通用 Agent 的任务。它没有连接可以回答提问或确认命令，所以写明只用文件、课件与做课的工具；
 * 学过的部分写出来，让它知道哪些不能推倒。具体做法在写课说明的“后台展开”一节。
 */
export function expansionTask(course: ResolvedCourse, topicIds: readonly string[], learned: readonly string[]): string {
  const name = (id: string) => `${id}「${course.topics.find((topic) => topic.id === id)?.title ?? id}」`;
  return [
    `在后台展开空间里 ${SPACE_COURSE}/ 这门课的这几部分：${topicIds.map(name).join("、")}。`,
    `学习者学过的部分：${learned.length > 0 ? learned.map(name).join("、") : "还没有"}。`,
    `先用 read 读 ${COURSE_GUIDE} 的“后台展开”一节，照着做，最后用 course_use 换用。`,
    "这是后台运行：没有人回答提问，也没有人能确认命令，不要用 bash 和 ask_user。",
  ].join("\n");
}
