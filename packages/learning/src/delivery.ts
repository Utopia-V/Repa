import { randomUUID } from "node:crypto";
import type { Answer, Item } from "@repa/base/protocol";
import { publicItem, slotTests } from "./check/items.js";
import type { Question, Topic } from "./format/schema.js";
import type { Delivery } from "./protocol.js";

export const opaqueId = () => randomUUID();
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const other = seed % (index + 1);
    [result[index], result[other]] = [result[other] as T, result[index] as T];
  }
  return result;
}
export async function deliver(
  question: Question,
  topic: Topic,
  kpId: string,
  mode: Delivery["mode"],
  repeated: boolean,
  seed: number,
) {
  const item = await publicItem(question, topic);
  const idMap: Record<string, string> = {};
  function rename(id: string): string {
    const opaque = opaqueId();
    idMap[opaque] = id;
    return opaque;
  }
  item.id = rename(item.id);
  for (const slot of item.slots) {
    if (slot.type === "choice") {
      slot.options = shuffled(
        slot.options.map((option) => ({ ...option, id: rename(option.id) })),
        seed++,
      );
    }
    if (slot.type === "order") {
      slot.items = shuffled(
        slot.items.map((block) => ({ ...block, id: rename(block.id) })),
        seed++,
      );
    }
    if (slot.type === "table") {
      for (const row of slot.rows) {
        for (const cell of Object.values(row.cells)) {
          if ("input" in cell && cell.input.type === "choice") {
            cell.input.options = shuffled(
              cell.input.options.map((option) => ({ ...option, id: rename(option.id) })),
              seed++,
            );
          }
        }
      }
    }
  }
  const delivery: Delivery = {
    deliveryId: opaqueId(),
    submissionId: opaqueId(),
    item,
    topicId: topic.id,
    kpId,
    mode,
    repeated,
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
