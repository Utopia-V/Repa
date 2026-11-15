/**
 * 展开课程时交给模型的内容：要展开的几部分的轮廓，和学习者在它们之前已经学到的概念。
 * 由程序从换用的那一版课程和学过的部分现算，不存。后台展开的任务和做课对话里的 course_brief 用同一份。
 * 近处给细节、远处给摘要：直接先修列出概念名和一句话定义，更早的部分只列概念名，超过上限的只给个数和怎样取。
 */
import type { ResolvedCourse } from "./course-sources.js";
import type { Kp, Topic } from "./format/schema.js";
import { SPACE_COURSE } from "./space-course.js";

/**
 * 更早的部分最多列多少个概念名，按先修图上离要展开的部分由近到远取整个部分。四十多节、每节三个知识点的课学到第三十节时
 * 约八十个，都列得下；更长的课只列近处的。Repa 的假设：一百个名称约 1,500 字，模型读得完，又不让清单随课无限增长。
 */
export const EARLIER_CONCEPTS = 100;

function named(topic: Topic): string {
  return `${topic.id}「${topic.title}」`;
}

/** 知识点的概念名：概念卡的名称，没有概念卡时用知识点的标题。 */
function conceptName(kp: Kp): string {
  return kp.card?.name ?? kp.title;
}

/** 出处：材料的标题、文件或网址，和在其中的位置。 */
function sourcesLine(course: ResolvedCourse, topic: Topic): string {
  if (topic.sources.length === 0) return "出处：没有登记";
  return `出处：${topic.sources.map((use) => {
    const source = course.course.sources[use.source];
    const address = source?.file ?? use.url ?? source?.url;
    return `「${source?.title ?? use.source}」${address === undefined ? "" : `（${address}）`}${use.where}`;
  }).join("；")}`;
}

/** 要展开的一部分：名称、范围、出处、直接先修和轮廓里估计的知识点。 */
function partText(course: ResolvedCourse, topic: Topic, parts: ReadonlySet<string>, topics: ReadonlyMap<string, Topic>): string {
  const prerequisites = topic.prerequisites.map((id) => {
    const prerequisite = topics.get(id);
    const name = prerequisite ? named(prerequisite) : id;
    return parts.has(id) ? `${name}（这次一起展开，先写它）` : name;
  });
  return [
    named(topic),
    ...(topic.summary === undefined ? [] : [`范围：${topic.summary}`]),
    sourcesLine(course, topic),
    `直接先修：${prerequisites.length > 0 ? prerequisites.join("、") : "没有"}`,
    `估计的知识点：${topic.kps.map((kp) => `${kp.id} ${kp.title}`).join("；")}`,
  ].join("\n");
}

/** 直接先修里一个展开了的部分：每个知识点的编号、概念名、别名和一句话定义。 */
function detailedText(topic: Topic): string {
  return [`直接先修 ${named(topic)}：`, ...topic.kps.map((kp) => {
    const aliases = kp.card?.aliases?.length ? `（又称${kp.card.aliases.join("、")}）` : "";
    const definition = kp.card === undefined ? "" : `：${kp.card.definition}`;
    return `- ${kp.id} ${conceptName(kp)}${aliases}${definition}`;
  })].join("\n");
}

/**
 * 要展开的这几部分的轮廓，和学习者在它们之前学到的概念。topicIds 是要展开的部分，learned 是学习者学过的 topic。
 * “之前”指先修图上的祖先（学习者学这几部分之前一定学过）和已经学过的部分；展开了但既不是祖先也没学过的，学习者未必见过，不列。
 */
export function expansionBrief(course: ResolvedCourse, topicIds: readonly string[], learned: ReadonlySet<string>): string {
  const topics = new Map(course.topics.map((topic) => [topic.id, topic]));
  const order = new Map(course.course.topics.map((id, index) => [id, index]));
  const parts = new Set(topicIds);
  // 先修图上离要展开的部分有几步：1 是直接先修。
  const distance = new Map<string, number>();
  let frontier = [...topicIds];
  for (let step = 1; frontier.length > 0; step++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const prerequisite of topics.get(id)?.prerequisites ?? []) {
        if (parts.has(prerequisite) || distance.has(prerequisite)) continue;
        distance.set(prerequisite, step);
        next.push(prerequisite);
      }
    }
    frontier = next;
  }
  const byOrder = (left: Topic, right: Topic) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0);
  const direct = [...distance].filter(([, step]) => step === 1).flatMap(([id]) => topics.get(id) ?? []).sort(byOrder);
  const earlier = course.topics.filter((topic) => topic.status === "complete" && !parts.has(topic.id)
    && (distance.get(topic.id) ?? 0) !== 1 && (distance.has(topic.id) || learned.has(topic.id)));
  // 由近到远：先修图上步数少的在前，不是祖先的学过的部分在后；同样远的，课程清单里靠后（离这几部分近）的在前。
  earlier.sort((left, right) => (distance.get(left.id) ?? Infinity) - (distance.get(right.id) ?? Infinity) || byOrder(right, left));
  const listed: Topic[] = [];
  let names = 0;
  for (const topic of earlier) {
    if (names + topic.kps.length > EARLIER_CONCEPTS) break;
    listed.push(topic);
    names += topic.kps.length;
  }
  const omitted = earlier.slice(listed.length);

  const sections = [
    "## 要展开的部分",
    ...topicIds.flatMap((id) => {
      const topic = topics.get(id);
      return topic ? [partText(course, topic, parts, topics)] : [];
    }),
    "## 学习者在这之前学到的概念",
  ];
  const complete = direct.filter((topic) => topic.status === "complete");
  const outline = direct.filter((topic) => topic.status !== "complete");
  if (complete.length === 0 && listed.length === 0 && omitted.length === 0) {
    sections.push("学习者在这几部分之前还没有学过任何概念：术语第一次出现时都要先用一句话说清。");
  } else {
    sections.push("下面的概念学习者已经学过，或者在这几部分之前会学到：讲解里可以直接用，提到时可以写成 repa:concept/<知识点编号> 链接。"
      + "不在下面的术语，第一次出现时先用一句话说清，或者不用。");
    sections.push(...complete.map(detailedText));
    if (listed.length > 0) {
      sections.push(["更早的部分，只列概念名：", ...listed.sort(byOrder).map((topic) => `- ${named(topic)}：${topic.kps.map(conceptName).join("、")}`)].join("\n"));
    }
    if (omitted.length > 0) {
      const count = omitted.reduce((sum, topic) => sum + topic.kps.length, 0);
      sections.push(`另有 ${omitted.length} 个更早的部分（共 ${count} 个概念）没有列出；要查时用 grep 在 ${SPACE_COURSE}/topics/ 里搜概念名（概念卡的 name）。`);
    }
  }
  if (outline.length > 0) {
    sections.push(`还没有展开的直接先修：${outline.map(named).join("、")}。它们讲什么还没有写定，学习者也还没有学过。`);
  }
  return sections.join("\n\n");
}
