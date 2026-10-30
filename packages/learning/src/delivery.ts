import { createHash, randomInt } from "node:crypto";
import type { Answer, Item } from "@repa/base/protocol";
import { publicItem, slotTests } from "./check/items.js";
import type { Question, Topic } from "./format/schema.js";
import type { Delivery } from "./protocol.js";

/** 按 seed 打乱，同一个 seed 得到同样的顺序。 */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const other = seed % (index + 1);
    [result[index], result[other]] = [result[other] as T, result[index] as T];
  }
  return result;
}

/** 每次交付从系统熵取一个 seed，记进交付事实；不从公开编号推导。 */
export function deliverySeed(): number {
  return randomInt(0, 0x1_0000_0000);
}

function digest(seed: number, ...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify([seed, ...parts])).digest("hex");
}

/**
 * 按交付的 seed 把题目投影成学习者看到的样子：题目、选项、排列块和选择格换成不透明编号并打乱顺序，数据行保持原样。
 * 同一 seed 每次得到同样的结果，所以重开以后画面不变，作答也能换回课程里的编号；seed 只在后端，前端推不出原编号。
 */
export async function renderDelivery(
  question: Question,
  topic: Topic,
  kpId: string,
  mode: Delivery["mode"],
  identity: { deliveryId: string; submissionId: string; repeated: boolean },
  seed: number,
): Promise<{ delivery: Delivery; idMap: Record<string, string> }> {
  const item = await publicItem(question, topic);
  const idMap: Record<string, string> = {};
  const rename = (scope: string, id: string): string => {
    const opaque = `o${digest(seed, scope, id).slice(0, 16)}`;
    idMap[opaque] = id;
    return opaque;
  };
  const order = <T>(scope: string, items: readonly T[]) => shuffled(items, Number.parseInt(digest(seed, scope, "order").slice(0, 8), 16));
  item.id = rename("item", item.id);
  for (const slot of item.slots) {
    if (slot.type === "choice") {
      slot.options = order(slot.id, slot.options.map((option) => ({ ...option, id: rename(slot.id, option.id) })));
    }
    if (slot.type === "order") {
      slot.items = order(slot.id, slot.items.map((block) => ({ ...block, id: rename(slot.id, block.id) })));
    }
    if (slot.type === "table") {
      for (const row of slot.rows) {
        for (const [columnId, cell] of Object.entries(row.cells)) {
          if ("input" in cell && cell.input.type === "choice") {
            const scope = `${slot.id}/${row.id}/${columnId}`;
            cell.input.options = order(scope, cell.input.options.map((option) => ({ ...option, id: rename(scope, option.id) })));
          }
        }
      }
    }
  }
  const delivery: Delivery = {
    deliveryId: identity.deliveryId,
    submissionId: identity.submissionId,
    item,
    topicId: topic.id,
    kpId,
    mode,
    repeated: identity.repeated,
    requiresServices: question.slots.some((slot) => slotTests(slot).length > 0) ? ["python.run"] : [],
  };
  return { delivery, idMap };
}

/** id 只在对应作答位的选项内反向查找；不同选择格可以使用同名作者 id。 */
export function mapAnswer(
  answer: Answer,
  slot: Item["slots"][number],
  idMap: Record<string, string>,
  outward = false,
): Answer {
  const translate = (id: string, ids: string[]) =>
    outward ? ids.find((opaque) => idMap[opaque] === id) ?? id : idMap[id] ?? id;
  if (answer.type === "choice" && slot.type === "choice") {
    return {
      ...answer,
      selected: answer.selected.map((id) =>
        translate(
          id,
          slot.options.map((option) => option.id),
        ),
      ),
    };
  }
  if (answer.type === "order" && slot.type === "order") {
    return {
      ...answer,
      items: answer.items.map((id) =>
        translate(
          id,
          slot.items.map((block) => block.id),
        ),
      ),
    };
  }
  if (answer.type === "table" && slot.type === "table") {
    return {
      ...answer,
      cells: Object.fromEntries(
        Object.entries(answer.cells).map(([rowId, cells]) => [
          rowId,
          Object.fromEntries(
            Object.entries(cells).map(([columnId, cellAnswer]) => {
              const cell = slot.rows.find((row) => row.id === rowId)?.cells[columnId];
              if (cellAnswer.type !== "choice" || !cell || !("input" in cell) || cell.input.type !== "choice") {
                return [columnId, cellAnswer];
              }
              return [
                columnId,
                {
                  ...cellAnswer,
                  selected: cellAnswer.selected.map((id) =>
                    translate(id, cell.input.type === "choice" ? cell.input.options.map((option) => option.id) : []),
                  ),
                },
              ];
            }),
          ),
        ]),
      ),
    };
  }
  return answer;
}
