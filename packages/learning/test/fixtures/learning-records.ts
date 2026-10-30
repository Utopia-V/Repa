/** 不经底座、直接打开学习记录和学习会话的夹具：子进程和父进程都用它在同一个日志文件上上课。 */
import type { KnowledgeGraph } from "@repa/learning-model";
import type { Host, PluginMethod } from "@repa/base/plugin";
import { INTERACTION_CAPABILITIES } from "@repa/base/protocol";
import type { ModelTestDriver } from "@repa/base/testing";
import { loadCourseSources } from "../../src/course-sources.js";
import { connectLearning } from "../../src/flow.js";
import type { Course, Topic } from "../../src/format/schema.js";
import type { LearningInput, LearningMethod } from "../../src/protocol.js";
import { LearningRecords } from "../../src/records.js";
import { LearningSession } from "../../src/session.js";
import { now } from "./learning-contract.js";

export const course: Course = {
  id: "python", version: "0.1.0", title: "Python", language: "zh-CN", license: "Apache-2.0",
  runtime: { pyodide: "314.0.7", python: "3.14.2", packages: {} }, sources: {}, topics: ["py01"],
};
/** 一个知识点，练习是一道开放题，判分要调用模型。 */
export const topic: Topic = {
  id: "py01", title: "数字", status: "complete", minutes: 5, prerequisites: [], sources: [],
  kps: [{
    id: "py01.k1", title: "加法", lesson: "讲解",
    practice: [{
      id: "py01.k1.q1", body: "说说 1 + 1 为什么等于 2。", explanation: "两个一。",
      slots: [{ id: "s1", type: "text", rubric: [{ id: "meaning", label: "说明相加的含义" }] }],
    }],
  }],
};
export const graph: KnowledgeGraph = { topics: ["py01", "py02"], prerequisites: [], encompassings: [{ advanced: "py02", simple: "py01", weight: 1 }] };
export const clock = () => now + 20_000;

/** 打开日志与学习会话；宿主只有模型和事件，前端服务不可用。 */
export async function openSession(file: string, directory: string, models: ModelTestDriver) {
  const resolved = await loadCourseSources([{ kind: "bundled", directory }], { read: async () => "", write: async () => {}, list: async () => [] });
  const records = await LearningRecords.open(file, clock);
  // 会话只用到模型、前端服务和事件；其余宿主能力在这里用不到。
  const host = {
    now: clock,
    models,
    services: { call: async () => { throw new Error("没有前端服务"); } },
    emit: () => {},
  } as unknown as Host;
  const session = await LearningSession.open(records, resolved, host, clock);
  const { methods } = await connectLearning(session);
  const caller = { capabilities: { interaction: { supports: [...INTERACTION_CAPABILITIES] }, services: [] } };
  async function call<M extends LearningMethod>(name: M, input: LearningInput<M>): Promise<unknown> {
    const method: PluginMethod | undefined = methods?.[name];
    if (!method) throw new Error(`缺少方法 ${name}`);
    return method.invoke(input, { caller });
  }
  return { records, session, call };
}
