/** 经真实插件宿主上课的夹具：临时课程与空间、可拨的时钟，并取回学习会话以便核对事实与重放结果。 */
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { createSpace, openPluginHost, openSpace } from "@repa/base";
import type { Services } from "@repa/base/plugin";
import { ModelTestDriver } from "@repa/base/testing";
import { INTERACTION_CAPABILITIES, parse, type ClientCapabilities } from "@repa/base/protocol";
import { stringify } from "yaml";
import { referenceResponse } from "../../src/check/items.js";
import { mapAnswer } from "../../src/delivery.js";
import { connectLearning } from "../../src/flow.js";
import type { Course, Question, Topic } from "../../src/format/schema.js";
import { createLearningPlugin } from "../../src/plugin.js";
import {
  learningMethods,
  type Delivery,
  type LearnerResponse,
  type LearningInput,
  type LearningMethod,
  type LearningResult,
} from "../../src/protocol.js";
import type { LearningSession } from "../../src/session.js";

export const start = 1_792_454_400_000;
export const clientCapabilities: ClientCapabilities = {
  interaction: { supports: [...INTERACTION_CAPABILITIES] },
  services: ["python.run"],
};
export const course: Course = {
  id: "test",
  title: "测试",
  version: "1.0.0",
  language: "zh-CN",
  license: "Apache-2.0",
  runtime: { pyodide: "314.0.7", python: "3.14.2", packages: {} },
  sources: {},
  topics: [],
};

/** 每个知识点一道例题、一道练习、一道复习题，标准答案都是 2。 */
export function topic(id = "t01", count = 1, prerequisites: string[] = []): Topic {
  return {
    id,
    title: id,
    status: "complete",
    minutes: 5,
    prerequisites,
    sources: [],
    kps: Array.from({ length: count }, (_, index) => {
      const kpId = `${id}.k${index + 1}`;
      const question: Question = {
        id: `${kpId}.q1`,
        body: "一加一？",
        explanation: "二。",
        slots: [{ id: "answer", type: "text", key: "2" }],
      };
      return {
        id: kpId,
        title: kpId,
        lesson: "讲解",
        example: { ...question, id: `${kpId}.e1` },
        practice: [question],
        review: [{ ...question, id: `${kpId}.r1` }],
      };
    }),
  };
}

/** 交付的事实序号就是公开编号去掉前缀。 */
export const deliverySeq = (delivery: Delivery) => Number(delivery.deliveryId.slice(1));

/** 用课程里的标准答案作答，选项等换成这次交付的编号。 */
export async function referenceAnswer(session: LearningSession, delivery: Delivery): Promise<LearnerResponse> {
  const record = session.replay.delivery(deliverySeq(delivery));
  const entry = record && session.course.questions.get(record.questionId);
  assert.ok(record && entry);
  const { idMap } = await session.render(record);
  const response = referenceResponse(entry.question, delivery.item);
  for (const slot of delivery.item.slots) {
    const answer = response.answers[slot.id];
    if (answer) {
      response.answers[slot.id] = mapAnswer(answer, slot, idMap, true);
    }
  }
  return response;
}

async function writeCourse(directory: string, topics: Topic[]) {
  await mkdir(path.join(directory, "topics"), { recursive: true });
  await writeFile(path.join(directory, "course.yaml"), stringify({ ...course, topics: topics.map((entry) => entry.id) }));
  for (const entry of topics) {
    await writeFile(path.join(directory, "topics", `${entry.id}.yaml`), stringify(entry, { aliasDuplicateObjects: false }));
  }
}

export interface FixtureOptions {
  bundled?: boolean;
  services?: Services;
  beforeRestricted?: () => Promise<void>;
}

export async function learningFixture(t: TestContext, topics = [topic()], options: FixtureOptions = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-learning-flow-")));
  const directory = path.join(root, "course");
  await writeCourse(directory, topics);
  let now = start;
  let session: LearningSession | undefined;
  const models = new ModelTestDriver();
  const events: unknown[] = [];
  const plugin = createLearningPlugin({
    sources: [{ kind: "bundled", directory: options.bundled ? fileURLToPath(new URL("../../courses/python", import.meta.url)) : directory }],
    now: () => now,
    connect: async (opened) => {
      session = opened;
      return connectLearning(opened, options.beforeRestricted ? { beforeRestricted: options.beforeRestricted } : {});
    },
  });
  const open = async (space: Awaited<ReturnType<typeof createSpace>>) => openPluginHost({
    space,
    plugins: [plugin],
    models,
    ...(options.services ? { services: options.services } : {}),
    emit: (_id, event) => events.push(event),
    onError: (error) => {
      throw error;
    },
  });
  let space = await createSpace(path.join(root, "space"), { watch: false });
  let host = await open(space);
  t.after(async () => {
    await host.close();
    await space.close();
    await rm(root, { recursive: true, force: true });
  });
  // 与生产一致：声明 python.run 的前端也提供这项服务；测试没有给 Python 服务时，前端不声明它。
  const declared: ClientCapabilities = options.services ? clientCapabilities : { ...clientCapabilities, services: [] };
  const call = async <M extends LearningMethod>(
    method: M,
    input: LearningInput<M>,
    capabilities = declared,
  ): Promise<LearningResult<M>> =>
    // 与生产处理器一致先检查返回值，再在测试边界恢复方法泛型。
    parse(learningMethods[method].result, await host.call("learning", method, input, { capabilities })) as LearningResult<M>;
  const state = () => call("state.get", {});
  const learning = () => {
    assert.ok(session);
    return session;
  };
  async function advance() {
    const current = await state();
    const task = current.task;
    assert.ok(task);
    return call("task.advance", { taskId: task.taskId, expectedRevision: current.revision, expectedStage: task.phase.stage });
  }
  async function select(id?: string, kind?: "lesson" | "review") {
    const current = await state();
    const candidate = current.menu?.candidates.find(
      (entry) => (!id || entry.topicIds[0] === id) && (!kind || entry.kind === kind),
    );
    assert.ok(candidate, JSON.stringify(current.menu));
    assert.ok(current.menu);
    return call("menu.select", { menuId: current.menu.menuId, candidateId: candidate.id });
  }
  async function input(correct = true) {
    const current = await state();
    const task = current.task;
    assert.ok(task);
    assert.equal(task.phase.stage, "awaiting_answer");
    const delivery = task.deliveries.find((entry) => task.phase.stage === "awaiting_answer" && entry.deliveryId === task.phase.deliveryId);
    assert.ok(delivery);
    const response = await referenceAnswer(learning(), delivery);
    return {
      taskId: task.taskId,
      deliveryId: delivery.deliveryId,
      submissionId: delivery.submissionId,
      response: correct ? response : { item: response.item, answers: {}, dontKnow: true as const },
    };
  }
  const submit = async (correct = true) => call("submission.submit", await input(correct));
  async function finishLesson(pattern: boolean[] = [true, true]) {
    let current = await state();
    let index = 0;
    while (current.task && !["completed", "aborted"].includes(current.task.phase.stage)) {
      if (current.task.phase.stage === "awaiting_answer") {
        await submit(pattern[index++ % pattern.length] ?? true);
      } else {
        await advance();
      }
      current = await state();
      assert.ok(index < 50);
    }
    return current;
  }
  return {
    root,
    directory,
    models,
    events,
    call,
    state,
    select,
    advance,
    submit,
    input,
    finishLesson,
    session: learning,
    /** 包括已结束的当前任务在内的学习状态，先按当前时间结算截止。 */
    async fold() {
      await learning().view();
      return learning().replay.fold();
    },
    student: async () => (await learning().view()).student,
    time: (value: number) => {
      now = value;
    },
    /** 改写课程里的 topic；重开空间后生效。 */
    writeTopics: (changed: Topic[]) => writeCourse(directory, changed),
    async reopen() {
      await host.close();
      await space.close();
      space = await openSpace(path.join(root, "space"), { watch: false });
      host = await open(space);
    },
    /** 新建一个空间，只把学习记录和格式标记搬过去，再在那里打开；返回搬过去的文件名。 */
    async relocate() {
      const source = await space.pluginDataDir("learning");
      await host.close();
      await space.close();
      space = await createSpace(path.join(root, `space-${Date.now()}`), { watch: false });
      const target = await space.pluginDataDir("learning");
      const files = ["format.json", "records.jsonl"];
      for (const file of files) {
        await copyFile(path.join(source, file), path.join(target, file));
      }
      host = await open(space);
      return files;
    },
    /** 等后台补判结束。 */
    async settled() {
      await learning().idle();
    },
  };
}
